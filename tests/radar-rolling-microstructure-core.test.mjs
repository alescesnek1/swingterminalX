import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMakerFlag, computeRollingAbsorption, validateRollingTrades } from '../scripts/radar/rolling-microstructure-core.mjs';

const NOW = 1_700_000_000_000;
const trade = (overrides = {}) => ({ p: 100, q: 1, m: true, T: NOW - 1_000, ...overrides });

test('classifies only explicit Binance maker flags', () => {
  assert.equal(classifyMakerFlag(true), 'sell');
  assert.equal(classifyMakerFlag(false), 'buy');
  assert.equal(classifyMakerFlag(undefined), null);
  assert.equal(classifyMakerFlag('false'), null);
});

test('fails closed for thin, invalid, malformed, and stale trade inputs', () => {
  const invalid = Array.from({ length: 12 }, (_, index) => trade({ m: index % 2 ? undefined : true, p: index === 2 ? 0 : 100, q: index === 3 ? NaN : 1, T: index === 4 ? NaN : NOW - 1_000 }));
  assert.deepEqual(computeRollingAbsorption({ trades: invalid }, NOW), {});
  assert.deepEqual(computeRollingAbsorption({ trades: Array.from({ length: 12 }, () => trade({ T: NOW - 400_000 })) }, NOW), {});
});

test('sorts valid trades by timestamp before evaluating failed aggressive sells', () => {
  const trades = Array.from({ length: 12 }, (_, index) => trade({ m: true, q: 5, p: index < 10 ? 100 : 100.2, T: NOW - (12 - index) * 1_000 })).reverse();
  const fields = computeRollingAbsorption({ trades }, NOW);
  assert.equal(fields.aggressiveSellsFailed, true);
});

test('returns market buy dominance as a ratio in the inclusive 0..1 range', () => {
  const trades = Array.from({ length: 12 }, (_, index) => trade({ m: index % 3 === 0, q: index % 3 === 0 ? 1 : 2, T: NOW - index * 1_000 }));
  const fields = computeRollingAbsorption({ trades }, NOW);
  assert.ok(fields.marketBuyVolumeDominance >= 0 && fields.marketBuyVolumeDominance <= 1);
  assert.ok(fields.marketBuyVolumeDominance > 0.5);
});

test('emits optional fields only from valid supporting evidence', () => {
  const trades = Array.from({ length: 12 }, (_, index) => trade({ m: index % 2 === 0, T: NOW - index * 1_000 }));
  const fields = computeRollingAbsorption({ trades, snapshots: { before: { bidDepth: 100 }, after: { bidDepth: 120 } }, context: { spreadPct: 0.1 } }, NOW);
  assert.equal(fields.bidDepthRebuildPct, 20);
  assert.equal(fields.spreadAndSlippageHealthy, true);
  assert.equal(fields.supportRetestHeld, undefined);
});

// A fixed COUNT of recent trades is not a fixed DURATION: asking for the last N
// trades on a quieter symbol returns a tail older than the measurement window.
// That is normal, not corruption, and must not void the whole measurement.
test('out-of-window trades are discarded, malformed trades reject the sample', () => {
  const now = 1_800_000_000_000;
  const windowMs = 180_000;
  const inWindow = Array.from({ length: 20 }, (_, i) => ({ T: now - (i + 1) * 1000, p: '100', q: '1', m: i % 2 === 0 }));
  const older = Array.from({ length: 40 }, (_, i) => ({ T: now - windowMs - (i + 1) * 1000, p: '100', q: '1', m: true }));

  const mixed = validateRollingTrades([...older, ...inWindow], now, windowMs);
  assert.equal(mixed.malformed, 0, 'nothing here is malformed');
  assert.equal(mixed.outOfWindow, 40);
  assert.equal(mixed.trades.length, 20);
  assert.equal(mixed.invalid, 40, 'invalid stays the total reject count for existing callers');

  // The out-of-window tail must not prevent the absorption fields being computed.
  const absorbed = computeRollingAbsorption({ trades: [...older, ...inWindow], klines: [], snapshots: { before: { bidDepth: 1000 }, after: { bidDepth: 1200 } }, config: { windowMs, minSamples: 10 } }, now);
  assert.ok(Number.isFinite(absorbed.bidDepthRebuildPct), 'absorption is computed from the in-window trades');

  // A genuinely malformed trade still voids everything.
  const corrupt = validateRollingTrades([...inWindow, { T: now - 1000, p: '0', q: '1', m: true }], now, windowMs);
  assert.equal(corrupt.malformed, 1);
  assert.deepEqual(computeRollingAbsorption({ trades: [...inWindow, { T: now - 1000, p: '0', q: '1', m: true }], klines: [], snapshots: { before: { bidDepth: 1000 }, after: { bidDepth: 1200 } }, config: { windowMs, minSamples: 10 } }, now), {});
});
