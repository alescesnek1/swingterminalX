// Phase 1 honesty guards for Trading RADAR:
//   - distanceToEntryReadyScore === 100 iff a candidate is a real V1/spec ENTRY_READY
//   - the ENTRY_READY banner/list/status are single-sourced from V1 actionability
//   - scanner-only data (no microstructure) can never be Telegram-eligible
//   - missing derivatives/orderbook lower scores and surface in reasons
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateTradingRadar,
  classifyRadarStage,
  evaluateMarketRegime,
} from '../scripts/radar/trading-radar.mjs';

const NOW = new Date('2026-06-12T10:00:00Z').getTime();
const BTC = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70007, spreadPct: 0.01, change24hPct: 1.2 };
const ETH = { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 600e6, bidPrice: 3600, askPrice: 3601, spreadPct: 0.03, change24hPct: 0.8 };
// Full-microstructure flush — passes the V1 gate (becomes a real ENTRY_READY).
const FLUSH = {
  symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 140, askPrice: 140.04, spreadPct: 0.028,
  change24hPct: -9.5, volumeSpike: 2.4, atrPct: 4, longLiquidationSpike: 2.2,
  openInterestChangePct: -7, marketSellRatio: 0.68, fundingRate: -0.01, wickRecoveryPct: 48,
  noNewLowMinutes: 34, rangeFormed: true, sellAggressionFading: true, bidDepthRebuildPct: 14,
  reclaimConfirmed: true, retestHeld: true, shortLiquidationSpike: 1.5, marketBuyVolumeDominance: 0.59,
  vwap: 140, flushLow: 132, depthUsdWithin1Pct: 1_800_000, depthUsd: 2_000_000,
  chain: 'bsc', contractAddress: '0xabc', topHolderPercent: 4, contractVerified: true,
};
// High-scoring scanner-only reclaim row: NO order book / flow / funding / liquidations.
const SCANNER_ONLY = {
  symbol: 'SCANUSDT', score: 9, signal: 'RECLAIM', panic: 84, c1: 2.4, c4: 3.1,
  c12: -7, c24: -10, price: 2, volume: 90_000_000, hot: 90, tags: ['BUY', 'RECLAIM'],
};

function run(extra = {}) {
  return evaluateTradingRadar({ markets: [BTC, ETH, FLUSH], scannerCandidates: [SCANNER_ONLY], source: 'test', now: NOW, ...extra });
}

test('distanceToEntryReadyScore === 100 iff candidate is a real V1 ENTRY_READY', () => {
  const state = run();
  assert.ok(state.candidates.length >= 2);
  for (const c of state.candidates) {
    const is100 = c.distanceToEntryReadyScore === 100;
    const isEntryReady = c.actionability === 'ENTRY_READY';
    assert.equal(is100, isEntryReady, `${c.symbol}: dist=${c.distanceToEntryReadyScore} actionability=${c.actionability}`);
    if (isEntryReady) {
      assert.ok(['EARLY_ENTRY_READY', 'STANDARD_ENTRY_READY', 'AGGRESSIVE_ENTRY_READY'].includes(c.STATUS), `${c.symbol} V1 STATUS=${c.STATUS}`);
    } else {
      assert.ok(c.distanceToEntryReadyScore < 100);
    }
  }
});

test('ENTRY_READY banner/list/status are single-sourced from V1 actionability', () => {
  const state = run();
  // Every entryReady row is a real V1 ENTRY_READY.
  assert.ok(state.entryReady.every((c) => c.actionability === 'ENTRY_READY'));
  // Banner count can only be positive when a real ENTRY_READY candidate exists.
  const anyEntryReady = state.candidates.some((c) => c.actionability === 'ENTRY_READY');
  assert.equal(state.entryReady.length > 0, anyEntryReady);
  // Top status === ENTRY_READY only when a real ENTRY_READY candidate exists.
  assert.equal(state.status === 'ENTRY_READY', anyEntryReady);
});

test('a heuristic stage of SQUEEZE/ENTRY_READY does NOT leak into actionability or distance', () => {
  // The scanner-only row reaches at least SQUEEZE in the heuristic stage machine
  // but lacks execution microstructure, so V1 must keep it below ENTRY_READY.
  const regime = evaluateMarketRegime([BTC, ETH]);
  const heuristic = classifyRadarStage({
    symbol: 'SCANUSDT', scannerScore: 9, scannerSignal: 'RECLAIM', scannerPanic: 84, scannerHot: 90,
    scannerTags: ['BUY', 'RECLAIM'], change1hPct: 2.4, change4hPct: 3.1, change12hPct: -7, change24hPct: -10,
    isScannerContext: true,
  }, regime);
  // The heuristic capped the distance below 100 regardless of its own stage.
  assert.ok(heuristic.distanceToEntryReadyScore <= 97);

  const state = run();
  const scan = state.candidates.find((c) => c.symbol === 'SCANUSDT');
  assert.ok(scan);
  assert.notEqual(scan.actionability, 'ENTRY_READY');
  assert.notEqual(scan.distanceToEntryReadyScore, 100);
});

test('scanner-only data (no microstructure) produces zero Telegram-eligible candidates', () => {
  const state = evaluateTradingRadar({
    markets: [BTC, ETH],
    scannerCandidates: [
      SCANNER_ONLY,
      { symbol: 'AAAUSDT', score: 10, signal: 'RECLAIM', panic: 99, c1: 3, c4: 4, c12: -8, c24: -12, price: 1, volume: 120e6, hot: 99, tags: ['BUY', 'RECLAIM'] },
      { symbol: 'BBBUSDT', score: 8, signal: 'FLUSH+BUY', panic: 70, c1: 1, c4: 1.5, c12: -6, c24: -9, price: 5, volume: 40e6, hot: 80, tags: ['FLUSH', 'BUY'] },
    ],
    source: 'scanner_only', now: NOW,
  });
  const scannerRows = state.candidates.filter((c) => /^(SCAN|AAA|BBB)USDT$/.test(c.symbol));
  assert.ok(scannerRows.length >= 3);
  assert.equal(scannerRows.some((c) => c.telegramEligible === true), false);
  assert.equal(scannerRows.some((c) => c.distanceToEntryReadyScore === 100), false);
  assert.equal(state.entryReady.length, 0);
});

test('missing derivatives are penalised (not treated as safe) and surfaced in reasons', () => {
  const withData = evaluateTradingRadar({ markets: [BTC, ETH, FLUSH], source: 't', now: NOW })
    .candidates.find((c) => c.symbol === 'SOLUSDT');
  const noDerivMarket = { ...FLUSH, fundingRate: undefined, openInterestChangePct: undefined, longLiquidationSpike: undefined, shortLiquidationSpike: undefined };
  const withoutData = evaluateTradingRadar({ markets: [BTC, ETH, noDerivMarket], source: 't', now: NOW })
    .candidates.find((c) => c.symbol === 'SOLUSDT');

  // Removing derivatives data must not score the same as confirmed-healthy derivs.
  assert.ok(withoutData.DERIVATIVES_RISK_SCORE < withData.DERIVATIVES_RISK_SCORE);

  // A scanner-only row must list missing execution microstructure in its reasons.
  const scan = evaluateTradingRadar({ markets: [BTC, ETH], scannerCandidates: [SCANNER_ONLY], source: 't', now: NOW })
    .candidates.find((c) => c.symbol === 'SCANUSDT');
  const reasonText = (scan.REASON || []).join(' | ');
  assert.match(reasonText, /missing data:/);
  assert.match(reasonText + ' ' + (scan.riskFlags || []).join(' '), /orderBookDepth|derivatives|flow|spread/);
});
