import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';
import { POSITIONING_STALE_TTL_MS } from '../scripts/radar/positioning-context.mjs';

const NOW = 1_700_000_000_000;

function market(symbol = 'BEATUSDT') {
  return {
    symbol,
    status: 'TRADING',
    lastPrice: 1,
    quoteVolume24h: 50_000_000,
    priceChangePercent: -8,
    change1hPct: 2,
    high_24h: 1.2,
    low_24h: 0.8,
    orderBookDepthWithin1Pct: 500_000,
    depthUsdWithin1Pct: 500_000,
    spreadPct: 0.02,
    fundingRate: 0.01,
    openInterestChangePct: 3,
    marketSellRatio: 0.45,
    bidDepthRebuildPct: 8,
    flow: { takerBuySellRatio: 1.2, cumulativeDeltaPct: 2, aggressiveSellExhaustion: true },
    rollingMicrostructureUpdatedAtMs: NOW - 60_000,
  };
}

function longShortSnapshot(updatedAt = NOW - 60_000) {
  return {
    source: 'binance-futures-data',
    contextOnly: true,
    updatedAt: new Date(updatedAt).toISOString(),
    period: '5m',
    topN: 20,
    symbols: {
      BEATUSDT: {
        contextOnly: true,
        source: 'binance-futures-data',
        symbol: 'BEATUSDT',
        period: '5m',
        updatedAt: new Date(updatedAt).toISOString(),
        stale: updatedAt < NOW - POSITIONING_STALE_TTL_MS,
        available: updatedAt >= NOW - POSITIONING_STALE_TTL_MS,
        topTraderPositionRatio: 1.8,
        globalAccountRatio: 1.2,
        takerBuySellRatio: 0.9,
        interpretation: 'balanced',
        warnings: [],
        missing: [],
      },
    },
  };
}

function candidate(state) {
  return state.candidates.find((c) => c.symbol === 'BEATUSDT');
}

test('candidate receives compact long/short context when snapshot is available', () => {
  const without = candidate(evaluateTradingRadar({ markets: [market()], now: NOW }));
  const withLs = candidate(evaluateTradingRadar({ markets: [market()], now: NOW, longShortSnapshot: longShortSnapshot() }));

  assert.equal(without.positioningContext.longShort.globalAccountRatio, null);
  assert.equal(withLs.positioningContext.longShort.globalAccountRatio, 1.2);
  assert.equal(withLs.positioningContext.longShort.topTraderPositionRatio, 1.8);
  assert.equal(withLs.positioningContext.longShort.takerBuySellRatio, 0.9);
  assert.equal(withLs.positioningContext.longShort.interpretation, 'balanced');
  assert.equal(withLs.positioningContext.contextOnly, true);
});

test('missing or stale long/short snapshot stays unavailable/missing and does not change gates or scores', () => {
  const base = candidate(evaluateTradingRadar({ markets: [market()], now: NOW }));
  const stale = candidate(evaluateTradingRadar({ markets: [market()], now: NOW, longShortSnapshot: longShortSnapshot(NOW - POSITIONING_STALE_TTL_MS - 1) }));
  const fresh = candidate(evaluateTradingRadar({ markets: [market()], now: NOW, longShortSnapshot: longShortSnapshot() }));

  assert.equal(stale.positioningContext.longShort.globalAccountRatio, null);
  assert.ok(stale.positioningContext.missing.includes('longShortRatio'));
  assert.ok(stale.tradeReadiness.missing.includes('positioning'));

  for (const key of ['actionability', 'STATUS', 'confidence', 'setupQualityScore', 'distanceToEntryReadyScore', 'telegramEligible']) {
    assert.deepEqual(fresh[key], base[key], `${key} must not change`);
    assert.deepEqual(stale[key], base[key], `${key} must not change for stale long/short`);
  }
  assert.deepEqual(fresh.scores, base.scores);
  assert.deepEqual(stale.scores, base.scores);
});

test('RADAR source guard: long/short wiring has no fetch, order, execution, or Telegram dependency', () => {
  const source = readFileSync(new URL('../scripts/radar/trading-radar.mjs', import.meta.url), 'utf8');
  const helperMatch = source.match(/function longShortContextForMarket\(market, longShortSnapshot, nowMs = Date\.now\(\)\) \{[\s\S]*?\r?\n\}/);
  assert.ok(helperMatch, 'longShortContextForMarket helper exists');
  const helper = helperMatch[0];
  assert.doesNotMatch(helper, /fetch\s*\(|\/order|\/sapi|\/dapi|signature|apiKey|apiSecret/i);
  assert.doesNotMatch(helper, /telegram|execution-intent|executionIntents/i);
  assert.doesNotMatch(helper, /Coinee|liquidation heatmap|CVD|whale orders|confirmed liquidation|guaranteed absorption|retail sentiment truth/i);
});
