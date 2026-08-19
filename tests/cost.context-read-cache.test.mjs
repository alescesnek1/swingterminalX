// Netlify DATABASE-compute guards for /api/context.
//
// ROOT CAUSE THESE LOCK IN: one /api/context read costs four Postgres queries
// and returns up to 2,000 ticker + 600 microstructure rows, with no caching of
// any kind, while every open terminal tab drove it on a timer. That was the
// single largest database-compute drain and it kept the database from ever
// idling.
//
// The memo must save database work WITHOUT weakening auth, WITHOUT masking a
// failure, and WITHOUT ever reporting a freshness the data no longer has.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runContextRead, contextCacheMs, refreshFreshness, contextReadStats,
  resetContextCacheForTests, CONTEXT_CACHE_DEFAULT_MS, CONTEXT_CACHE_ENV_FLAG,
} from '../netlify/functions/context.mjs';

function request(method = 'GET') {
  return new Request('https://example.test/api/context', { method, headers: { Origin: 'https://example.test' } });
}
const AUTHED = async () => ({ ok: true, verified: true });

// A fresh envelope per call so the memo cannot pass by sharing one object.
function envelope(observedAt = '2026-08-17T12:00:00.000Z') {
  return {
    ok: true, contextVersion: null, run: { id: 5 },
    market: { observedAt, freshness: 'FRESH', tickers: [], microstructure: [], dataQuality: {} },
    radar: { status: 'PENDING', candidates: [] },
  };
}

// Counts real store reads so "did this cost a database query?" is measurable.
function countingStore(make = envelope) {
  const store = { calls: 0, getAtomizedMarketContext: async () => { store.calls += 1; return make(); } };
  return store;
}

function read(deps) {
  return runContextRead(request(), { getIdentity: AUTHED, database: {}, safety: { classifyMarketSafety: () => ({}) }, ...deps });
}

test.beforeEach(() => resetContextCacheForTests());

// ── DB-backed path skips the database when the memo is warm ─────────────────

test('a repeat read inside the TTL costs no database query', async () => {
  const store = countingStore();
  const first = await read({ store, now: () => 1_000_000, env: {} });
  const second = await read({ store, now: () => 1_010_000, env: {} });   // +10s, TTL 30s
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(store.calls, 1, 'the second read never touched Postgres');
  assert.equal(first.headers.get('X-Context-Cache'), 'miss');
  assert.equal(second.headers.get('X-Context-Cache'), 'hit');
  assert.equal(contextReadStats.dbReads, 1);
  assert.equal(contextReadStats.memoHits, 1);
  // The served body is the real data, not a stub.
  assert.equal((await second.json()).run.id, 5);
});

test('the memo expires — data can never be pinned past the TTL', async () => {
  const store = countingStore();
  // Derived from the constant, not a hard-coded 30s: the emergency cost breaker
  // raised the default memo to 180s (the collector's own publish interval), and
  // what this test pins down is that expiry HAPPENS, at whatever the default is.
  await read({ store, now: () => 1_000_000, env: {} });
  await read({ store, now: () => 1_000_000 + CONTEXT_CACHE_DEFAULT_MS + 1_000, env: {} });
  assert.equal(store.calls, 2, 'an expired memo re-reads');
});

test('the DB-backed path is skipped entirely when caching is disabled', async () => {
  const store = countingStore();
  await read({ store, now: () => 1_000_000, env: { [CONTEXT_CACHE_ENV_FLAG]: '0' } });
  await read({ store, now: () => 1_000_100, env: { [CONTEXT_CACHE_ENV_FLAG]: '0' } });
  assert.equal(store.calls, 2, 'TTL 0 means every request reads through, as before this change');
  assert.equal(contextReadStats.memoHits, 0);
});

test('concurrent cold readers coalesce onto ONE database read', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const store = { calls: 0, getAtomizedMarketContext: async () => { store.calls += 1; await gate; return envelope(); } };
  const inFlight = [read({ store, now: () => 1_000_000, env: {} }), read({ store, now: () => 1_000_001, env: {} }), read({ store, now: () => 1_000_002, env: {} })];
  release();
  const responses = await Promise.all(inFlight);
  assert.equal(store.calls, 1, 'a burst of tabs costs one query, not three');
  for (const r of responses) assert.equal(r.status, 200, 'every caller still gets the data');
  assert.equal(contextReadStats.coalesced, 2);
});

// ── honesty: freshness, failures, auth ──────────────────────────────────────

test('freshness is recomputed on every serve, so a memo can never claim FRESH once stale', () => {
  const observedAt = '2026-08-17T12:00:00.000Z';
  const base = Date.parse(observedAt);
  assert.equal(refreshFreshness(envelope(observedAt), base + 60_000).market.freshness, 'FRESH');
  assert.equal(refreshFreshness(envelope(observedAt), base + 5 * 60_000).market.freshness, 'FRESH');
  // Past the collector's 6-minute window the label flips, even for a memoized body.
  assert.equal(refreshFreshness(envelope(observedAt), base + 7 * 60_000).market.freshness, 'STALE');
  // No timestamp at all is MISSING — never silently FRESH.
  assert.equal(refreshFreshness(envelope(null), base).market.freshness, 'MISSING');
  assert.equal(refreshFreshness(envelope('not-a-date'), base).market.freshness, 'MISSING');
});

test('a memoized response ages honestly across serves', async () => {
  const observedAt = '2026-08-17T12:00:00.000Z';
  const base = Date.parse(observedAt);
  const store = countingStore(() => envelope(observedAt));
  const env = { [CONTEXT_CACHE_ENV_FLAG]: '120000' };
  // First serve just inside the 6-minute freshness window, second serve 60s
  // later — still inside the 120s memo TTL, but now past the window. The memo
  // must NOT carry the old FRESH label across.
  const fresh = await read({ store, now: () => base + 350_000, env });
  const later = await read({ store, now: () => base + 410_000, env });
  assert.equal(store.calls, 1, 'still one database read');
  assert.equal((await fresh.json()).market.freshness, 'FRESH');
  assert.equal((await later.json()).market.freshness, 'STALE', 'the memo hit reports the age it actually has');
});

test('a failed read is surfaced, never memoized, and never masked by a good one', async () => {
  const store = { calls: 0, mode: 'ok', getAtomizedMarketContext: async function () { this.calls += 1; return this.mode === 'ok' ? envelope() : { ok: false, reason: 'DB_UNAVAILABLE' }; } };
  const good = await read({ store, now: () => 1_000_000, env: {} });
  assert.equal(good.status, 200);

  store.mode = 'fail';
  const failed = await read({ store, now: () => 1_000_000 + CONTEXT_CACHE_DEFAULT_MS + 1_000, env: {} });   // memo expired
  assert.equal(failed.status, 503, 'the failure reaches the user');
  assert.equal((await failed.json()).reason, 'DB_UNAVAILABLE');
  assert.equal(failed.headers.get('X-Context-Cache'), 'miss', 'a failure is never labelled a cache hit');
  assert.equal(contextReadStats.failures, 1);

  // The failure must not have been stored — the next read tries the database again.
  const before = store.calls;
  const retry = await read({ store, now: () => 1_000_000 + CONTEXT_CACHE_DEFAULT_MS + 2_000, env: {} });
  assert.ok(store.calls > before, 'a failed read is not cached');
  assert.equal(retry.status, 503);
});

test('auth is still enforced before the memo — an unauthenticated caller gets nothing', async () => {
  const store = countingStore();
  await read({ store, now: () => 1_000_000, env: {} });                  // warms the memo
  const denied = await runContextRead(request(), { getIdentity: async () => ({ ok: false }) });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).reason, 'UNAUTHENTICATED');
  // An identity that resolves but is not verified is equally refused.
  const unverified = await runContextRead(request(), { getIdentity: async () => ({ ok: true, verified: false }) });
  assert.equal(unverified.status, 401);
  // A thrown identity check fails closed rather than falling through to the memo.
  const threw = await runContextRead(request(), { getIdentity: async () => { throw new Error('boom'); } });
  assert.equal(threw.status, 401);
});

test('method and preflight handling are unchanged', async () => {
  const post = await runContextRead(request('POST'), { getIdentity: async () => { throw new Error('must not run'); } });
  assert.equal(post.status, 405);
  const options = await runContextRead(request('OPTIONS'), {});
  assert.equal(options.status, 204);
});

// ── TTL resolution ──────────────────────────────────────────────────────────

test('the TTL default is safe and cannot be widened past the collector cycle', () => {
  assert.equal(contextCacheMs({}), CONTEXT_CACHE_DEFAULT_MS, 'unset takes the default');
  assert.equal(contextCacheMs({ [CONTEXT_CACHE_ENV_FLAG]: '' }), CONTEXT_CACHE_DEFAULT_MS, 'blank is not 0');
  assert.equal(contextCacheMs({ [CONTEXT_CACHE_ENV_FLAG]: '   ' }), CONTEXT_CACHE_DEFAULT_MS);
  assert.equal(contextCacheMs({ [CONTEXT_CACHE_ENV_FLAG]: 'abc' }), CONTEXT_CACHE_DEFAULT_MS, 'garbage is not 0');
  assert.equal(contextCacheMs({ [CONTEXT_CACHE_ENV_FLAG]: '-5' }), CONTEXT_CACHE_DEFAULT_MS, 'negative is not 0');
  assert.equal(contextCacheMs({ [CONTEXT_CACHE_ENV_FLAG]: '0' }), 0, 'an explicit 0 really does disable it');
  assert.equal(contextCacheMs({ [CONTEXT_CACHE_ENV_FLAG]: '5000' }), 5000);
  // Never longer than the collector's own 3-minute publish interval.
  assert.equal(contextCacheMs({ [CONTEXT_CACHE_ENV_FLAG]: '999999' }), 180_000);
  assert.ok(CONTEXT_CACHE_DEFAULT_MS <= 180_000);
});

// ── cache headers stay correct ──────────────────────────────────────────────

test('an authenticated read is still never stored by a shared cache', async () => {
  const store = countingStore();
  const res = await read({ store, now: () => 1_000_000, env: {} });
  // The memo lives INSIDE the function. The response itself must remain no-store:
  // this endpoint is behind auth and must never land in a CDN or browser cache.
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Vary'), 'Origin, Authorization');
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.ok(res.headers.get('X-Context-Cache'), 'the memo state is reported for diagnostics');
});
