// Manual-refresh freshness hotfix — backend contract for the PUBLIC market read.
//
// Two layers:
//   1. Real behaviour of the pure helpers the handler relies on
//      (isForceRefreshRequest / freshnessVerdict / age-aware
//      buildFreshnessMeta) — imported and executed directly.
//   2. Source-level wiring assertions on markets.js (a Deno edge function:
//      network + Deno globals, so it cannot be imported here), consistent
//      with how backend.markets-freshness.test.mjs already guards it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildFreshnessMeta,
  freshnessVerdict,
  isForceRefreshRequest,
  MARKET_MAX_AGE_MS,
  SERVED_LIVE,
  SERVED_STALE,
  STALE_REASON_AGE,
  STALE_REASON_NO_TIMESTAMP,
  STALE_REASON_SERVED_FROM,
} from '../apps/edge/netlify/edge-functions/lib/freshness.js';

const marketsSrc = fs.readFileSync(
  new URL('../apps/edge/netlify/edge-functions/markets.js', import.meta.url),
  'utf8',
);

const fakeReq = (url, headers = {}) => ({
  url,
  headers: { get: (k) => (Object.prototype.hasOwnProperty.call(headers, k) ? headers[k] : null) },
});

// ── force detection ──────────────────────────────────────────

test('force is detected from the query string', () => {
  assert.equal(isForceRefreshRequest(fakeReq('https://x/api/markets?force=1')), true);
  assert.equal(isForceRefreshRequest(fakeReq('https://x/api/markets?force=true')), true);
});

test('force is detected from the X-Force-Refresh header', () => {
  assert.equal(isForceRefreshRequest(fakeReq('https://x/api/markets', { 'X-Force-Refresh': '1' })), true);
});

test('a normal poll is NOT a force refresh', () => {
  assert.equal(isForceRefreshRequest(fakeReq('https://x/api/markets')), false);
  assert.equal(isForceRefreshRequest(fakeReq('https://x/api/markets?force=0')), false);
  assert.equal(isForceRefreshRequest(fakeReq('https://x/api/markets?other=1')), false);
});

test('force detection never throws on a malformed request', () => {
  assert.equal(isForceRefreshRequest(null), false);
  assert.equal(isForceRefreshRequest({}), false);
  assert.equal(isForceRefreshRequest({ url: 'not a url', headers: {} }), false);
});

// ── age-aware staleness ──────────────────────────────────────

test('a live snapshot older than the age budget is STALE, not live', () => {
  const now = 10_000_000;
  const v = freshnessVerdict({
    servedFrom: SERVED_LIVE,
    generatedAt: now - (MARKET_MAX_AGE_MS + 1),
    now,
    maxAgeMs: MARKET_MAX_AGE_MS,
  });
  assert.equal(v.stale, true);
  assert.equal(v.reason, STALE_REASON_AGE);
});

test('a live snapshot inside the age budget stays live', () => {
  const now = 10_000_000;
  const v = freshnessVerdict({ servedFrom: SERVED_LIVE, generatedAt: now - 5_000, now, maxAgeMs: MARKET_MAX_AGE_MS });
  assert.equal(v.stale, false);
  assert.equal(v.reason, null);
});

test('a missing snapshot timestamp fails closed to STALE when a budget is set', () => {
  const v = freshnessVerdict({ servedFrom: SERVED_LIVE, generatedAt: null, maxAgeMs: MARKET_MAX_AGE_MS });
  assert.equal(v.stale, true);
  assert.equal(v.reason, STALE_REASON_NO_TIMESTAMP);
});

test('served-from beats age: a stale-memory snapshot is stale at any age', () => {
  const now = 10_000_000;
  const v = freshnessVerdict({ servedFrom: SERVED_STALE, generatedAt: now, now, maxAgeMs: MARKET_MAX_AGE_MS });
  assert.equal(v.stale, true);
  assert.equal(v.reason, STALE_REASON_SERVED_FROM);
});

test('buildFreshnessMeta exposes the age verdict + a reason header', () => {
  const now = 10_000_000;
  const meta = buildFreshnessMeta({
    servedFrom: SERVED_LIVE,
    generatedAt: now - (MARKET_MAX_AGE_MS + 60_000),
    now,
    maxAgeMs: MARKET_MAX_AGE_MS,
  });
  assert.equal(meta.stale, true);
  assert.equal(meta.staleReason, STALE_REASON_AGE);
});

test('the age test stays OPT-IN so existing callers are unchanged', () => {
  const now = 10_000_000;
  const meta = buildFreshnessMeta({ servedFrom: SERVED_LIVE, generatedAt: now - 3_600_000, now });
  assert.equal(meta.stale, false, 'no maxAgeMs → no age demotion (legacy behaviour)');
  assert.equal(meta.staleReason, null);
});

// ── handler wiring ───────────────────────────────────────────

test('markets handler consults the force flag', () => {
  assert.match(marketsSrc, /const force = isForceRefreshRequest\(request\)/);
});

test('force is parsed AFTER origin + auth, so it cannot skip a gate', () => {
  const authIdx = marketsSrc.indexOf('const auth = await verifyAuth(request)');
  const forceIdx = marketsSrc.indexOf('const force = isForceRefreshRequest(request)');
  assert.ok(authIdx > 0 && forceIdx > 0);
  assert.ok(forceIdx > authIdx, 'force must be read after the auth gate');
});

test('a forced read bypasses the in-isolate response cache', () => {
  assert.match(marketsSrc, /if \(\(force && !forceThrottled\) \|\| !cacheUsable\)/);
});

test('a forced read is answered no-store so no cache layer can replay it', () => {
  assert.match(marketsSrc, /function noStoreHeaders/);
  assert.match(marketsSrc, /'Cache-Control': 'no-store, no-cache, must-revalidate'/);
  assert.match(marketsSrc, /\.\.\.\(force \? noStoreHeaders\(request\) : cacheHeaders\(request\)\)/);
});

test('the stale last-good fallback is no longer CDN-cacheable', () => {
  // It used to go out with `public, s-maxage=30` + only `Vary: Origin`, so a
  // frozen body was parked in the CDN and replayed across tiers.
  assert.match(marketsSrc, /const staleHeaders = \{ \.\.\.noStoreHeaders\(request\), 'X-Tier': tier/);
});

test('forced rebuilds are bounded so click-mashing cannot hammer upstream', () => {
  assert.match(marketsSrc, /FORCE_REBUILD_MIN_INTERVAL_MS/);
  assert.match(marketsSrc, /const forceThrottled = force && \(now - _lastForcedBuildAt < FORCE_REBUILD_MIN_INTERVAL_MS\)/);
  // Concurrent forced clicks still collapse onto ONE upstream fan-out.
  assert.match(marketsSrc, /buildMarketsBodyDeduped\(\)/);
});

test('the force outcome is reported back, not silently swallowed', () => {
  assert.match(marketsSrc, /X-Force-Refresh'\] = forcedRebuild \? FORCE_OUTCOME_REBUILT : FORCE_OUTCOME_THROTTLED/);
  assert.match(marketsSrc, /const FORCE_OUTCOME_REBUILT = 'rebuilt';/);
  assert.match(marketsSrc, /const FORCE_OUTCOME_THROTTLED = 'throttled';/);
  assert.match(marketsSrc, /console\.warn\('\[MARKETS\] force refresh'/);
});

test('the live path applies the age budget', () => {
  assert.match(marketsSrc, /generatedAt: bundle\.at, now, maxAgeMs: MARKET_MAX_AGE_MS/);
});

test('force is confined to the public market read — no DB collector reads it', () => {
  const dbBacked = [
    'netlify/functions/_market-context-collector.mjs',
    'netlify/functions/_price-history-writer.mjs',
    'netlify/functions/context.mjs',
  ];
  for (const rel of dbBacked) {
    const src = fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /isForceRefreshRequest|X-Force-Refresh/, rel + ' must not honour a force bypass');
  }
});
