import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { checkBscScanTokenSafety, evaluateKnownSafety } from '../scripts/safety/chain-safety.mjs';
import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';
import { evaluateTradeCockpit, summarizeCockpit } from '../scripts/cockpit/trade-cockpit.mjs';

const ROOT = new URL('../', import.meta.url);

test('Version X branding is visible in active UI files', () => {
  const html = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /Swing Terminal Version X/);
  assert.match(html, /TERMINAL X/);
  assert.match(html, /TRADE TRACKER COCKPIT/);
  assert.doesNotMatch(html, /SWING TERMINAL V6|Terminal V6">V6/);
});

test('mobile heatmap draw path contains symbol, numeric percent, and secondary volume rendering', () => {
  const js = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
  assert.match(js, /c\.toFixed\(1\) \+ '%'/);
  assert.match(js, /_hmFmtCap\(Number\(r\.d\.total_volume\)/);
  assert.match(js, /r\.h > 24 && r\.w > 28/);
});

test('Safety adapter is honest for missing key, missing contract, and high holder concentration', async () => {
  const noKey = await checkBscScanTokenSafety({ chain: 'bsc', contractAddress: '0xabc', apiKey: '' });
  assert.equal(noKey.safetyStatus, 'UNKNOWN');
  assert.match(noKey.reasons.join(' '), /API key unavailable/);

  const noContract = await checkBscScanTokenSafety({ chain: 'bsc', apiKey: 'fake' });
  assert.equal(noContract.safetyStatus, 'UNKNOWN');
  assert.match(noContract.reasons.join(' '), /missing contract/);

  const whale = evaluateKnownSafety({
    chain: 'bsc',
    contractAddress: '0xabc',
    topHolderPercent: 38,
    contractVerified: true,
  });
  assert.equal(whale.safetyStatus, 'DANGER');
  assert.equal(whale.holderConcentrationRisk, 'HIGH');
});

function radarMarket(extra = {}) {
  return {
    symbol: 'SIRENUSDT',
    baseAsset: 'SIREN',
    quoteAsset: 'USDT',
    status: 'TRADING',
    quoteVolume24h: 300e6,
    bidPrice: 10,
    askPrice: 10.002,
    spreadPct: 0.02,
    change24hPct: -10,
    change12hPct: -8,
    change4hPct: 2,
    change1hPct: 1.4,
    volumeSpike: 2.5,
    atrPct: 4,
    longLiquidationSpike: 2.1,
    shortLiquidationSpike: 1.4,
    openInterestChangePct: -6,
    marketSellRatio: 0.52,
    fundingRate: -0.01,
    wickRecoveryPct: 45,
    noNewLowMinutes: 45,
    rangeFormed: true,
    sellAggressionFading: true,
    bidDepthRebuildPct: 16,
    reclaimConfirmed: true,
    retestHeld: true,
    higherLowHeld: true,
    marketBuyVolumeDominance: 0.59,
    vwap: 9.8,
    flushLow: 8.6,
    higherLow: 9.35,
    depthUsdWithin1Pct: 2_000_000,
    depthUsd: 2_000_000,
    chain: 'bsc',
    contractAddress: '0xabc',
    topHolderPercent: 4,
    contractVerified: true,
    ...extra,
  };
}

test('RADAR v1 exposes required scores and DANGER safety blocks entry-ready status', () => {
  const state = evaluateTradingRadar({
    markets: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70001, spreadPct: 0.01, depthUsdWithin1Pct: 5e6, change24hPct: 1 },
      { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', quoteVolume24h: 700e6, bidPrice: 3500, askPrice: 3501, spreadPct: 0.01, depthUsdWithin1Pct: 4e6, change24hPct: 0.8 },
      radarMarket(),
    ],
    now: new Date('2026-06-15T10:00:00Z').getTime(),
  });
  const c = state.candidates.find((x) => x.symbol === 'SIRENUSDT');
  for (const key of ['DISLOCATION_SCORE', 'FLUSH_SCORE', 'STABILIZATION_SCORE', 'RECLAIM_SCORE', 'ORDER_BOOK_SUPPORT_SCORE', 'FLOW_CONFIRMATION_SCORE', 'DERIVATIVES_RISK_SCORE', 'MARKET_REGIME_SCORE', 'RISK_REWARD_SCORE', 'SETUP_SCORE', 'EXECUTION_SCORE', 'FINAL_CONFIDENCE']) {
    assert.equal(Number.isFinite(Number(c[key])), true, `${key} missing`);
  }
  assert.ok(c.STOP_REFERENCE && !/percent-only/i.test(c.STOP_REFERENCE));
  assert.equal(c.TAKE_PROFIT_LEVELS.length, 3);

  const danger = evaluateTradingRadar({
    markets: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70001, spreadPct: 0.01, depthUsdWithin1Pct: 5e6, change24hPct: 1 },
      { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', quoteVolume24h: 700e6, bidPrice: 3500, askPrice: 3501, spreadPct: 0.01, depthUsdWithin1Pct: 4e6, change24hPct: 0.8 },
      radarMarket({ topHolderPercent: 38 }),
    ],
  }).candidates.find((x) => x.symbol === 'SIRENUSDT');
  assert.equal(danger.safetyStatus, 'DANGER');
  assert.notEqual(danger.actionability, 'ENTRY_READY');
  assert.equal(danger.telegramEligible, false);
});

test('RADAR v1 high setup plus low execution is never entry-ready', () => {
  const state = evaluateTradingRadar({
    markets: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70001, spreadPct: 0.01, depthUsdWithin1Pct: 5e6, change24hPct: 1 },
      { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', quoteVolume24h: 700e6, bidPrice: 3500, askPrice: 3501, spreadPct: 0.01, depthUsdWithin1Pct: 4e6, change24hPct: 0.8 },
      radarMarket({ bidsVanished: true, bidDepthRebuildPct: 0, marketBuyVolumeDominance: 0.45, nearestSupplyDistancePct: 2 }),
    ],
  });
  const c = state.candidates.find((x) => x.symbol === 'SIRENUSDT');
  assert.ok(c.SETUP_SCORE >= 65);
  assert.ok(c.EXECUTION_SCORE < 65 || c.RISK_REWARD_SCORE < 55);
  assert.notEqual(c.actionability, 'ENTRY_READY');
});

test('Cockpit calculates PnL, summary, and veto-driven statuses', () => {
  const hold = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18.42, quantity: 2000, stopLoss: 18.05, tp1: 20.2, entryTime: new Date().toISOString() },
    { currentPrice: 19.86, change1hPct: 1, change4hPct: 3, bidDepthRebuildPct: 12, buyVolumeDominance: 0.58, higherLowHeld: true, vwapHeld: true },
    { score: 73 },
  );
  assert.equal(hold.pnlPct, 7.82);
  assert.ok(['HOLD', 'HOLD_STRONG', 'ADD_ALLOWED', 'HOLD_BUT_WATCH'].includes(hold.status));

  const emergency = evaluateTradeCockpit(
    { symbol: 'WLDUSDT', entryPrice: 1.42, quantity: 12000, stopLoss: 1.38 },
    { currentPrice: 1.37, bidDepthRebuildPct: 0, spreadPct: 0.22 },
    { score: 19 },
  );
  assert.ok(['EXIT_ALL', 'EMERGENCY_EXIT', 'RISK_OFF_EXIT'].includes(emergency.status));
  assert.ok(emergency.tradeHealthScore <= 30);

  const missing = evaluateTradeCockpit({ symbol: 'ARBUSDT', entryPrice: 0.812, quantity: 40000 }, { currentPrice: 0.895 }, { score: 61 });
  assert.ok(['INCOMPLETE_SETUP', 'MISSING_RISK_DATA'].includes(missing.status));

  const summary = summarizeCockpit([hold, emergency, missing]);
  assert.equal(summary.openTrades, 3);
  assert.equal(summary.exitCount >= 1, true);
});

