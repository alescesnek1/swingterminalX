import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';

const NOW = new Date('2026-06-12T10:00:00Z').getTime();

const BTC = {
  symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70007, spreadPct: 0.01,
  change24hPct: 1.2, depthUsdWithin1Pct: 5e6, depthUsd: 5e6,
};

const ETH = {
  symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 600e6, bidPrice: 3600, askPrice: 3601, spreadPct: 0.03,
  change24hPct: 0.8, depthUsdWithin1Pct: 4e6, depthUsd: 4e6,
};

const SAFE_META = {
  chain: 'bsc',
  contractAddress: '0xabc',
  topHolderPercent: 4,
  contractVerified: true,
};

const EARLY_REVERSAL = {
  symbol: 'EARLYUSDT', baseAsset: 'EARLY', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 100, askPrice: 100.04, spreadPct: 0.03,
  change24hPct: -12, change12hPct: -8, change4hPct: 2, change1hPct: 1.2,
  volumeSpike: 2.5, atrPct: 4, longLiquidationSpike: 2.1,
  openInterestChangePct: -7, marketSellRatio: 0.54, fundingRate: -0.01,
  wickRecoveryPct: 50, noNewLowMinutes: 40, rangeFormed: true,
  sellAggressionFading: true, reclaimConfirmed: true, vwapHeld: true,
  higherLowHeld: true, higherLow: 98, vwap: 100, flushLow: 92,
  rangeHigh: 100, nearestSupply: 108, nextSupply: 114, meanReversionTarget: 120,
  ...SAFE_META,
};

const DISLOCATION_ONLY = {
  symbol: 'DISCUSDT', baseAsset: 'DISC', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 100, askPrice: 100.04, spreadPct: 0.03,
  change24hPct: -15, change12hPct: -6, change4hPct: -1, change1hPct: -0.5,
  btcRelativeChangePct: -4, volumeSpike: 1.1, atrPct: 4, wickRecoveryPct: 10,
  nearestSupply: 108, nextSupply: 114, meanReversionTarget: 120,
  ...SAFE_META,
};

const FULL_MICRO_ENTRY = {
  ...EARLY_REVERSAL,
  symbol: 'FULLUSDT',
  depthUsdWithin1Pct: 2e6,
  depthUsd: 2e6,
  bidDepthRebuildPct: 14,
  marketBuyVolumeDominance: 0.59,
  shortLiquidationSpike: 1.5,
  retestHeld: true,
};

const CHASE_RISK = {
  ...EARLY_REVERSAL,
  symbol: 'CHASEUSDT',
  bidPrice: 111,
  askPrice: 111.04,
  nearestSupply: 112,
  nextSupply: 114,
  meanReversionTarget: 116,
};

const NO_RECLAIM = {
  ...EARLY_REVERSAL,
  symbol: 'NORECUSDT',
  reclaimConfirmed: false,
  vwapHeld: false,
  higherLowHeld: false,
  higherLow: undefined,
  change4hPct: -0.5,
  change1hPct: -0.2,
  btcRelativeChangePct: -4,
};

const HIGH_EXEC_LOW_SETUP = {
  ...FULL_MICRO_ENTRY,
  symbol: 'EXECUSDT',
  change24hPct: -1,
  change12hPct: -0.5,
  volumeSpike: 1,
  flushLow: 96,
  longLiquidationSpike: undefined,
  wickRecoveryPct: 0,
  openInterestChangePct: 0,
  marketSellRatio: 0.50,
};

const STATIC_ONLY = {
  symbol: 'STAUSDT', baseAsset: 'STA', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 100, askPrice: 100.02, spreadPct: 0.02,
  change24hPct: -9.5, volumeSpike: 2.4, atrPct: 4,
  orderBookDepthWithin1Pct: 50000, depthUsdWithin1Pct: 1_800_000,
  depthUsd: 1_800_000, fundingRate: -0.0001,
  ...SAFE_META,
};

function stateFor(markets, extra = {}) {
  return evaluateTradingRadar({
    markets: [BTC, ETH, ...markets],
    source: 'v1-test',
    now: NOW,
    ...extra,
  });
}

function candidate(markets, symbol, extra) {
  const state = stateFor(markets, extra);
  const c = state.candidates.find((x) => x.symbol === symbol);
  assert.ok(c, `${symbol} candidate should exist`);
  return c;
}

test('A: every candidate includes the required Trading RADAR v1 output fields', () => {
  const state = stateFor([FULL_MICRO_ENTRY, CHASE_RISK, STATIC_ONLY]);
  const required = [
    'STATUS', 'ACTION', 'ENTRY_TYPE', 'POSITION_SIZE_GUIDANCE', 'ENTRY_ZONE',
    'STOP_LOSS_LEVEL', 'HARD_INVALIDATION', 'TAKE_PROFIT_LEVELS',
    'SETUP_SCORE', 'EXECUTION_SCORE', 'RISK_REWARD_SCORE',
    'MARKET_REGIME_SCORE', 'CONFIDENCE', 'FINAL_CONFIDENCE',
    'TIMEFRAME_CONTEXT', 'TIME_VALIDITY', 'REASON', 'INVALIDATION',
    'missingData', 'dataQuality',
  ];
  for (const c of state.candidates) {
    for (const key of required) assert.ok(Object.hasOwn(c, key), `${c.symbol} missing ${key}`);
    assert.ok(Array.isArray(c.REASON), `${c.symbol} REASON should be an array`);
    assert.ok(Array.isArray(c.missingData), `${c.symbol} missingData should be an array`);
    assert.ok(c.dataQuality && typeof c.dataQuality.score === 'number', `${c.symbol} dataQuality should include score`);
  }
});

test('B: high setup with low execution/RR becomes chase or pullback state, never ENTRY_READY', () => {
  const c = candidate([CHASE_RISK], 'CHASEUSDT');
  assert.ok(c.SETUP_SCORE >= 65);
  assert.ok(c.EXECUTION_SCORE < 65 || c.RISK_REWARD_SCORE < 55);
  assert.ok(['CHASE_RISK', 'WAIT_FOR_PULLBACK'].includes(c.STATUS), `STATUS=${c.STATUS}`);
  assert.notEqual(c.actionability, 'ENTRY_READY');
});

test('C: high execution with low setup remains WATCH, not ENTRY_READY', () => {
  const c = candidate([HIGH_EXEC_LOW_SETUP], 'EXECUSDT');
  assert.ok(c.EXECUTION_SCORE >= 65);
  assert.ok(c.SETUP_SCORE < 65);
  assert.equal(c.STATUS, 'WATCH');
  assert.notEqual(c.actionability, 'ENTRY_READY');
});

test('D: hard market-regime block produces RISK_OFF_BLOCKED and zero position size', () => {
  const c = candidate([
    { ...FULL_MICRO_ENTRY, symbol: 'RISKUSDT' },
  ], 'RISKUSDT', {
    markets: [
      { ...BTC, change24hPct: -5 },
      { ...ETH, change24hPct: -6 },
      { ...FULL_MICRO_ENTRY, symbol: 'RISKUSDT' },
    ],
  });
  assert.equal(c.STATUS, 'RISK_OFF_BLOCKED');
  assert.equal(c.ACTION, 'No new long entry. Monitor only.');
  assert.equal(c.ENTRY_TYPE, 'NONE');
  assert.match(c.POSITION_SIZE_GUIDANCE, /^0%/);
  assert.match(c.blockedBy, /market regime/i);
});

test('D2: candidate serialization exposes V1 STATUS instead of generic WATCH on hard regime block', () => {
  const state = stateFor([], {
    markets: [
      { ...BTC, change24hPct: -5 },
      { ...ETH, change24hPct: -6 },
      { ...FULL_MICRO_ENTRY, symbol: 'SERUSDT' },
    ],
  });
  const c = state.candidates.find((x) => x.symbol === 'SERUSDT');
  assert.ok(c);
  assert.equal(c.STATUS, 'RISK_OFF_BLOCKED');
  assert.notEqual(c.STATUS, 'WATCH');
  assert.match(c.blockedBy, /market regime/i);
});

test('D3: DISLOCATION_CONFIRMED serializes V1 matrix status and blocker, not legacy WATCH/reclaim text', () => {
  const c = candidate([DISLOCATION_ONLY], 'DISCUSDT');
  assert.equal(c.STATUS, 'DISLOCATION_CONFIRMED');
  assert.equal(c.v1Status, 'DISLOCATION_CONFIRMED');
  assert.notEqual(c.STATUS, 'WATCH');
  assert.match(c.blockedBy, /waiting for long flush confirmation/i);
  assert.doesNotMatch(c.blockedBy, /requires structural reclaim/i);
});

test('E: missing microstructure lowers confidence and blocks aggressive entry without collapsing setup states', () => {
  const noMicro = candidate([EARLY_REVERSAL], 'EARLYUSDT');
  const full = candidate([FULL_MICRO_ENTRY], 'FULLUSDT');
  assert.equal(noMicro.microstructureMissing, true);
  assert.equal(noMicro.microstructureTrusted, false);
  assert.ok(noMicro.FINAL_CONFIDENCE < full.FINAL_CONFIDENCE);
  assert.notEqual(noMicro.STATUS, 'AGGRESSIVE_ENTRY_READY');
  assert.ok(['EARLY_ENTRY_READY', 'RECLAIM_DETECTED', 'STABILIZATION', 'WAIT_FOR_RECLAIM'].includes(noMicro.STATUS), `STATUS=${noMicro.STATUS}`);
});

test('F: early reversal fixture reaches EARLY_ENTRY_READY with degraded visible data quality', () => {
  const c = candidate([EARLY_REVERSAL], 'EARLYUSDT');
  assert.equal(c.STATUS, 'EARLY_ENTRY_READY');
  assert.equal(c.ENTRY_TYPE, 'EARLY_REVERSAL');
  assert.ok(c.DISLOCATION_SCORE >= 70);
  assert.ok(c.FLUSH_SCORE >= 65);
  assert.ok(c.STABILIZATION_SCORE >= 55);
  assert.ok(c.RECLAIM_SCORE >= 50);
  assert.ok(c.RISK_REWARD_SCORE >= 55);
  assert.equal(c.microstructureTrusted, false);
  assert.ok(c.missingData.length > 0);
  assert.notEqual(c.STATUS, 'WATCH');
});

test('G: valid setup with bad current R/R is CHASE_RISK, not STANDARD_ENTRY_READY', () => {
  const c = candidate([CHASE_RISK], 'CHASEUSDT');
  assert.equal(c.STATUS, 'CHASE_RISK');
  assert.notEqual(c.STATUS, 'STANDARD_ENTRY_READY');
});

test('G2: dislocation + flush + stabilization without reclaim returns WAIT_FOR_RECLAIM with specific reason', () => {
  const c = candidate([NO_RECLAIM], 'NORECUSDT');
  assert.ok(c.DISLOCATION_SCORE >= 70);
  assert.ok(c.FLUSH_SCORE >= 65);
  assert.ok(c.STABILIZATION_SCORE >= 55);
  assert.equal(c.STATUS, 'WAIT_FOR_RECLAIM');
  assert.notEqual(c.STATUS, 'WATCH');
  assert.match(c.blockedBy, /waiting for reclaim/i);
  assert.doesNotMatch(c.blockedBy, /requires structural reclaim/i);
});

test('G3: missing microstructure lowers confidence but preserves intermediate V1 status', () => {
  const missingMicro = candidate([NO_RECLAIM], 'NORECUSDT');
  const withMicro = candidate([{ ...NO_RECLAIM, symbol: 'NOMIRUSDT', depthUsdWithin1Pct: 2e6, depthUsd: 2e6, bidDepthRebuildPct: 14, marketBuyVolumeDominance: 0.59, shortLiquidationSpike: 1.5 }], 'NOMIRUSDT');
  assert.equal(missingMicro.microstructureMissing, true);
  assert.ok(missingMicro.FINAL_CONFIDENCE < withMicro.FINAL_CONFIDENCE);
  assert.equal(missingMicro.STATUS, 'WAIT_FOR_RECLAIM');
  assert.notEqual(missingMicro.actionability, 'ENTRY_READY');
  assert.equal(missingMicro.telegramEligible, false);
});

test('H: every ENTRY_READY candidate satisfies setup, execution, R/R, regime, and data gates', () => {
  const state = stateFor([EARLY_REVERSAL, FULL_MICRO_ENTRY, CHASE_RISK, HIGH_EXEC_LOW_SETUP]);
  for (const c of state.candidates.filter((x) => x.actionability === 'ENTRY_READY')) {
    assert.ok(c.SETUP_SCORE >= 65, `${c.symbol} setup`);
    assert.ok(c.EXECUTION_SCORE >= 65, `${c.symbol} execution`);
    assert.ok(c.RISK_REWARD_SCORE >= 55, `${c.symbol} rr`);
    assert.ok(c.MARKET_REGIME_SCORE >= 50, `${c.symbol} regime`);
    assert.equal(c.allRadarConditionsPassed, true, `${c.symbol} all conditions`);
    assert.equal(c.dataQualitySufficient, true, `${c.symbol} data quality`);
  }
});

test('I: static stale/provider-none cache never unlocks Absorb, aggressive entry, ENTRY_READY, or Telegram', () => {
  const c = candidate([STATIC_ONLY], 'STAUSDT');
  assert.equal(c.hasStaticMicrostructure, true);
  assert.equal(c.hasRollingMicrostructure, false);
  assert.notEqual((c.conditionChecklist.absorption || {}).status, 'PASS');
  assert.notEqual(c.STATUS, 'AGGRESSIVE_ENTRY_READY');
  assert.notEqual(c.actionability, 'ENTRY_READY');
  assert.equal(c.telegramEligible, false);
});
