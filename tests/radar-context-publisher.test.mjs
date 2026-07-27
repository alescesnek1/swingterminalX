import test from 'node:test';
import assert from 'node:assert/strict';
import { runRadarContextPublisher } from '../netlify/functions/_radar-context-publisher.mjs';
import * as radar from '../scripts/radar/trading-radar.mjs';
import * as bridge from '../scripts/radar/collector-absorb-bridge.mjs';
import * as rolling from '../scripts/radar/rolling-microstructure-snapshot.mjs';

const NOW = 1_800_000_000_000;
const OBSERVED = new Date(NOW).toISOString();

function cleanTrades(count = 24, basePrice = 101) {
  const trades = [];
  for (let i = 0; i < count; i += 1) trades.push({ T: NOW - (count - i) * 1000, p: basePrice + (i % 2 === 0 ? 0.01 : -0.01), q: 1 + (i % 3), m: i % 2 === 0 });
  return trades;
}
function klines(count = 40, low = 100, close = 101) {
  const rows = [];
  for (let i = 0; i < count; i += 1) { const openMs = NOW - (count - i) * 60_000; rows.push([openMs, close, close + 1, low, close, 500, openMs + 59_999]); }
  return rows;
}
function tickers() {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push({ market: 'spot', symbol: `C${i}USDT`, last_price: 10 + i, price_change_percent: -5 - (i % 7), high_price: 20 + i, low_price: 9 + i, base_volume: 1e6, quote_volume: 5e7 - i * 1e5, trade_count: 10000 });
  rows.unshift({ market: 'spot', symbol: 'BTCUSDT', last_price: 101, price_change_percent: -6, high_price: 120, low_price: 99, base_volume: 5e5, quote_volume: 9e8, trade_count: 500000 });
  return rows;
}
function fullBundle() {
  return {
    ok: true, run: { id: 42, observedAt: OBSERVED }, previousRun: { id: 41, observedAt: new Date(NOW - 360_000).toISOString() }, windowSec: 360,
    tickers: tickers(),
    microSymbols: [{
      market: 'spot', symbol: 'BTCUSDT', observedAtMs: NOW, windowSec: 360,
      aggTrades: cleanTrades(), klines: klines(),
      bidQuoteDepthBefore: 1_000_000, bidQuoteDepthAfter: 1_150_000, spreadPct: 0.05, depthUsdWithin1Pct: 2_000_000,
      takerBuyQuote: 600_000, takerSellQuote: 400_000,
    }],
  };
}

function fakeStore(capture) {
  return {
    withContextTransaction: async (cb) => cb({}),
    insertRadarRunResult: async (_db, payload) => { capture.payload = payload; return { ok: true, candidateCount: payload.candidates.length }; },
    getRadarInputBundle: async () => { throw new Error('should use injected bundle'); },
  };
}

test('flag disabled → publisher is a no-op', async () => {
  const res = await runRadarContextPublisher({ env: {}, store: fakeStore({}), radar, bridge, rolling, bundle: fullBundle() });
  assert.equal(res.body.skipped, true);
  assert.equal(res.body.reason, 'RADAR_DISABLED');
});

test('no published run → skipped, nothing persisted', async () => {
  const capture = {};
  const res = await runRadarContextPublisher({ env: { MARKET_CONTEXT_RADAR_ENABLED: 'true' }, store: fakeStore(capture), withTransaction: async (cb) => cb({}), radar, bridge, rolling, bundle: { ok: true, run: null } });
  assert.equal(res.body.skipped, true);
  assert.equal(res.body.reason, 'NO_PUBLISHED_RUN');
  assert.equal(capture.payload, undefined);
});

test('full bundle with trusted DB microstructure → persists a ready RADAR result in STRICT mode', async () => {
  const capture = {};
  const res = await runRadarContextPublisher({ env: { MARKET_CONTEXT_RADAR_ENABLED: 'true' }, store: fakeStore(capture), withTransaction: async (cb) => cb({}), radar, bridge, rolling, bundle: fullBundle() });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.skipped, false);
  assert.equal(res.body.runId, 42);
  assert.ok(capture.payload, 'insertRadarRunResult was called');
  assert.equal(capture.payload.status, 'ready');
  assert.ok(Array.isArray(capture.payload.candidates));
  // Trusted DB microstructure present → provider ONLINE and STRICT absorb mode.
  assert.equal(capture.payload.providerStatus.MICROSTRUCTURE_PROVIDER, 'ONLINE');
  assert.equal(capture.payload.providerStatus.ABSORB_MODE, 'STRICT');
  assert.equal(capture.payload.providerStatus.OI_FEED, 'UNSUPPORTED');
  assert.ok(capture.payload.providerStatus.COVERAGE_SYMBOLS >= 1);
});

test('thin microstructure → provider not trusted, STRICT cannot be the mode', async () => {
  const capture = {};
  const bundle = fullBundle();
  bundle.microSymbols[0].aggTrades = cleanTrades(4); // below sample floor
  const res = await runRadarContextPublisher({ env: { MARKET_CONTEXT_RADAR_ENABLED: 'true' }, store: fakeStore(capture), withTransaction: async (cb) => cb({}), radar, bridge, rolling, bundle });
  assert.equal(res.body.ok, true);
  assert.notEqual(capture.payload.providerStatus.ABSORB_MODE, 'STRICT');
  assert.equal(capture.payload.providerStatus.COVERAGE_SYMBOLS, 0);
});

test('rejected microstructure reports a specific reason, never a bare zero', async () => {
  const capture = {};
  const bundle = fullBundle();
  bundle.microSymbols[0].aggTrades = cleanTrades(4); // below sample floor
  await runRadarContextPublisher({ env: { MARKET_CONTEXT_RADAR_ENABLED: 'true' }, store: fakeStore(capture), withTransaction: async (cb) => cb({}), radar, bridge, rolling, bundle });
  const coverage = capture.payload.providerStatus.ABSORB_COVERAGE;
  assert.ok(coverage, 'coverage diagnostics persisted');
  assert.equal(coverage.SUPPLIED_MEASUREMENTS, 1);
  assert.equal(coverage.STRICT_READY, 0);
  // The reason names the failing floor, not just that some floor failed.
  assert.equal(coverage.SYMBOL_STATUS.BTCUSDT, 'samples-thin:aggTrades');
  assert.equal(coverage.REJECTIONS['samples-thin:aggTrades'], 1);
});

test('two venues of one symbol are reported as a collapse, not silently lost', async () => {
  const capture = {};
  const bundle = fullBundle();
  bundle.microSymbols.push({ ...bundle.microSymbols[0], market: 'futures' });
  await runRadarContextPublisher({ env: { MARKET_CONTEXT_RADAR_ENABLED: 'true' }, store: fakeStore(capture), withTransaction: async (cb) => cb({}), radar, bridge, rolling, bundle });
  const coverage = capture.payload.providerStatus.ABSORB_COVERAGE;
  assert.equal(coverage.SUPPLIED_MEASUREMENTS, 2);
  assert.equal(coverage.BRIDGE_MEASURED, 2);
  assert.equal(coverage.DISTINCT_SYMBOLS, 1);
  assert.equal(coverage.COLLAPSED_DUPLICATES, 1);
});

// Regression: a run's observed_at is stamped when collection STARTS, but request
// pacing makes a cycle take a minute or more. Measurements taken near the end are
// then newer than it, and the trusted-row validator — which tolerates only 60s of
// clock skew — rejected EVERY symbol as 'measurement-stale'. Live: trustedMicro 0
// with every symbol reporting that reason.
test('a long collection cycle does not make its own measurements look stale', async () => {
  const capture = {};
  const bundle = fullBundle();
  const lateMs = NOW + 95_000; // measured 95s after the run started
  bundle.microSymbols[0].observedAtMs = lateMs;
  bundle.microSymbols[0].windowSec = 360;
  const res = await runRadarContextPublisher({ env: { MARKET_CONTEXT_RADAR_ENABLED: 'true' }, store: fakeStore(capture), withTransaction: async (cb) => cb({}), radar, bridge, rolling, bundle });
  assert.equal(res.body.ok, true);
  const coverage = capture.payload.providerStatus.ABSORB_COVERAGE;
  assert.equal(coverage.SYMBOL_STATUS.BTCUSDT, 'READY', 'the late measurement is still trusted');
  assert.equal(capture.payload.providerStatus.ABSORB_MODE, 'STRICT');
});

// Regression: the reclaim evaluator looks up its source levels under the
// scanner's field names (high_24h / low_24h). Emitting only camelCase
// highPrice/lowPrice meant it found NO source field, so every canonical
// candidate reported "no reclaim data" despite carrying a full 24h range.
test('canonical tickers expose the reclaim source fields under the names it reads', async () => {
  const capture = {};
  const bundle = fullBundle();
  await runRadarContextPublisher({ env: { MARKET_CONTEXT_RADAR_ENABLED: 'true' }, store: fakeStore(capture), withTransaction: async (cb) => cb({}), radar, bridge, rolling, bundle });
  const btc = capture.payload.candidates.find((c) => c.symbol === 'BTCUSDT');
  assert.ok(btc, 'BTCUSDT is a candidate');
  assert.notEqual(btc.RECLAIM_SOURCE_DATA_STATUS, 'RECLAIM_DATA_SOURCE_MISSING');
  // Safety resolves from the listing axis alone — no chain metadata needed.
  assert.equal(btc.safetyStatus, 'SAFE');
});

// Regression: the RADAR's own snapshot staleness check is `updatedAtMs > now + 60s`.
// Passing the run's START time while evaluating data completed ~94s later marked
// the entire snapshot STALE, which the matrix renders as "DATA OFF" on every row.
test('a long cycle does not mark its own rolling snapshot STALE (matrix "DATA OFF")', async () => {
  const capture = {};
  const bundle = fullBundle();
  bundle.microSymbols[0].observedAtMs = NOW + 95_000;
  await runRadarContextPublisher({ env: { MARKET_CONTEXT_RADAR_ENABLED: 'true' }, store: fakeStore(capture), withTransaction: async (cb) => cb({}), radar, bridge, rolling, bundle });
  const btc = capture.payload.candidates.find((c) => c.symbol === 'BTCUSDT');
  assert.ok(btc, 'BTCUSDT is a candidate');
  assert.notEqual(btc.STRICT_ABSORB_STATUS, 'ABSORB_DATA_STALE');
  assert.notEqual(btc.ABSORB_STATUS, 'ABSORB_DATA_STALE');
});
