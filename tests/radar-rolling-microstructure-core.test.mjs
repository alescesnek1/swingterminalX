import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMakerFlag, computeRollingAbsorption } from '../scripts/radar/rolling-microstructure-core.mjs';

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
