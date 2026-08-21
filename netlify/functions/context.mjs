// Authenticated, read-only API over canonical atomized PostgreSQL records.
import {
  costGuardHeaders,
  masterKillSwitchEngaged,
  noteCostBreakerBlock,
  REASON_COST_BREAKER_DISABLED_PATH,
} from './_cost-breaker.mjs';

async function loadAuth() { return await import('./_auth.mjs'); }
async function loadSafety() { return await import('../../scripts/safety/chain-safety.mjs'); }

// The scanner reads safety off the market row (`row.safetyStatus`), but the
// canonical rows are raw atoms and carried none — so the safety column was blank
// for every coin even though the classifier resolves them perfectly well from the
// listing axis alone. Classification is pure and I/O-free, so it is done here
// once per read rather than pushed into the DB layer or duplicated in the browser.
function withSafety(tickers, classifyMarketSafety) {
  return tickers.map((row) => {
    try {
      const safety = classifyMarketSafety({
        symbol: row.symbol, baseAsset: row.base_asset, quoteAsset: row.quote_asset,
        status: 'TRADING', exchange: 'binance', binanceListed: true,
        quoteVolume: Number(row.quote_volume),
      });
      return {
        ...row,
        safety_status: safety.safetyStatus, safety_reason: safety.safetyReason,
        safety_basis: safety.safetyBasis, safety_source: safety.source,
        listing_safety_status: safety.listingSafetyStatus,
      };
    } catch { return row; }
  });
}
async function loadStore() { return await import('./_market-context-store.mjs'); }
async function loadDb() { return await import('./_db.mjs'); }

// ── Read memo (database-compute cost control) ───────────────────────────────
//
// WHY: one /api/context read costs FOUR Postgres queries and returns up to
// 2,000 ticker + 600 microstructure rows. Every open terminal tab drives this
// on a timer, so N tabs × the poll cadence became a permanent Postgres load
// that never let the database idle — the single largest Netlify database-
// compute drain.
//
// WHY THIS IS SAFE: the read takes NO identity input — it is the same global
// published market run for every caller — and the publishing collector only
// writes a new run every three minutes. Authentication is still enforced on
// every request before the memo is consulted, so this weakens no auth: an
// unauthenticated caller never reaches this code.
//
// HONESTY: `freshness` is a function of wall-clock age, so it is RECOMPUTED on
// every serve rather than replayed from the memo. A memoized response can
// therefore never claim FRESH once the underlying run has actually aged out.
// Only successful reads are memoized; a DB failure is never cached and never
// masked by a previous good response.
export const CONTEXT_CACHE_ENV_FLAG = 'CONTEXT_READ_CACHE_MS';
// EMERGENCY DEFAULT: 180s, not 30s. The publishing collector writes a new run
// at most every three minutes, so a memo shorter than that spends extra
// Postgres round trips on a run that provably cannot have changed. `freshness`
// is still recomputed per serve (see refreshFreshness), so a longer memo can
// never make a stale run claim to be FRESH. 6x fewer database reads per open
// tab, no data missed.
export const CONTEXT_CACHE_DEFAULT_MS = 180_000;
// Matches the store's own FRESH/STALE boundary in getAtomizedMarketContext.
const FRESHNESS_MAX_AGE_MS = 6 * 60 * 1000;

// ── HARD EXPIRY — the endpoint stops calling an old run "canonical" ──────────
//
// ROOT CAUSE this closes: the store asks for "the newest PUBLISHED run" with no
// age predicate, and `freshness` above is a LABEL computed after the read, not a
// gate. While MARKET_CONTEXT_COLLECT_ENABLED is false (the emergency cost
// breaker — deliberate, see docs/netlify-cost-breaker.md) nothing publishes a
// new run, so the last one before the breaker was engaged was served, with a
// 200 and a full body, for 28 hours and counting. The browser refusing it is a
// second line of defence; the endpoint must not offer it in the first place.
//
// Past this budget the response carries NO rows — only a named reason and
// non-secret age diagnostics. Sized to match the browser's own hard ceiling
// (HARD_MAX_MARKET_AGE_MS in js/freshness-badge.js) so client and server draw
// the line in the same place.
export const CONTEXT_HARD_MAX_AGE_MS = 30 * 60 * 1000;
export const REASON_STALE_EXPIRED = 'STALE_EXPIRED';
// Ceiling: never memoize longer than the collector's publish interval, or the
// terminal could sit on a run after a newer one exists.
const CONTEXT_CACHE_MAX_MS = 180_000;

export function contextCacheMs(env = process.env) {
  const raw = env?.[CONTEXT_CACHE_ENV_FLAG];
  // Unset/blank takes the default. Reject before Number() so '' does not become 0.
  if (raw === undefined || raw === null || String(raw).trim() === '') return CONTEXT_CACHE_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return CONTEXT_CACHE_DEFAULT_MS;
  return Math.min(n, CONTEXT_CACHE_MAX_MS);
}

// Recomputes the wall-clock-derived freshness label so a memoized body never
// reports a staleness it no longer has. Mutates and returns the same object.
export function refreshFreshness(context, now = Date.now()) {
  const market = context?.market;
  if (!market) return context;
  const observedMs = market.observedAt ? Date.parse(market.observedAt) : NaN;
  const ageMs = now - observedMs;
  market.freshness = !Number.isFinite(ageMs) ? 'MISSING' : ageMs <= FRESHNESS_MAX_AGE_MS ? 'FRESH' : 'STALE';
  return context;
}

// Counters for the DB-backed read, so the cost of this path is observable
// instead of inferred from a billing page.
export const contextReadStats = { dbReads: 0, memoHits: 0, coalesced: 0, failures: 0 };

let _memo = null;          // { context, storedAt }
let _inFlight = null;      // shared promise for concurrent cold reads

// Test-only reset so one test's memo cannot leak into the next.
export function resetContextCacheForTests() {
  _memo = null; _inFlight = null;
  contextReadStats.dbReads = 0; contextReadStats.memoHits = 0;
  contextReadStats.coalesced = 0; contextReadStats.failures = 0;
}

function headers(req, cacheState) { return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Context-Cache': cacheState || 'bypass', 'Vary': 'Origin, Authorization', 'Access-Control-Allow-Origin': req.headers.get('origin') || '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept', 'Access-Control-Expose-Headers': 'X-Context-Cache, X-Context-Stale, X-Context-Age-Ms, X-Context-Observed-At' }; }

/**
 * The one place an expired canonical run is turned into a response. Used by the
 * cold path and by a memo hit, so both refuse identically.
 *
 * Carries NO rows — the store returned before fetching any. Diagnostics are
 * non-secret status only: a stable reason code, the measured age, the budget it
 * broke, and the run's own observedAt. Age is RECOMPUTED from observedAt so a
 * memoized verdict cannot report an age younger than the truth.
 */
function staleExpiredResponse(req, context, now, cacheState) {
  const observedMs = context?.observedAt ? Date.parse(context.observedAt) : NaN;
  const ageMs = Number.isFinite(observedMs) ? Math.max(0, now - observedMs) : (Number.isFinite(context?.ageMs) ? context.ageMs : null);
  const maxAgeMs = Number.isFinite(context?.maxAgeMs) ? context.maxAgeMs : CONTEXT_HARD_MAX_AGE_MS;
  console.warn('[CONTEXT] stale_expired', { ageMs, maxAgeMs, observedAt: context?.observedAt || null, cache: cacheState });
  const body = {
    ok: false,
    reason: REASON_STALE_EXPIRED,
    stale_expired: true,
    age_ms: ageMs,
    max_age_ms: maxAgeMs,
    observedAt: context?.observedAt || null,
    detail: 'the newest published canonical run is older than the hard freshness budget; use the live market read',
  };
  return new Response(JSON.stringify(body), {
    status: 503,
    headers: {
      ...headers(req, cacheState),
      'X-Context-Stale': 'expired',
      'X-Context-Age-Ms': ageMs == null ? 'unknown' : String(ageMs),
      'X-Context-Observed-At': context?.observedAt || 'unknown',
    },
  });
}
function json(req, body, status = 200, cacheState) { return new Response(JSON.stringify(body), { status, headers: headers(req, cacheState) }); }
export async function runContextRead(req, deps = {}) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });
  if (req.method !== 'GET') return json(req, { ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405);
  let getIdentity = deps.getIdentity; if (!getIdentity) { try { getIdentity = (await (deps.loadAuth || loadAuth)()).getIdentity; } catch { return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401); } }
  let identity; try { identity = await getIdentity(req); } catch { return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401); }
  if (!identity?.ok || identity.verified !== true) return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);

  // ── Emergency master kill switch (DB_READS_ENABLED=false) ─────────────────
  //
  // Deliberately AFTER authentication: the breaker weakens no auth, and an
  // unauthenticated caller still gets 401, never a degraded snapshot.
  //
  // This endpoint normally stays available — it is the terminal's core read —
  // so only the owner's explicit master lever turns it off. When it is engaged
  // the response is an honest ok:false with a named reason, which the browser
  // already handles by falling back to /api/markets (an edge function that
  // touches no database) and showing a visible toast. HTTP 200 rather than 5xx
  // on purpose: a deliberate degradation must not masquerade as a server fault
  // or flood the function error rate.
  if (masterKillSwitchEngaged(deps.env || process.env)) {
    noteCostBreakerBlock('context_read', REASON_COST_BREAKER_DISABLED_PATH);
    return new Response(JSON.stringify({
      ok: false, degraded: true, reason: REASON_COST_BREAKER_DISABLED_PATH,
    }), { status: 200, headers: costGuardHeaders(REASON_COST_BREAKER_DISABLED_PATH, headers(req, 'bypass')) });
  }

  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const ttlMs = contextCacheMs(deps.env || process.env);

  // Memo hit: no database work at all for this request.
  if (ttlMs > 0 && _memo && (now - _memo.storedAt) < ttlMs) {
    contextReadStats.memoHits += 1;
    // A memoized EXPIRED verdict must be replayed as the same refusal, never as
    // a 200. Age is recomputed from observedAt rather than replayed, so the memo
    // cannot understate how old the run has become while it sat here.
    if (_memo.context?.reason === REASON_STALE_EXPIRED) return staleExpiredResponse(req, _memo.context, now, 'hit');
    return json(req, refreshFreshness(_memo.context, now), 200, 'hit');
  }

  // Cold read. Coalesce concurrent callers onto ONE database read rather than
  // letting a burst of tabs each open their own four-query round trip.
  if (!_inFlight) {
    _inFlight = (async () => {
      let store = deps.store; let database = deps.database;
      try { store ||= await (deps.loadStore || loadStore)(); if (!database) database = (await (deps.loadDb || loadDb)()).getDb().pool; }
      catch { return { ok: false, reason: 'DB_UNAVAILABLE' }; }
      // Over-fetch deliberately: the reader collapses spot/futures rows of the same
      // base asset into one coin, so ~1000 displayed coins needs materially more rows
      // than 1000 here.
      contextReadStats.dbReads += 1;
      // maxAgeMs makes the store refuse an expired run BEFORE it issues the two
      // expensive queries, so an expired read is cheaper than a served one.
      const context = await store.getAtomizedMarketContext(database, {
        tickerLimit: 2000, microLimit: 600, maxAgeMs: CONTEXT_HARD_MAX_AGE_MS, now,
      });
      // An expired run is a DELIBERATE refusal, not a database fault, and it
      // carries its own diagnostics through untouched.
      if (context?.reason === REASON_STALE_EXPIRED) return context;
      if (!context?.ok) return { ok: false, reason: context?.reason || 'DB_UNAVAILABLE' };
      // Safety annotation must never take the read down: a classifier failure leaves
      // the rows unannotated (blank, i.e. UNKNOWN) rather than failing the response.
      if (context.market && Array.isArray(context.market.tickers)) {
        try {
          const { classifyMarketSafety } = deps.safety || await (deps.loadSafety || loadSafety)();
          context.market.tickers = withSafety(context.market.tickers, classifyMarketSafety);
        } catch (error) { console.warn('[CONTEXT] safety_annotation_unavailable', { name: error?.name || 'Error' }); }
      }
      return context;
    })().finally(() => { _inFlight = null; });
  } else {
    contextReadStats.coalesced += 1;
  }

  const context = await _inFlight;

  // ── Expired published run: refuse, with the numbers that prove it ──────────
  //
  // 503, not 200-with-rows: this endpoint has no canonical answer to give, and
  // the browser already treats that as an expected fallback to the live
  // /api/markets read. The body carries only non-secret status — a stable
  // reason code, the age, the budget it broke, and the run's own observedAt.
  // No ticker or microstructure row is included, by construction: the store
  // returned before it fetched any.
  //
  // MEMOIZED like a success on purpose. The verdict is global (same published
  // run for every caller) and monotonic (a run only gets older), so re-deriving
  // it per request would spend a Postgres round trip to be told the same thing.
  // The memo TTL bounds how long a NEWLY published run waits to be noticed,
  // exactly as it already does for a healthy read.
  if (context?.reason === REASON_STALE_EXPIRED) {
    if (ttlMs > 0) _memo = { context, storedAt: now };
    return staleExpiredResponse(req, context, now, 'miss');
  }

  // A failed read is never memoized and never served from a previous good
  // response — the caller must see the failure, per the error-observability rule.
  if (!context?.ok) {
    contextReadStats.failures += 1;
    console.warn('[CONTEXT] read_failed', { reason: context?.reason || 'DB_UNAVAILABLE', dbReads: contextReadStats.dbReads, memoHits: contextReadStats.memoHits });
    return json(req, { ok: false, reason: context?.reason || 'DB_UNAVAILABLE' }, 503, 'miss');
  }
  if (ttlMs > 0) _memo = { context, storedAt: now };
  return json(req, refreshFreshness(context, now), 200, 'miss');
}
export default async function handler(req) { return await runContextRead(req); }
export const config = { path: '/api/context' };