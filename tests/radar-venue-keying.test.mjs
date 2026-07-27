import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRollingKey, rollingKeyFor,
  normalizeRollingMicrostructureSnapshot, getFreshRollingMicrostructureForSymbol,
} from '../scripts/radar/rolling-microstructure-snapshot.mjs';
import { normalizeKlinesSnapshot, getFreshClosedKlinesForSymbol, klinesKeyFor } from '../scripts/radar/klines-snapshot.mjs';

// Spot and futures are different books, different flow, different depth. Keyed by
// symbol alone, one measurement silently replaced the other AND could be handed to a
// candidate on the opposite venue — a WRONG execution reading, not a missing one.
// Fail-closed here means: when the requested venue was not measured, answer nothing.

const NOW = 1_800_000_000_000;

// ── key parsing ─────────────────────────────────────────────────────────────
test('a key may be venue-qualified or bare, and junk venues are refused', () => {
  assert.deepEqual(parseRollingKey('spot:BTCUSDT'), { key: 'spot:BTCUSDT', symbol: 'BTCUSDT', market: 'spot' });
  assert.deepEqual(parseRollingKey('FUTURES:ethusdt'), { key: 'futures:ETHUSDT', symbol: 'ETHUSDT', market: 'futures' });
  // Bare keys stay supported: the futures producer and legacy static snapshots emit
  // them, and dropping them would silently lose those feeds.
  assert.deepEqual(parseRollingKey('BTCUSDT'), { key: 'BTCUSDT', symbol: 'BTCUSDT', market: null });
  for (const bad of ['margin:BTCUSDT', 'spot:', 'spot:BTC-USDT', ':BTCUSDT', '', 'spot:!!!']) {
    assert.equal(parseRollingKey(bad), null, `${bad} is refused`);
  }
});

test('key builders fall back to a bare key when the venue is not a real venue', () => {
  assert.equal(rollingKeyFor('spot', 'btcusdt'), 'spot:BTCUSDT');
  assert.equal(rollingKeyFor('margin', 'BTCUSDT'), 'BTCUSDT');
  assert.equal(rollingKeyFor('spot', '!!!'), null);
  assert.equal(klinesKeyFor('futures', 'ethusdt'), 'futures:ETHUSDT');
  assert.equal(klinesKeyFor(null, 'ETHUSDT'), 'ETHUSDT');
});

// ── microstructure: no cross-venue substitution ─────────────────────────────
function microRow(overrides = {}) {
  return {
    market: 'spot', rollingWindowSec: 360, rollingMeasuredAtMs: NOW,
    samples: { aggTrades: 40, depthSnapshots: 2, klines: 40 },
    validation: { makerFlagsValid: true, tradesValidated: true, tradesSorted: true, klinesValidated: true },
    source: 'netlify-atomic-collector',
    absorptionScore: 60, bidDepthRebuildPct: 12, aggressiveSellsFailed: true, deltaImprovementPct: 5,
    marketBuyVolumeDominance: 0.6, supportRetestHeld: true, spreadAndSlippageHealthy: true,
    marketSellRatio: 0.4, spreadPct: 0.05, depthUsdWithin1Pct: 2_000_000,
    flow: { takerBuySellRatio: 1.5, cumulativeDeltaPct: 20, aggressiveSellExhaustion: true },
    ...overrides,
  };
}
const microSnapshot = (data) => ({ provider: 'netlify-atomic-collector', trusted: true, updatedAtMs: NOW, ttlMs: 600_000, data });

test('both venues of one symbol survive normalization under their own keys', () => {
  const normalized = normalizeRollingMicrostructureSnapshot(microSnapshot({
    'spot:BTCUSDT': microRow({ absorptionScore: 60 }),
    'futures:BTCUSDT': microRow({ market: 'futures', absorptionScore: 90 }),
  }), { nowMs: NOW });
  assert.equal(Object.keys(normalized.data).length, 2, 'neither venue overwrote the other');
  assert.equal(normalized.data['spot:BTCUSDT'].absorptionScore, 60);
  assert.equal(normalized.data['futures:BTCUSDT'].absorptionScore, 90);
});

test('a venue-scoped lookup returns that venue and never the other one', () => {
  const snapshot = microSnapshot({
    'spot:BTCUSDT': microRow({ absorptionScore: 60 }),
    'futures:BTCUSDT': microRow({ market: 'futures', absorptionScore: 90 }),
  });
  assert.equal(getFreshRollingMicrostructureForSymbol(snapshot, 'BTCUSDT', { nowMs: NOW, market: 'spot' }).absorptionScore, 60);
  assert.equal(getFreshRollingMicrostructureForSymbol(snapshot, 'BTCUSDT', { nowMs: NOW, market: 'futures' }).absorptionScore, 90);
});

test('asking for a venue that was not measured yields nothing, not the other venue', () => {
  // THE bug this fixes: a spot candidate must not be scored on futures depth/flow.
  const futuresOnly = microSnapshot({ 'futures:BTCUSDT': microRow({ market: 'futures' }) });
  assert.equal(getFreshRollingMicrostructureForSymbol(futuresOnly, 'BTCUSDT', { nowMs: NOW, market: 'spot' }), null);
  const spotOnly = microSnapshot({ 'spot:BTCUSDT': microRow() });
  assert.equal(getFreshRollingMicrostructureForSymbol(spotOnly, 'BTCUSDT', { nowMs: NOW, market: 'futures' }), null);
});

test('a bare-keyed row is usable only when it does not claim a different venue', () => {
  // Legacy/static snapshots carry no venue — still usable for either venue.
  const unlabelled = microSnapshot({ BTCUSDT: microRow({ market: undefined }) });
  assert.ok(getFreshRollingMicrostructureForSymbol(unlabelled, 'BTCUSDT', { nowMs: NOW, market: 'spot' }));
  assert.ok(getFreshRollingMicrostructureForSymbol(unlabelled, 'BTCUSDT', { nowMs: NOW, market: 'futures' }));
  // But a bare key whose ROW says futures must not answer a spot question.
  const mislabelled = microSnapshot({ BTCUSDT: microRow({ market: 'futures' }) });
  assert.equal(getFreshRollingMicrostructureForSymbol(mislabelled, 'BTCUSDT', { nowMs: NOW, market: 'spot' }), null);
  assert.ok(getFreshRollingMicrostructureForSymbol(mislabelled, 'BTCUSDT', { nowMs: NOW, market: 'futures' }));
});

test('with no venue requested, an ambiguous symbol resolves to nothing rather than a guess', () => {
  const both = microSnapshot({ 'spot:BTCUSDT': microRow(), 'futures:BTCUSDT': microRow({ market: 'futures' }) });
  assert.equal(getFreshRollingMicrostructureForSymbol(both, 'BTCUSDT', { nowMs: NOW }), null, 'two venues, no venue asked → no guess');
  // One venue only is unambiguous, so the legacy call style keeps working.
  const one = microSnapshot({ 'spot:BTCUSDT': microRow() });
  assert.ok(getFreshRollingMicrostructureForSymbol(one, 'BTCUSDT', { nowMs: NOW }));
});

// ── klines / reclaim: the same defect class ─────────────────────────────────
function candles(count, close) {
  const rows = [];
  for (let i = 0; i < count; i += 1) { const open = NOW - (count - i) * 60_000; rows.push([open, close, close + 1, close - 1, close, 500, open + 59_999]); }
  return rows;
}
const klinesSnapshot = (data) => ({ timeframe: '1m', updatedAtMs: NOW, data });

test('candle series are venue-scoped too, so reclaim cannot use the wrong venue', () => {
  const snapshot = klinesSnapshot({ 'spot:BTCUSDT': candles(40, 100), 'futures:BTCUSDT': candles(40, 200) });
  const normalized = normalizeKlinesSnapshot(snapshot, { nowMs: NOW });
  assert.equal(Object.keys(normalized.data).length, 2, 'neither series overwrote the other');
  const spot = getFreshClosedKlinesForSymbol(snapshot, 'BTCUSDT', { nowMs: NOW, minCandles: 30, market: 'spot' });
  const futures = getFreshClosedKlinesForSymbol(snapshot, 'BTCUSDT', { nowMs: NOW, minCandles: 30, market: 'futures' });
  assert.equal(spot.at(-1).close, 100);
  assert.equal(futures.at(-1).close, 200);
});

test('an unmeasured venue returns no candles rather than the other venue series', () => {
  const futuresOnly = klinesSnapshot({ 'futures:BTCUSDT': candles(40, 200) });
  assert.equal(getFreshClosedKlinesForSymbol(futuresOnly, 'BTCUSDT', { nowMs: NOW, minCandles: 30, market: 'spot' }), null);
  // A bare key remains readable for any venue (legacy producers emit bare keys).
  const bare = klinesSnapshot({ BTCUSDT: candles(40, 150) });
  assert.ok(getFreshClosedKlinesForSymbol(bare, 'BTCUSDT', { nowMs: NOW, minCandles: 30, market: 'spot' }));
});
