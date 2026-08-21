// Canonical context hard expiry — the ROOT-CAUSE fix.
//
// Production served a 28-hour-old "canonical" snapshot as a normal 200 body.
// Three things combined:
//   1. MARKET_CONTEXT_COLLECT_ENABLED=false (the emergency cost breaker —
//      deliberate), so nothing publishes a new run;
//   2. getAtomizedMarketContext() asks for "the newest PUBLISHED run" with NO
//      age predicate, so that is the same row forever;
//   3. `freshness` was a LABEL computed after the read, never a gate — the body
//      went out with 200 either way.
//
// The browser refusing the rows was a second line of defence. These tests pin
// the FIRST one: the endpoint must not offer an expired run at all.
//
// Layer 1: REAL behaviour — the store and the endpoint are imported and run
//          against a fake `db` / fake store, so the verdicts are executed.
// Layer 2: source-level wiring for the browser bundle, which cannot be imported.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { getAtomizedMarketContext } from '../netlify/functions/_market-context-store.mjs';
import {
  runContextRead,
  resetContextCacheForTests,
  CONTEXT_HARD_MAX_AGE_MS,
  REASON_STALE_EXPIRED,
} from '../netlify/functions/context.mjs';
import { HARD_MAX_MARKET_AGE_MS } from '../apps/edge/public/js/freshness-badge.js';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const js = read('apps/edge/public/js/terminal.js');
const storeSrc = read('netlify/functions/_market-context-store.mjs');
const contextSrc = read('netlify/functions/context.mjs');

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const AGE_28H = 28 * 60 * MIN;

// ── a fake `db` that records which queries were issued ───────────────────────
function fakeDb({ observedAt, queries = [] }) {
  return {
    queries,
    async query(sql, _params) {
      // Full normalized SQL: the table name is not always in the first clause
      // (the ticker query selects a dozen columns before naming its FROM).
      queries.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM market_collection_runs/.test(sql)) {
        return observedAt === null
          ? { rows: [] }
          : { rows: [{ id: 7, run_key: 'k', observed_at: observedAt, completed_at: observedAt, diagnostics: {} }] };
      }
      if (/market_ticker_observations/.test(sql)) return { rows: [{ market: 'spot', symbol: 'BTCUSDT', base_asset: 'BTC', quote_asset: 'USDT', last_price: '60000', quote_volume: '9e8' }] };
      if (/market_microstructure_measurements/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

const iso = (ms) => new Date(ms).toISOString();

// ── the endpoint harness ─────────────────────────────────────────────────────
const request = (method = 'GET') => new Request('https://example.test/api/context', {
  method, headers: { origin: 'https://example.test' },
});
const authed = { getIdentity: async () => ({ ok: true, verified: true }) };

// ─────────────────────────────────────────────────────────────
// The store: the gate itself
// ─────────────────────────────────────────────────────────────

test('store: a FRESH run is returned normally, with rows', async () => {
  const queries = [];
  const ctx = await getAtomizedMarketContext(fakeDb({ observedAt: iso(NOW - 2 * MIN), queries }), {
    maxAgeMs: CONTEXT_HARD_MAX_AGE_MS, now: NOW,
  });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.market.freshness, 'FRESH');
  assert.equal(ctx.market.tickers.length, 1);
  assert.ok(queries.some((q) => /market_ticker_observations/.test(q)), 'the expensive read did run');
});

test('store: a 28h run is REFUSED — no rows, named reason, real diagnostics', async () => {
  const queries = [];
  const ctx = await getAtomizedMarketContext(fakeDb({ observedAt: iso(NOW - AGE_28H), queries }), {
    maxAgeMs: CONTEXT_HARD_MAX_AGE_MS, now: NOW,
  });
  assert.equal(ctx.ok, false);
  assert.equal(ctx.reason, 'STALE_EXPIRED');
  assert.equal(ctx.staleExpired, true);
  assert.equal(ctx.ageMs, AGE_28H);
  assert.equal(ctx.maxAgeMs, CONTEXT_HARD_MAX_AGE_MS);
  assert.equal(ctx.observedAt, iso(NOW - AGE_28H));
  assert.equal(ctx.market, undefined, 'no market payload may be present');
  assert.equal(ctx.radar, undefined, 'no radar payload may be present');
});

test('store: refusing is CHEAPER — the expensive queries are never issued', async () => {
  const queries = [];
  await getAtomizedMarketContext(fakeDb({ observedAt: iso(NOW - AGE_28H), queries }), {
    maxAgeMs: CONTEXT_HARD_MAX_AGE_MS, now: NOW,
  });
  assert.equal(queries.length, 1, 'only the run lookup, got: ' + queries.join(' | '));
  assert.ok(!queries.some((q) => /market_ticker_observations/.test(q)));
  assert.ok(!queries.some((q) => /market_microstructure_measurements/.test(q)));
});

test('store: the boundary is exact and fails closed on a bad timestamp', async () => {
  const inside = await getAtomizedMarketContext(fakeDb({ observedAt: iso(NOW - (CONTEXT_HARD_MAX_AGE_MS - 1)) }), { maxAgeMs: CONTEXT_HARD_MAX_AGE_MS, now: NOW });
  assert.equal(inside.ok, true, 'one ms inside the budget is still served');
  const outside = await getAtomizedMarketContext(fakeDb({ observedAt: iso(NOW - (CONTEXT_HARD_MAX_AGE_MS + 1)) }), { maxAgeMs: CONTEXT_HARD_MAX_AGE_MS, now: NOW });
  assert.equal(outside.reason, 'STALE_EXPIRED', 'one ms past it is refused');
  const unparseable = await getAtomizedMarketContext(fakeDb({ observedAt: 'not-a-date' }), { maxAgeMs: CONTEXT_HARD_MAX_AGE_MS, now: NOW });
  assert.equal(unparseable.reason, 'STALE_EXPIRED', 'an unprovable age must expire, not pass');
});

test('store: the gate is OPT-IN — existing callers are byte-identical', async () => {
  // No maxAgeMs → the 28h run is still returned, exactly as before this change.
  // This is what keeps the personal-watch (Telegram) and morning-briefing
  // readers untouched; see docs/canonical-context-expiry.md.
  const ctx = await getAtomizedMarketContext(fakeDb({ observedAt: iso(NOW - AGE_28H) }), { now: NOW });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.market.freshness, 'STALE');
  for (const bad of [0, -1, null, undefined, NaN, 'x']) {
    const c = await getAtomizedMarketContext(fakeDb({ observedAt: iso(NOW - AGE_28H) }), { maxAgeMs: bad, now: NOW });
    assert.equal(c.ok, true, 'maxAgeMs=' + String(bad) + ' must mean OFF, not a zero budget');
  }
});

test('store: "no published run at all" is still its own distinct answer', async () => {
  const ctx = await getAtomizedMarketContext(fakeDb({ observedAt: null }), { maxAgeMs: CONTEXT_HARD_MAX_AGE_MS, now: NOW });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.radar.pendingReason, 'NO_PUBLISHED_RUN', 'must not be confused with STALE_EXPIRED');
});

// ─────────────────────────────────────────────────────────────
// The endpoint: what /api/context actually answers
// ─────────────────────────────────────────────────────────────

const freshEnvelope = () => ({
  ok: true, contextVersion: null, run: { id: 1 },
  market: { observedAt: iso(NOW - 2 * MIN), freshness: 'FRESH', tickers: [{ symbol: 'BTCUSDT' }], microstructure: [], dataQuality: {} },
  radar: { status: 'PENDING' },
});
const expiredEnvelope = () => ({
  ok: false, reason: 'STALE_EXPIRED', staleExpired: true,
  ageMs: AGE_28H, maxAgeMs: CONTEXT_HARD_MAX_AGE_MS, observedAt: iso(NOW - AGE_28H),
});

test('endpoint: a fresh snapshot returns a normal 200 with rows', async () => {
  resetContextCacheForTests();
  const res = await runContextRead(request(), {
    ...authed, database: {}, now: () => NOW, env: {},
    store: { getAtomizedMarketContext: async () => freshEnvelope() },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.market.tickers.length, 1);
});

test('endpoint: a 28h snapshot returns 503 STALE_EXPIRED and NO rows', async () => {
  resetContextCacheForTests();
  const res = await runContextRead(request(), {
    ...authed, database: {}, now: () => NOW, env: {},
    store: { getAtomizedMarketContext: async () => expiredEnvelope() },
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, REASON_STALE_EXPIRED);
  assert.equal(body.stale_expired, true);
  assert.equal(body.age_ms, AGE_28H);
  assert.equal(body.max_age_ms, CONTEXT_HARD_MAX_AGE_MS);
  assert.equal(body.observedAt, iso(NOW - AGE_28H));
  // The whole point: not a single row leaves the endpoint.
  assert.equal(body.market, undefined);
  assert.equal(body.radar, undefined);
  assert.equal(body.tickers, undefined);
  assert.doesNotMatch(JSON.stringify(body), /BTCUSDT/);
});

test('endpoint: the refusal carries readable, non-secret diagnostics headers', async () => {
  resetContextCacheForTests();
  const res = await runContextRead(request(), {
    ...authed, database: {}, now: () => NOW, env: {},
    store: { getAtomizedMarketContext: async () => expiredEnvelope() },
  });
  assert.equal(res.headers.get('X-Context-Stale'), 'expired');
  assert.equal(res.headers.get('X-Context-Age-Ms'), String(AGE_28H));
  assert.equal(res.headers.get('X-Context-Observed-At'), iso(NOW - AGE_28H));
  assert.match(res.headers.get('Access-Control-Expose-Headers') || '', /X-Context-Stale/);
  // Nothing secret: no connection string, token, email or chat id.
  const dump = JSON.stringify([...res.headers]) + await res.clone().text();
  assert.doesNotMatch(dump, /postgres:|password|token|chat_id|@[a-z0-9-]+\.[a-z]{2,}/i);
});

test('endpoint: the endpoint passes the hard budget down to the store', async () => {
  resetContextCacheForTests();
  let seen = null;
  await runContextRead(request(), {
    ...authed, database: {}, now: () => NOW, env: {},
    store: { getAtomizedMarketContext: async (_db, opts) => { seen = opts; return freshEnvelope(); } },
  });
  assert.equal(seen.maxAgeMs, CONTEXT_HARD_MAX_AGE_MS);
  assert.equal(seen.now, NOW);
});

test('endpoint: a memoized expired verdict replays as 503, never as 200', async () => {
  resetContextCacheForTests();
  let calls = 0;
  const deps = {
    ...authed, database: {}, env: {},
    store: { getAtomizedMarketContext: async () => { calls += 1; return expiredEnvelope(); } },
  };
  const first = await runContextRead(request(), { ...deps, now: () => NOW });
  assert.equal(first.status, 503);
  // Second call lands inside the memo TTL.
  const second = await runContextRead(request(), { ...deps, now: () => NOW + 1_000 });
  assert.equal(second.status, 503, 'a memo hit must not turn a refusal into a 200');
  assert.equal(calls, 1, 'and it must not re-hit the database');
  const body = await second.json();
  assert.equal(body.reason, REASON_STALE_EXPIRED);
  // Age is recomputed, so the memo cannot under-report how old the run has got.
  assert.equal(body.age_ms, AGE_28H + 1_000);
});

test('endpoint: a real DB failure is still its own 503, distinct from expiry', async () => {
  resetContextCacheForTests();
  const res = await runContextRead(request(), {
    ...authed, database: {}, now: () => NOW, env: {},
    store: { getAtomizedMarketContext: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }) },
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.reason, 'DB_UNAVAILABLE');
  assert.notEqual(body.reason, REASON_STALE_EXPIRED);
  assert.equal(body.stale_expired, undefined);
});

test('endpoint: expiry never weakens auth — an unauthenticated caller still gets 401', async () => {
  resetContextCacheForTests();
  const res = await runContextRead(request(), {
    getIdentity: async () => ({ ok: false }), database: {}, now: () => NOW, env: {},
    store: { getAtomizedMarketContext: async () => expiredEnvelope() },
  });
  assert.equal(res.status, 401);
});

test('endpoint: the cost-breaker master switch still wins over everything', async () => {
  resetContextCacheForTests();
  const res = await runContextRead(request(), {
    ...authed, database: {}, now: () => NOW, env: { DB_READS_ENABLED: 'false' },
    store: { getAtomizedMarketContext: async () => { throw new Error('must not be called'); } },
  });
  assert.equal(res.status, 200, 'a deliberate blackout is not a server fault');
  assert.equal((await res.json()).reason, 'COST_BREAKER_DISABLED_PATH');
});

test('client and server draw the hard line in the same place', () => {
  assert.equal(CONTEXT_HARD_MAX_AGE_MS, HARD_MAX_MARKET_AGE_MS);
  assert.equal(CONTEXT_HARD_MAX_AGE_MS, 30 * MIN);
});

// ─────────────────────────────────────────────────────────────
// The browser: expected fallback, live markets preserved
// ─────────────────────────────────────────────────────────────

test('frontend: a 503 STALE_EXPIRED is treated as the EXPECTED degraded state', () => {
  // Classification now prefers the response HEADER, so a truncated or
  // unparseable body cannot turn an expected expiry into a scary failure.
  // Wording and detail live in tests/frontend.stale-expired-ux.test.mjs.
  assert.match(js, /if \(r\.status === 503 && \(headerExpired \|\| \(parsed && parsed\.reason === 'STALE_EXPIRED'\)\)\)/);
  assert.match(js, /err\.canonicalDegraded = true;/);
  assert.match(js, /err\.canonicalReason = 'published run expired'/);
  // ...so it produces NO toast at all when the live fallback works. The INFO
  // card this used to require reappeared on every 60s tick, because the
  // published run only ages while the collector is off — see
  // tests/frontend.canonical-expired-toast-suppression.test.mjs.
  assert.doesNotMatch(js, /Toast\?\.info\?\.\('Canonical context/);
  assert.match(js, /_canonicalBreakerTrip\(_canonicalDegraded\.reason, _canonicalDegraded\.ageMs\);/);
});

test('frontend: a NON-expiry failure still surfaces a visible error', () => {
  // The raw body no longer travels into the message — one short named field
  // from it does, via _safeHttpReason. The red toast itself is unchanged.
  assert.match(js, /throw new Error\('HTTP ' \+ r\.status \+ \(safe \? ' — ' \+ safe : ''\)\);/);
  assert.match(js, /window\.Toast\?\.error\?\.\('Canonical context unavailable'/);
});

test('frontend: the live /api/markets fallback is preserved, force included', () => {
  assert.match(js, /const _mktUrl = force \? '\/api\/markets\?force=1' : '\/api\/markets';/);
  // Third skip condition: the circuit breaker. It only ever removes a canonical
  // probe — force still bypasses the store outright, as before.
  assert.match(js, /const _canonical = _canonicalContextEnabled\(\) && !force && !_breakerOpen;/);
  // The expiry is still LOGGED, once per breaker window rather than per tick.
  assert.match(js, /live \/api\/markets is the active source/);
});

test('frontend: no expired canonical row can reach the scanner, detail or RADAR', () => {
  // The rows never arrive (the server sends none), and the client refuses on its
  // own too: _fetchCanonicalMarkets throws before mapping any ticker.
  const canonical = js.slice(js.indexOf('async function _fetchCanonicalMarkets'), js.indexOf('async function fetchData(opts)'));
  assert.ok(canonical.indexOf('throw err;') < canonical.indexOf('const tickers ='), 'the refusal precedes any row mapping');
  // __canonicalContext is replaced with an explicit failure marker, so the RADAR
  // panel cannot keep rendering the previous cycle's object as current.
  assert.match(js, /failed: true,/);
  assert.match(js, /degraded: !!_canonicalDegraded,/);
});

// ─────────────────────────────────────────────────────────────
// Nothing was re-enabled, nothing else moved
// ─────────────────────────────────────────────────────────────

test('no DB-heavy collector or writer is re-enabled by this change', () => {
  const breaker = read('netlify/functions/_cost-breaker.mjs');
  assert.match(breaker, /return env\[flag\] === 'true';/);
  assert.match(breaker, /if \(masterKillSwitchEngaged\(env\)\) return false;/);
  // The collector still refuses before importing, connecting or fetching.
  const scheduled = read('netlify/functions/market-context-collect-scheduled.mjs');
  assert.match(scheduled, /if \(!marketContextCollectAllowed\(process\.env\)\) \{/);
  assert.match(scheduled, /reason: 'COLLECT_DISABLED'/);
  // The schedule itself is untouched by this branch.
  assert.match(scheduled, /export const config = \{ schedule: '\*\/3 \* \* \* \*' \};/);
  // ...and the store still writes nothing on a read path.
  assert.doesNotMatch(contextSrc, /insertAtomicMarketRecords|completeCollectionRun|INSERT |UPDATE |DELETE /);
});

test('the expiry gate adds no query and touches no write path', () => {
  const fn = storeSrc.slice(storeSrc.indexOf('export async function getAtomizedMarketContext'), storeSrc.indexOf('export async function getContextDiagnostics'));
  // Exactly the three reads that were there before: run, tickers, microstructure.
  assert.equal((fn.match(/db\.query\(/g) || []).length, 3);
  assert.doesNotMatch(fn, /INSERT|UPDATE|DELETE/);
  // The age is taken from the run row already being read.
  assert.match(fn, /const observedMs = new Date\(run\.observed_at\)\.getTime\(\);/);
});

test('no trading, Telegram, RADAR gate or env behaviour is changed here', () => {
  for (const src of [contextSrc, storeSrc]) {
    assert.doesNotMatch(src, /api\.telegram|sendMessage|chat_id/i);
    assert.doesNotMatch(src, /newOrder|createOrder|placeOrder/i);
    assert.doesNotMatch(src, /process\.env\.[A-Z_]+\s*=/);
  }
  // ENTRY_READY / absorb gates live in the evaluator, untouched by this branch.
  const bot = read('netlify/functions/bot.mjs');
  assert.match(bot, /candidate\.telegramEligible = baselineTelegramEligibility\.get\(candidate\.symbol\);/);
  assert.doesNotMatch(bot, /STALE_EXPIRED/);
  // The personal-watch notifier WAS ungated when this file was written; the
  // follow-up branch (fix/canonical-store-consumer-freshness-guards) gave it the
  // same 30-minute budget, which is asserted in
  // tests/canonical-store-consumer-guards.test.mjs. What matters HERE is only
  // that /api/context's own expiry is what it is — so this file no longer pins
  // the other consumers' scope.
  // morning-briefing.mjs still passes no maxAgeMs on purpose: it applies its own
  // stricter 15-minute budget downstream and withholds stale rows entirely.
  assert.doesNotMatch(read('netlify/functions/morning-briefing.mjs'), /maxAgeMs/);
});

test('the decision and the re-enable path are written down', () => {
  const doc = read('docs/canonical-context-expiry.md');
  assert.match(doc, /MARKET_CONTEXT_COLLECT_ENABLED=false/);
  assert.match(doc, /disabled,\s*\*{0,2}\s*not\s+broken/i);
  assert.match(doc, /STALE_EXPIRED/);
  assert.match(doc, /_personal-watch-notifier\.mjs/);
  assert.match(doc, /morning-briefing\.mjs/);
  assert.match(doc, /re-enabl/i);
});
