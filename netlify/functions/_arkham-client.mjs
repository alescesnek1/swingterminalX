// Arkham Intel adapter — DISABLED BY DEFAULT, ADVISORY ONLY.
//
// WHAT THIS IS
//   A pure, dependency-free bridge to the Arkham Intel API (https://api.arkm.com)
//   for on-chain *entity* intelligence: entity labels, holder concentration,
//   exchange in/outflows, whale transfers, counterparties, risk context. It is a
//   READ. It computes no score, writes nothing, and drives nothing.
//
// WHAT THIS IS NOT — and must never become
//   Nothing here may be imported by, or feed into, RADAR evaluation, ENTRY_READY,
//   strict Absorb, Reclaim, Telegram, alerts, the Scanner ranking / Lead Score /
//   default sort, or any trading/order path. Arkham data is advisory context a
//   human reads; it is never an input to a gate. tests/arkham.safety.test.mjs
//   enforces that no trading/alert module imports this file.
//
// COST MODEL (this is why every default is off)
//   Arkham bills in *credits*, some endpoints per-call and some per-row returned
//   (see docs/arkham-intel-integration.md). This repo just had a Netlify
//   credit-drain incident, so the shape here is deliberately the opposite of a
//   poller: one coin, on demand, cached, behind a daily credit cap that defaults
//   to 0 (= nothing may be spent). There is no scheduler, no background
//   collector, no top-N sweep, and no WebSocket in this module, and none may be
//   added without a separate reviewed decision.
//
// SAFETY MODEL
//   - Never throws. Every path resolves to { ok:true, ... } or { ok:false, reason }.
//   - ARKHAM_API_KEY is read from process.env only. It is never logged, never
//     returned, never placed in a URL/query string, and scrubSecret() is applied
//     to any message that could conceivably have captured it.
//   - HTTPS + single-host allowlist (api.arkm.com). A path/query that resolves
//     anywhere else is refused before any fetch happens.
//   - Bounded by an explicit request timeout; no retry loop (a retry storm on a
//     metered API is a cost incident, not resilience).
//   - Upstream response bodies are never surfaced raw — failures collapse to
//     stable reason codes so a 403 (rejected) is distinguishable from a 503
//     (outage) and from a 429 (rate/credit limit) without leaking the body.
//   - "No data" and "fetch failed" are different return values, and a missing
//     figure stays null (rendered UNKNOWN upstream) — never 0, never a
//     bearish/SELL-flavoured default.

// ── Upstream constants (documented, not guessed — see docs/arkham-intel-integration.md) ──
export const ARKHAM_API_HOST = 'api.arkm.com';
export const ARKHAM_API_BASE_URL = 'https://api.arkm.com';
// Arkham authenticates with a plain `API-Key: <key>` request header.
export const ARKHAM_AUTH_HEADER = 'API-Key';

// Only these paths may be built by this module today. Adding one is a cost
// decision (each has its own credit price), so the list is explicit rather than
// "whatever the caller passes".
export const ARKHAM_ALLOWED_PATHS = Object.freeze({
  TOKEN_INTELLIGENCE: '/intelligence/token', // + /{coingeckoPricingId}
});

// ── Cost-guard defaults. Every one of these is the OFF position. ──
export const ARKHAM_DEFAULTS = Object.freeze({
  enabled: false,
  dailyCreditCap: 0,          // 0 = may spend nothing at all
  cacheTtlHours: 24,          // 6–24h is the recommended band; 24h is the default
  maxSymbolsPerRequest: 1,    // one coin per request — never a batch sweep
  requestTimeoutMs: 8000,
});
export const ARKHAM_CACHE_TTL_MIN_HOURS = 6;
export const ARKHAM_CACHE_TTL_MAX_HOURS = 168;
export const ARKHAM_MAX_SYMBOLS_HARD_CAP = 5;
export const ARKHAM_CREDIT_CAP_HARD_MAX = 5000;

// Credit price per call we actually make. Kept next to the path allowlist so a
// new call cannot be added without stating what it costs.
export const ARKHAM_CREDIT_COSTS = Object.freeze({
  TOKEN_INTELLIGENCE: 1,
});

// Chains we are willing to put in a path/query. An unknown chain is refused
// rather than forwarded, so a typo can never become an upstream 4xx we pay
// attention to (or, worse, a path-traversal attempt).
const ARKHAM_CHAIN_ALLOWLIST = Object.freeze([
  'bitcoin', 'ethereum', 'bsc', 'polygon', 'avalanche', 'arbitrum_one', 'optimism',
  'base', 'solana', 'tron', 'linea', 'mantle', 'blast', 'ronin', 'flare', 'sonic',
]);

function boundInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Reads the Arkham configuration. NEVER returns the key itself — only
 * `hasKey`, so a config object can be logged or returned to the client
 * without any chance of leaking the secret.
 */
export function readArkhamConfig(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  // Strict `=== 'true'` so anything else (undefined, '1', 'TRUE', 'yes') is OFF.
  const enabled = source.ARKHAM_ENABLED === 'true';
  const rawKey = typeof source.ARKHAM_API_KEY === 'string' ? source.ARKHAM_API_KEY.trim() : '';
  const cacheTtlHours = boundInt(source.ARKHAM_CACHE_TTL_HOURS, ARKHAM_DEFAULTS.cacheTtlHours, ARKHAM_CACHE_TTL_MIN_HOURS, ARKHAM_CACHE_TTL_MAX_HOURS);
  return {
    enabled,
    hasKey: rawKey.length > 0,
    dailyCreditCap: boundInt(source.ARKHAM_DAILY_CREDIT_CAP, ARKHAM_DEFAULTS.dailyCreditCap, 0, ARKHAM_CREDIT_CAP_HARD_MAX),
    cacheTtlHours,
    cacheTtlMs: cacheTtlHours * 60 * 60 * 1000,
    maxSymbolsPerRequest: boundInt(source.ARKHAM_MAX_SYMBOLS_PER_REQUEST, ARKHAM_DEFAULTS.maxSymbolsPerRequest, 1, ARKHAM_MAX_SYMBOLS_HARD_CAP),
    requestTimeoutMs: boundInt(source.ARKHAM_REQUEST_TIMEOUT_MS, ARKHAM_DEFAULTS.requestTimeoutMs, 1000, 20000),
  };
}

/**
 * The single place that decides whether an upstream call is permitted.
 * Returns one of:
 *   DISABLED        — ARKHAM_ENABLED is not exactly 'true' (the default)
 *   NOT_CONFIGURED  — enabled but no ARKHAM_API_KEY (a config gap, not a 500)
 *   COST_CAPPED     — enabled + keyed but ARKHAM_DAILY_CREDIT_CAP is 0 (default)
 *   READY           — every guard is deliberately open
 */
export function arkhamStatus(env = process.env) {
  const config = readArkhamConfig(env);
  if (!config.enabled) {
    return { status: 'DISABLED', config, message: 'Arkham Intel is disabled. Set ARKHAM_ENABLED=true and ARKHAM_API_KEY to enable.' };
  }
  if (!config.hasKey) {
    return { status: 'NOT_CONFIGURED', config, message: 'Arkham Intel is enabled but ARKHAM_API_KEY is not set. No request was made.' };
  }
  if (config.dailyCreditCap <= 0) {
    return { status: 'COST_CAPPED', config, message: 'Arkham Intel is enabled but ARKHAM_DAILY_CREDIT_CAP is 0, so no credits may be spent. Raise the cap deliberately to allow lookups.' };
  }
  return { status: 'READY', config, message: 'Arkham Intel is enabled and within its credit cap.' };
}

/**
 * Defensive redaction. Any string that might have picked up the key on its way
 * out (an error message, a thrown network error) passes through here first, so a
 * leak needs two independent mistakes rather than one.
 */
export function scrubSecret(text, env = process.env) {
  const s = typeof text === 'string' ? text : '';
  const key = typeof (env && env.ARKHAM_API_KEY) === 'string' ? env.ARKHAM_API_KEY.trim() : '';
  if (!s) return s;
  if (key.length >= 8 && s.includes(key)) return s.split(key).join('[redacted]');
  return s;
}

// ── Identifier normalization ────────────────────────────────────────────────
// Everything that can reach a URL or a cache key is normalized here first. A
// value that does not normalize returns null and the caller refuses the request
// — raw user input never reaches a path, a query string, or a cache key.

export function normalizeArkhamSymbol(input) {
  const sym = typeof input === 'string' ? input.trim().toUpperCase() : '';
  return /^[A-Z0-9]{2,32}$/.test(sym) ? sym : null;
}

/**
 * Arkham's token endpoints (`/intelligence/token/{id}`, `/token/holders/{id}`, …)
 * are keyed by CoinGecko pricing ID, which is why the mapping story in
 * docs/arkham-intel-integration.md matters so much: a Terminal-X row's `id` is a
 * real CoinGecko id only when the row came from CoinGecko, and a synthesized
 * Binance-only row carries a fabricated lowercase-symbol slug instead. Only a
 * value that passes here may be used, and even then the caller must have
 * confirmed provenance.
 */
export function normalizeCoingeckoId(input) {
  const id = typeof input === 'string' ? input.trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : null;
}

export function normalizeArkhamChain(input) {
  const chain = typeof input === 'string' ? input.trim().toLowerCase() : '';
  return ARKHAM_CHAIN_ALLOWLIST.includes(chain) ? chain : null;
}

export function normalizeContractAddress(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return raw.toLowerCase();          // EVM
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) return raw;              // Solana (base58, case-significant)
  return null;
}

/**
 * Resolves the strongest stable identity available for a coin, in preference
 * order, and reports which one it used. `symbol` alone is explicitly the WEAK
 * case: symbols collide across chains, so a symbol-only identity is good enough
 * to key a cache entry but is flagged so the UI can say the lookup is
 * ambiguous rather than silently intelligence about the wrong token.
 */
export function resolveArkhamTokenIdentity({ symbol, coingeckoId, chain, contractAddress } = {}) {
  const normalizedSymbol = normalizeArkhamSymbol(symbol);
  const normalizedCoingeckoId = normalizeCoingeckoId(coingeckoId);
  const normalizedChain = normalizeArkhamChain(chain);
  const normalizedContract = normalizeContractAddress(contractAddress);

  if (normalizedCoingeckoId) {
    return { ok: true, source: 'coingecko_id', strong: true, symbol: normalizedSymbol, coingeckoId: normalizedCoingeckoId, chain: normalizedChain, contractAddress: normalizedContract };
  }
  if (normalizedChain && normalizedContract) {
    return { ok: true, source: 'chain_contract', strong: true, symbol: normalizedSymbol, coingeckoId: null, chain: normalizedChain, contractAddress: normalizedContract };
  }
  if (normalizedSymbol) {
    return { ok: true, source: 'symbol', strong: false, symbol: normalizedSymbol, coingeckoId: null, chain: null, contractAddress: null };
  }
  return { ok: false, reason: 'ARKHAM_IDENTITY_UNRESOLVED' };
}

/**
 * Cache key. Built ONLY from normalized identity — never from raw request
 * input — so a hostile symbol can neither poison a neighbouring key nor smuggle
 * characters into a store path. Returns null when nothing normalized.
 */
export function arkhamCacheKey(identity) {
  if (!identity || identity.ok === false) return null;
  const symbol = normalizeArkhamSymbol(identity.symbol);
  const coingeckoId = normalizeCoingeckoId(identity.coingeckoId);
  const chain = normalizeArkhamChain(identity.chain);
  const contract = normalizeContractAddress(identity.contractAddress);
  if (coingeckoId) return `arkham:v1:cg:${coingeckoId}`;
  if (chain && contract) return `arkham:v1:chain:${chain}:${contract}`;
  if (symbol) return `arkham:v1:sym:${symbol}`;
  return null;
}

/**
 * Builds an absolute Arkham URL and refuses anything that does not land on the
 * allowlisted HTTPS host. The key is NEVER a query parameter (it is a header),
 * so no URL this returns can carry the secret.
 */
export function buildArkhamUrl(path, query = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || !/^\/[A-Za-z0-9/_.-]*$/.test(path)) {
    return { ok: false, reason: 'ARKHAM_INVALID_PATH' };
  }
  let url;
  try {
    url = new URL(path, ARKHAM_API_BASE_URL);
  } catch {
    return { ok: false, reason: 'ARKHAM_INVALID_PATH' };
  }
  if (url.protocol !== 'https:' || url.host !== ARKHAM_API_HOST) {
    return { ok: false, reason: 'ARKHAM_HOST_NOT_ALLOWED' };
  }
  for (const [k, v] of Object.entries(query || {})) {
    if (v === null || v === undefined || v === '') continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)) return { ok: false, reason: 'ARKHAM_INVALID_QUERY' };
    url.searchParams.set(k, String(v));
  }
  return { ok: true, url: url.toString() };
}

/**
 * Per-instance credit guard. Deliberately simple and injectable.
 *
 * HONEST LIMITATION: a serverless function has many instances, so this bounds
 * spend *per warm instance per UTC day*, not globally. That is acceptable only
 * while the cap defaults to 0 (nothing is spendable at all). Before Arkham is
 * ever enabled in production the durable counter described in
 * docs/arkham-intel-integration.md (Netlify Blobs, single key, read-modify-write)
 * must replace this. Do not enable Arkham on the strength of this guard alone.
 */
export function createArkhamCreditGuard({ dailyCreditCap = 0, now = () => Date.now() } = {}) {
  const cap = Math.max(0, Math.trunc(Number(dailyCreditCap) || 0));
  let day = null;
  let spent = 0;
  const currentDay = () => new Date(now()).toISOString().slice(0, 10);
  const roll = () => {
    const today = currentDay();
    if (day !== today) { day = today; spent = 0; }
  };
  return {
    cap,
    spent() { roll(); return spent; },
    remaining() { roll(); return Math.max(0, cap - spent); },
    /** Reserve `credits` up front. Returns false when the cap would be exceeded. */
    reserve(credits) {
      roll();
      const cost = Math.max(1, Math.trunc(Number(credits) || 1));
      if (cap <= 0 || spent + cost > cap) return false;
      spent += cost;
      return true;
    },
    /** Refund a reservation when the request never reached Arkham (4xx/5xx are not billed). */
    refund(credits) {
      roll();
      const cost = Math.max(1, Math.trunc(Number(credits) || 1));
      spent = Math.max(0, spent - cost);
    },
  };
}

// One guard per warm instance, sized from env on first use.
let _guard = null;
export function getArkhamCreditGuard(env = process.env, { reset = false } = {}) {
  const cap = readArkhamConfig(env).dailyCreditCap;
  if (reset || !_guard || _guard.cap !== cap) _guard = createArkhamCreditGuard({ dailyCreditCap: cap });
  return _guard;
}

function logWarn(event, fields) {
  // Fields are stable codes / counts only — never the key, never a raw body.
  console.warn(`[ARKHAM] ${event}`, fields);
}

/**
 * The ONE function in this repo that may talk to Arkham. Never throws.
 *
 * Resolves to { ok:true, data, creditsCharged } or { ok:false, reason, status? }.
 * Every guard (enabled / key / credit cap / host / timeout) is checked here, so
 * a caller cannot accidentally bypass one.
 */
export async function arkhamFetchJson({ path, query, creditCost = 1, env = process.env, fetchImpl, guard } = {}) {
  const gate = arkhamStatus(env);
  if (gate.status !== 'READY') {
    // Not an error — the deliberate off position. No fetch happened.
    return { ok: false, reason: `ARKHAM_${gate.status}`, status: gate.status, message: gate.message };
  }
  const built = buildArkhamUrl(path, query);
  if (!built.ok) {
    logWarn('request refused before fetch', { reason: built.reason });
    return { ok: false, reason: built.reason };
  }
  const creditGuard = guard || getArkhamCreditGuard(env);
  const cost = Math.max(1, Math.trunc(Number(creditCost) || 1));
  if (!creditGuard.reserve(cost)) {
    logWarn('credit cap reached — no request made', { creditCost: cost, cap: creditGuard.cap, spent: creditGuard.spent() });
    return { ok: false, reason: 'ARKHAM_CREDIT_CAP_EXCEEDED', status: 'COST_CAPPED', message: 'Daily Arkham credit cap reached. No request was made.' };
  }

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const timeoutMs = gate.config.requestTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(built.url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        // Header-only auth. The key is never in the URL and never logged.
        [ARKHAM_AUTH_HEADER]: String(env.ARKHAM_API_KEY || ''),
      },
    });
    const status = Number(res && res.status);
    if (!res || !res.ok) {
      // Arkham does not bill 4xx/5xx, so the reservation goes back.
      creditGuard.refund(cost);
      const reason = status === 401 || status === 403 ? 'ARKHAM_AUTH_REJECTED'
        : status === 404 ? 'ARKHAM_NOT_FOUND'
          : status === 429 ? 'ARKHAM_RATE_LIMITED'
            : `ARKHAM_HTTP_${Number.isFinite(status) ? status : 'UNKNOWN'}`;
      logWarn('upstream rejected the request', { reason, status: Number.isFinite(status) ? status : null, path });
      // Raw upstream body is deliberately never read or surfaced.
      return { ok: false, reason, httpStatus: Number.isFinite(status) ? status : null };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      creditGuard.refund(cost);
      logWarn('upstream returned an unusable body', { reason: 'ARKHAM_INVALID_RESPONSE', path });
      return { ok: false, reason: 'ARKHAM_INVALID_RESPONSE' };
    }
    if (!data || typeof data !== 'object') {
      creditGuard.refund(cost);
      logWarn('upstream returned a non-object body', { reason: 'ARKHAM_INVALID_RESPONSE', path });
      return { ok: false, reason: 'ARKHAM_INVALID_RESPONSE' };
    }
    return { ok: true, data, creditsCharged: cost };
  } catch (e) {
    creditGuard.refund(cost);
    const timedOut = e && e.name === 'AbortError';
    const reason = timedOut ? 'ARKHAM_TIMEOUT' : 'ARKHAM_FETCH_FAILED';
    // scrubSecret is belt-and-braces: a thrown fetch error should not contain the
    // key (it is a header, not a URL), but this makes a leak need two mistakes.
    logWarn('request failed', { reason, path, detail: scrubSecret(timedOut ? `aborted after ${timeoutMs}ms` : (e && e.name) || 'unknown', env) });
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

// ── Advisory presentation shape ─────────────────────────────────────────────
// The panel contract. Every field starts null = UNKNOWN. A figure Arkham did
// not return stays null and renders as UNKNOWN — never 0, never a bearish
// default, and never anything a gate could read as a signal.
export function emptyArkhamIntel() {
  return {
    entity: null,                 // { name, type, labelConfidence } — entity summary
    holderConcentration: null,    // { topHoldersPct, top10Pct, holderCount }
    exchangeNetflow: null,        // { inflowUsd, outflowUsd, netUsd, windowHours }
    whaleTransfers: null,         // [{ usd, fromLabel, toLabel, timestamp }]
    counterparties: null,         // [{ name, type, usd }]
    riskFlags: null,              // { level, score, categories: [] }
    tokenFlowSummary: null,       // { windowHours, netUsd, direction }
    lastUpdated: null,            // ISO string of the upstream read
  };
}

/**
 * Maps an Arkham token-intelligence payload into the advisory panel shape.
 * Intentionally conservative: a field is only populated when the upstream value
 * is a finite number / non-empty string. Anything absent or unparsable is
 * reported in `missing` so the UI can say WHICH parts are unknown rather than
 * implying a complete picture.
 *
 * The upstream response schema is not fully documented publicly (see the doc),
 * so this mapper must be re-verified against a real trial response before
 * Arkham is enabled. Until then it is a shape contract, not a proven parser.
 */
export function presentArkhamTokenIntel(raw, { now = () => Date.now() } = {}) {
  const intel = emptyArkhamIntel();
  const missing = [];
  const src = raw && typeof raw === 'object' ? raw : {};

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
  // Reject null/'' BEFORE Number(), or a missing value becomes a real 0.
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const entityName = str(src.entityName) || str(src.name) || (src.entity && str(src.entity.name)) || null;
  const entityType = str(src.entityType) || (src.entity && str(src.entity.type)) || null;
  if (entityName || entityType) {
    intel.entity = { name: entityName, type: entityType, labelConfidence: str(src.labelConfidence) || null };
  } else {
    missing.push('entity');
  }

  const topHoldersPct = num(src.topHoldersPct);
  const holderCount = num(src.holderCount);
  if (topHoldersPct !== null || holderCount !== null) {
    intel.holderConcentration = { topHoldersPct, top10Pct: num(src.top10Pct), holderCount };
  } else {
    missing.push('holderConcentration');
  }

  // Netflow must be computed from BOTH sides or not at all — a one-sided read
  // would render as a directional claim the data does not support.
  const inflowUsd = num(src.inflowUsd);
  const outflowUsd = num(src.outflowUsd);
  if (inflowUsd !== null && outflowUsd !== null) {
    intel.exchangeNetflow = { inflowUsd, outflowUsd, netUsd: inflowUsd - outflowUsd, windowHours: num(src.windowHours) };
  } else {
    missing.push('exchangeNetflow');
  }

  missing.push('whaleTransfers', 'counterparties', 'riskFlags', 'tokenFlowSummary');
  intel.lastUpdated = new Date(now()).toISOString();
  return { intel, missing };
}

// The advisory contract, attached to every response this feature produces so a
// reader (human or machine) can never mistake it for a trading signal.
export const ARKHAM_ADVISORY_CONTRACT = Object.freeze({
  advisoryOnly: true,
  affectsTrading: false,
  affects: Object.freeze({
    radar: false, entryReady: false, strictAbsorb: false, reclaim: false,
    telegram: false, alerts: false, orders: false, scannerRanking: false,
    leadScore: false, defaultSorting: false, valuation: false, gateChecklist: false,
  }),
  disclaimer: 'Advisory only — on-chain context for human reading. Does not affect ENTRY_READY, RADAR, strict Absorb, Reclaim, Telegram, alerts, Scanner ranking, or any order path. Not investment advice.',
});
