import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';

const NOW = new Date('2026-06-12T10:00:00Z').getTime();
const SAFE_META = { chain: 'bsc', contractAddress: '0xabc', topHolderPercent: 4, contractVerified: true };
const BTC = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70007, spreadPct: 0.01, change24hPct: 1.2, depthUsdWithin1Pct: 5e6, depthUsd: 5e6 };
const ETH = { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 600e6, bidPrice: 3600, askPrice: 3601, spreadPct: 0.03, change24hPct: 0.8, depthUsdWithin1Pct: 4e6, depthUsd: 4e6 };
const FULL_MICRO_ENTRY = {
  symbol: 'HISTUSDT', baseAsset: 'HIST', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 100, askPrice: 100.04, spreadPct: 0.03,
  change24hPct: -12, change12hPct: -8, change4hPct: 2, change1hPct: 1.2,
  volumeSpike: 2.5, atrPct: 4, longLiquidationSpike: 2.1, shortLiquidationSpike: 1.5,
  openInterestChangePct: -7, marketSellRatio: 0.54, fundingRate: -0.01,
  wickRecoveryPct: 50, noNewLowMinutes: 40, rangeFormed: true, sellAggressionFading: true,
  reclaimConfirmed: true, vwapHeld: true, higherLowHeld: true, higherLow: 98, vwap: 100,
  flushLow: 92, rangeHigh: 100, nearestSupply: 108, nextSupply: 114, meanReversionTarget: 120,
  computedBreakdownLevel: 100, depthUsdWithin1Pct: 2e6, depthUsd: 2e6,
  bidDepthRebuildPct: 14, marketBuyVolumeDominance: 0.59, retestHeld: true,
  ...SAFE_META,
};

function historyContext(extra = {}) {
  return {
    status: 'OK',
    reclaim: { status: 'CONFIRMED' },
    absorption: { status: 'CONFIRMED', mode: 'history_only', confidence: 'medium' },
    ...extra,
  };
}

function candidate(row) {
  const state = evaluateTradingRadar({ markets: [BTC, ETH, row], source: 'price-history-score-test', now: NOW });
  const found = state.candidates.find((item) => item.symbol === row.symbol);
  assert.ok(found, 'fixture candidate must be evaluated');
  return found;
}

test('price history adds at most +3 setup corroboration and exposes its provenance', () => {
  const baseline = candidate(FULL_MICRO_ENTRY);
  const supported = candidate({ ...FULL_MICRO_ENTRY, priceHistoryContext: historyContext() });
  assert.equal(supported.priceHistoryScoreAdjustment, 3);
  assert.equal(supported.PRICE_HISTORY_SCORE_ADJUSTMENT, 3);
  assert.equal(supported.priceHistoryUsedForScoring, true);
  assert.deepEqual(supported.priceHistoryGateSupport, { reclaim: true, absorption: true });
  assert.equal(supported.SETUP_SCORE, Math.min(100, baseline.SETUP_SCORE + 3));
  assert.equal(supported.STRICT_ABSORB_CONFIRMED, baseline.STRICT_ABSORB_CONFIRMED);
  assert.equal(supported.telegramEligible, baseline.telegramEligible);
});

test('confirmed reclaim and history-only absorption remain independently bounded', () => {
  const reclaimOnly = candidate({
    ...FULL_MICRO_ENTRY,
    priceHistoryContext: historyContext({
      absorption: { status: 'NOT_CONFIRMED', mode: 'history_only', confidence: 'medium' },
    }),
  });
  const absorptionOnly = candidate({
    ...FULL_MICRO_ENTRY,
    priceHistoryContext: historyContext({ reclaim: { status: 'NOT_CONFIRMED' } }),
  });
  assert.equal(reclaimOnly.priceHistoryScoreAdjustment, 2);
  assert.deepEqual(reclaimOnly.priceHistoryGateSupport, { reclaim: true, absorption: false });
  assert.equal(absorptionOnly.priceHistoryScoreAdjustment, 1);
  assert.deepEqual(absorptionOnly.priceHistoryGateSupport, { reclaim: false, absorption: true });
});
test('unknown price history is zero support and stays explicitly visible', () => {
  const baseline = candidate(FULL_MICRO_ENTRY);
  const unknown = candidate({ ...FULL_MICRO_ENTRY, priceHistoryContext: { status: 'DB_UNAVAILABLE' } });
  assert.equal(unknown.priceHistoryScoreAdjustment, 0);
  assert.equal(unknown.priceHistoryUsedForScoring, false);
  assert.equal(unknown.SETUP_SCORE, baseline.SETUP_SCORE);
  assert.match(unknown.priceHistoryGateBlockers.join(' '), /DB_UNAVAILABLE/);
});

test('an explicit existing reclaim failure rejects history reclaim support but keeps only the capped proxy absorption point', () => {
  const failed = candidate({ ...FULL_MICRO_ENTRY, reclaimLost: true, priceHistoryContext: historyContext() });
  assert.equal(failed.priceHistoryScoreAdjustment, 1);
  assert.deepEqual(failed.priceHistoryGateSupport, { reclaim: false, absorption: true });
  assert.match(failed.priceHistoryGateBlockers.join(' '), /explicitly failed/);
  assert.equal(failed.STRICT_ABSORB_CONFIRMED, false);
});

test('history-only context cannot manufacture strict absorption, missing execution inputs, or an entry', () => {
  const sparse = candidate({
    ...FULL_MICRO_ENTRY,
    symbol: 'SPARSEHISTUSDT',
    depthUsd: undefined,
    depthUsdWithin1Pct: undefined,
    marketBuyVolumeDominance: undefined,
    fundingRate: undefined,
    openInterestChangePct: undefined,
    longLiquidationSpike: undefined,
    shortLiquidationSpike: undefined,
    priceHistoryContext: historyContext(),
  });
  assert.equal(sparse.STRICT_ABSORB_CONFIRMED, false);
  assert.ok(sparse.executionDataMissing.includes('derivatives'));
  assert.ok(sparse.executionDataMissing.includes('flow'));
  assert.notEqual(sparse.entryReadyV1, true);
  assert.equal(sparse.telegramEligible, false);
});