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

test('J: score breakdown explains low SETUP_SCORE when Reclaim/Derivatives/Regime are weak', () => {
  const c = candidate([DISLOCATION_ONLY], 'DISCUSDT');
  assert.ok(c.diagnostics);
  assert.match(c.diagnostics.setupBreakdown, /SETUP:/);
  assert.match(c.diagnostics.setupBreakdown, /reclaim 0/);
  assert.ok(c.SETUP_SCORE < 65);
});

test('K: execution score is low when microstructure/flow/reclaim are missing', () => {
  const c = candidate([DISLOCATION_ONLY], 'DISCUSDT');
  assert.ok(c.diagnostics);
  assert.match(c.diagnostics.executionBreakdown, /EXECUTION:/);
  assert.match(c.diagnostics.executionBreakdown, /flow N\/A/);
  assert.ok(c.EXECUTION_SCORE < 40);
});

test('L: candidates with same visual chips but different score components produce different scores', () => {
  const c1 = candidate([{...EARLY_REVERSAL, symbol: 'C1', btcRelativeChangePct: -10}], 'C1');
  const c2 = candidate([{...EARLY_REVERSAL, symbol: 'C2', btcRelativeChangePct: 0}], 'C2');
  // Both have same early reversal setup, but C1 dislocation score should be higher due to btcRelativeChangePct
  assert.notEqual(c1.SETUP_SCORE, c2.SETUP_SCORE);
  assert.notEqual(c1.DISLOCATION_SCORE, c2.DISLOCATION_SCORE);
});

test('M: regime score > 45 with no hard boolean does not become RISK_OFF_BLOCKED', () => {
  const c = candidate([
    { ...FULL_MICRO_ENTRY, symbol: 'M1USDT', change24hPct: 0 }
  ], 'M1USDT', {
    markets: [
      { ...BTC, change24hPct: 1 },
      { ...ETH, change24hPct: 1 },
      { ...FULL_MICRO_ENTRY, symbol: 'M1USDT', change24hPct: 1 },
      { symbol: 'M2USDT', status: 'TRADING', quoteAsset: 'USDT', quoteVolume24h: 1e6, change24hPct: 1 },
      { symbol: 'M3USDT', status: 'TRADING', quoteAsset: 'USDT', quoteVolume24h: 1e6, change24hPct: -2 }
    ]
  });
  assert.ok(c.MARKET_REGIME_SCORE >= 45);
  assert.notEqual(c.STATUS, 'RISK_OFF_BLOCKED');
});

test('N: breadth collapse triggers RISK_OFF_BLOCKED despite score > 45 and diagnostics name it explicitly', () => {
  const c = candidate([
    { ...FULL_MICRO_ENTRY, symbol: 'N1USDT', change24hPct: -2 }
  ], 'N1USDT', {
    markets: [
      { ...BTC, change24hPct: 2 },
      { ...ETH, change24hPct: 2 },
      { ...FULL_MICRO_ENTRY, symbol: 'N1USDT', change24hPct: -2 },
      { symbol: 'N2USDT', status: 'TRADING', quoteAsset: 'USDT', quoteVolume24h: 1e6, change24hPct: -2 },
      { symbol: 'N3USDT', status: 'TRADING', quoteAsset: 'USDT', quoteVolume24h: 1e6, change24hPct: -2 },
      { symbol: 'N4USDT', status: 'TRADING', quoteAsset: 'USDT', quoteVolume24h: 1e6, change24hPct: -2 },
      { symbol: 'N5USDT', status: 'TRADING', quoteAsset: 'USDT', quoteVolume24h: 1e6, change24hPct: -2 },
      { symbol: 'N6USDT', status: 'TRADING', quoteAsset: 'USDT', quoteVolume24h: 1e6, change24hPct: -2 },
      { symbol: 'N7USDT', status: 'TRADING', quoteAsset: 'USDT', quoteVolume24h: 1e6, change24hPct: -2 },
      { symbol: 'N8USDT', status: 'TRADING', quoteAsset: 'USDT', quoteVolume24h: 1e6, change24hPct: -2 }
    ]
  });
  assert.equal(c.STATUS, 'RISK_OFF_BLOCKED');
  assert.equal(c.MARKET_REGIME_SCORE, 48);
  assert.equal(c.marketRegimeDiagnostics.hardBlockReason, 'breadth collapse');
});

// ── Phase C: Reclaim v2 structured price-structure diagnostics ───────────────
// RECLAIM IS NOT ABSORB. These fixtures carry NO trusted microstructure so they
// also prove Reclaim evaluates (and confirms) without an order-flow provider.
const RB = {
  status: 'TRADING', quoteAsset: 'USDT', quoteVolume24h: 250e6, spreadPct: 0.03,
  atrPct: 4, volumeSpike: 1.5, ...SAFE_META,
};
const R_NOT_STARTED = { ...RB, symbol: 'RNOTUSDT', bidPrice: 100, askPrice: 100.04, breakdownLevel: 110, change24hPct: -8 };
const R_ATTEMPT = { ...RB, symbol: 'RATTUSDT', bidPrice: 100, askPrice: 100.04, breakdownLevel: 100, change24hPct: -8 };
const R_DETECTED = { ...RB, symbol: 'RDETUSDT', bidPrice: 100, askPrice: 100.04, breakdownLevel: 98, change24hPct: -8 };
const R_CONFIRMED_NR = { ...RB, symbol: 'RCNRUSDT', bidPrice: 100, askPrice: 100.04, breakdownLevel: 98, reclaimConfirmed: true, change24hPct: -8 };
const R_RETEST_HOLD = { ...RB, symbol: 'RRHUSDT', bidPrice: 100, askPrice: 100.04, breakdownLevel: 98, reclaimConfirmed: true, retestHeld: true, higherLowHeld: true, change24hPct: -8 };
const R_FAILED = { ...RB, symbol: 'RFAILUSDT', bidPrice: 100, askPrice: 100.04, breakdownLevel: 98, reclaimConfirmed: true, reclaimLost: true, change24hPct: -8 };
const R_LEVEL_UNDEFINED = { ...RB, symbol: 'RUNDUSDT', bidPrice: 100, askPrice: 100.04, rangeLow: 0, change24hPct: -8 };
const R_SOURCE_MISSING = { ...RB, symbol: 'RSRCUSDT', bidPrice: 100, askPrice: 100.04, change24hPct: -8 };

// Strict-absorb + reclaim-confirmed fixture (full trusted microstructure) used to
// prove gates still apply even when both Absorb and Reclaim are confirmed.
const STRICT_RECLAIM = {
  symbol: 'STRICTUSDT', baseAsset: 'STR', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 100, askPrice: 100.04, spreadPct: 0.05,
  change24hPct: -12, change12hPct: -8, change4hPct: 2, change1hPct: 1.2,
  volumeSpike: 2.5, atrPct: 4, longLiquidationSpike: 2.1, openInterestChangePct: -7,
  marketSellRatio: 0.54, fundingRate: -0.01, wickRecoveryPct: 50, noNewLowMinutes: 40,
  rangeFormed: true, sellAggressionFading: true, reclaimConfirmed: true, vwapHeld: true,
  higherLowHeld: true, higherLow: 98, vwap: 100, flushLow: 92, breakdownLevel: 98,
  rangeHigh: 100, nearestSupply: 108, nextSupply: 114, meanReversionTarget: 120,
  depthUsdWithin1Pct: 2e6, depthUsd: 2e6, bidDepthRebuildPct: 14, marketBuyVolumeDominance: 0.6,
  shortLiquidationSpike: 1.5, retestHeld: true, absorptionScore: 82, supportRetested: true,
  aggressiveSellsFailed: true, deltaImprovementPct: 1.2, cumulativeDelta: 100, takerBuySellRatio: 1.4,
  ...SAFE_META,
};

test('Reclaim-1: evaluates and confirms without a trusted microstructure provider', () => {
  const c = candidate([R_CONFIRMED_NR], 'RCNRUSDT');
  assert.equal(c.microstructureTrusted, false);
  assert.notEqual(c.RECLAIM_STATUS, 'RECLAIM_DATA_UNAVAILABLE');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_CONFIRMED_NO_RETEST');
  assert.ok(c.RECLAIM_SCORE > 0);
});

test('Reclaim-2: no relevant level => RECLAIM_LEVEL_UNDEFINED with a reason', () => {
  const c = candidate([R_LEVEL_UNDEFINED], 'RUNDUSDT');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_LEVEL_UNDEFINED');
  assert.equal(c.RECLAIM_LEVEL, null);
  assert.equal(c.RECLAIM_SOURCE_DATA_STATUS, 'NO_LEVEL_FOUND');
  assert.ok(c.RECLAIM_REJECT_REASONS.includes('no relevant reclaim level found'));
});

test('Reclaim-2b: missing scanner source fields => explicit source-data-missing diagnostic', () => {
  const c = candidate([R_SOURCE_MISSING], 'RSRCUSDT');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_LEVEL_UNDEFINED');
  assert.equal(c.RECLAIM_SOURCE_DATA_STATUS, 'RECLAIM_DATA_SOURCE_MISSING');
  assert.equal(c.RECLAIM_LEVEL, null);
  assert.ok(c.RECLAIM_REJECT_REASONS.includes('RECLAIM_DATA_SOURCE_MISSING'));
  assert.ok(c.RECLAIM_SOURCE_FIELDS_MISSING.includes('breakdownLevel'));
  assert.match(c.RECLAIM_NEXT_REQUIRED_CONDITION, /scanner did not supply reclaim source fields/i);
});

test('Reclaim-3: price below the zone => RECLAIM_NOT_STARTED', () => {
  const c = candidate([R_NOT_STARTED], 'RNOTUSDT');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_NOT_STARTED');
  assert.equal(c.CLOSE_ABOVE_LEVEL, false);
});

test('Reclaim-4: price near/inside the zone => RECLAIM_ATTEMPT', () => {
  const c = candidate([R_ATTEMPT], 'RATTUSDT');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_ATTEMPT');
});

test('Reclaim-5: above the zone without close/hold => RECLAIM_DETECTED', () => {
  const c = candidate([R_DETECTED], 'RDETUSDT');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_DETECTED');
  assert.equal(c.CLOSE_ABOVE_LEVEL, false);
});

test('Reclaim-6: close/hold above zone without retest => RECLAIM_CONFIRMED_NO_RETEST', () => {
  const c = candidate([R_CONFIRMED_NR], 'RCNRUSDT');
  assert.ok(['RECLAIM_CONFIRMED', 'RECLAIM_CONFIRMED_NO_RETEST'].includes(c.RECLAIM_STATUS));
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_CONFIRMED_NO_RETEST');
  assert.equal(c.CLOSE_ABOVE_LEVEL, true);
  assert.equal(c.RETEST_STATUS, 'not yet tested');
});

test('Reclaim-7: confirmed reclaim with a held retest => RECLAIM_RETEST_HOLD', () => {
  const c = candidate([R_RETEST_HOLD], 'RRHUSDT');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_RETEST_HOLD');
  assert.equal(c.RETEST_STATUS, 'held');
  assert.equal(c.RECLAIM_CLASSIFICATION, 'STANDARD_RECLAIM');
});

test('Reclaim-8: reclaim then loss of the zone => RECLAIM_FAILED with reason', () => {
  const c = candidate([R_FAILED], 'RFAILUSDT');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_FAILED');
  assert.ok(c.RECLAIM_FAILED_REASON && c.RECLAIM_FAILED_REASON.length > 0);
});

test('Reclaim-9: a missing retest does not force the score to zero', () => {
  const c = candidate([R_CONFIRMED_NR], 'RCNRUSDT');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_CONFIRMED_NO_RETEST');
  assert.ok(c.RECLAIM_SCORE >= 50, `score=${c.RECLAIM_SCORE}`);
  assert.ok(c.RECLAIM_REJECT_REASONS.includes('no retest yet'));
});

test('Reclaim-10: reclaim does not require microstructure and never unlocks aggressive entry alone', () => {
  const c = candidate([R_RETEST_HOLD], 'RRHUSDT');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_RETEST_HOLD');
  assert.equal(c.microstructureTrusted, false);
  assert.notEqual(c.STATUS, 'AGGRESSIVE_ENTRY_READY');
  assert.equal(c.telegramEligible, false);
});

test('Reclaim-11: reclaim + proxy absorb only yields a non-aggressive, non-strict path', () => {
  const c = candidate([R_RETEST_HOLD], 'RRHUSDT');
  assert.equal(c.ABSORB_MODE, 'PROXY');
  assert.notEqual(c.STRICT_ABSORB_CONFIRMED, true);
  assert.notEqual(c.STATUS, 'AGGRESSIVE_ENTRY_READY');
  assert.notEqual(c.ENTRY_IMPACT, 'STRICT_CONFIRMED_AGGRESSIVE_ALLOWED_IF_ALL_GATES_PASS');
});

test('Reclaim-12: reclaim + strict absorb confirmed still requires all existing gates', () => {
  // Both Absorb (strict) and Reclaim confirm, but a hard regime block must still
  // prevent any aggressive/standard entry — proving Reclaim never bypasses gates.
  const c = candidate([], 'STRICTUSDT', {
    markets: [
      { ...BTC, change24hPct: -5 },
      { ...ETH, change24hPct: -6 },
      STRICT_RECLAIM,
    ],
  });
  assert.equal(c.STRICT_ABSORB_CONFIRMED, true);
  assert.ok(['RECLAIM_CONFIRMED', 'RECLAIM_CONFIRMED_NO_RETEST', 'RECLAIM_RETEST_HOLD'].includes(c.RECLAIM_STATUS));
  assert.equal(c.STATUS, 'RISK_OFF_BLOCKED');
  assert.notEqual(c.STATUS, 'AGGRESSIVE_ENTRY_READY');
});

test('Reclaim-13: reclaim funnel exposes snapshot counters separate from absorb funnel', () => {
  const state = stateFor([R_RETEST_HOLD, R_FAILED, R_DETECTED]);
  assert.ok(state.reclaimFunnel, 'reclaimFunnel exists');
  assert.equal(state.reclaimFunnel.rollingWindow, 'snapshot-only');
  assert.ok(state.reclaimFunnel.reclaimRetestHeld >= 1);
  assert.ok(state.reclaimFunnel.reclaimFailed >= 1);
  assert.ok(state.reclaimFunnel.reclaimLevelIdentified >= 3);
  // Funnel is wired into the pipeline alongside (but distinct from) absorbFunnel.
  assert.ok(state.pipeline.reclaimFunnel);
  assert.notEqual(state.reclaimFunnel, state.absorbFunnel);
});

test('Reclaim-14: current scanner-shaped rows with missing reclaim sources stay fail-safe and non-telegram', () => {
  const state = evaluateTradingRadar({
    markets: [BTC, ETH],
    scannerCandidates: [{
      symbol: 'REALMISSUSDT',
      price: 0.42,
      volume: 80_000_000,
      c24: -9,
      c12: -6,
      c4: -1,
      c1: 0.4,
      score: 70,
      signal: 'FLUSH',
      source: 'scanner-fixture',
    }],
    source: 'scanner-shaped-fixture',
    now: NOW,
  });
  const c = state.candidates.find((x) => x.symbol === 'REALMISSUSDT');
  assert.ok(c, 'scanner-shaped candidate should be evaluated');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_LEVEL_UNDEFINED');
  assert.equal(c.RECLAIM_SOURCE_DATA_STATUS, 'RECLAIM_DATA_SOURCE_MISSING');
  assert.equal(c.STRICT_ABSORB_STATUS, 'ABSORB_DATA_UNAVAILABLE');
  assert.notEqual(c.actionability, 'ENTRY_READY');
  assert.notEqual(c.STATUS, 'AGGRESSIVE_ENTRY_READY');
  assert.equal(c.ENTRY_TYPE, 'NONE');
  assert.equal(c.telegramEligible, false);
});

// ── Phase C.6: Reclaim source-field mapping guardrails ──────────────────────

test('C6-1: stop/hardInvalidation/invalidationLevel must NOT produce reclaim source levels', () => {
  // A market with ONLY stop/invalidation fields and price data — no structural levels.
  // Reclaim must show NO RECLAIM DATA, not use the stop as a reclaim level.
  const c = candidate([{
    ...RB, symbol: 'STOPUSDT', bidPrice: 100, askPrice: 100.04, change24hPct: -8,
    stop: 95, hardInvalidation: 90, invalidationLevel: 88,
  }], 'STOPUSDT');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_LEVEL_UNDEFINED');
  assert.equal(c.RECLAIM_SOURCE_DATA_STATUS, 'RECLAIM_DATA_SOURCE_MISSING');
  assert.equal(c.RECLAIM_LEVEL, null);
  // None of the levels should be sourced from stop/invalidation
  for (const lvl of (c.RECLAIM_LEVELS || [])) {
    assert.ok(!lvl.source.includes('invalidation'), `level source should not be invalidation: ${lvl.source}`);
    assert.ok(!lvl.source.includes('stop'), `level source should not be stop: ${lvl.source}`);
  }
});

test('C6-2: high_24h produces a low-confidence fallback source labelled as fallback', () => {
  const c = candidate([{
    ...RB, symbol: 'H24USDT', bidPrice: 100, askPrice: 100.04, change24hPct: -8,
    high_24h: 105,
  }], 'H24USDT');
  // Should have a level, not NO RECLAIM DATA
  assert.notEqual(c.RECLAIM_STATUS, 'RECLAIM_LEVEL_UNDEFINED');
  assert.ok(c.RECLAIM_LEVEL > 0, 'reclaim level should be set');
  // Source type must indicate fallback
  assert.ok(c.RECLAIM_LEVEL_TYPE.includes('fallback'), `type should indicate fallback: ${c.RECLAIM_LEVEL_TYPE}`);
  assert.ok(c.RECLAIM_LEVEL_SOURCE.includes('fallback'), `source should indicate fallback: ${c.RECLAIM_LEVEL_SOURCE}`);
  // Importance / confidence must be low (≤ 35)
  assert.ok(c.RECLAIM_SOURCE_CONFIDENCE <= 35, `source confidence should be <= 35: ${c.RECLAIM_SOURCE_CONFIDENCE}`);
});

test('C6-3: low_24h produces a low-confidence fallback source labelled as fallback', () => {
  const c = candidate([{
    ...RB, symbol: 'L24USDT', bidPrice: 100, askPrice: 100.04, change24hPct: -8,
    low_24h: 92,
  }], 'L24USDT');
  assert.notEqual(c.RECLAIM_STATUS, 'RECLAIM_LEVEL_UNDEFINED');
  assert.ok(c.RECLAIM_LEVEL > 0, 'reclaim level should be set');
  assert.ok(c.RECLAIM_LEVEL_TYPE.includes('fallback'), `type should indicate fallback: ${c.RECLAIM_LEVEL_TYPE}`);
  assert.ok(c.RECLAIM_SOURCE_CONFIDENCE <= 30, `source confidence should be <= 30: ${c.RECLAIM_SOURCE_CONFIDENCE}`);
});

test('C6-4: fallback reclaim sources do NOT unlock ENTRY_READY', () => {
  // A candidate with ONLY fallback sources, even with reclaim-confirming signals
  const c = candidate([{
    ...RB, symbol: 'FBALLBUSDT', bidPrice: 105, askPrice: 105.04, change24hPct: -8,
    high_24h: 104, reclaimConfirmed: true, vwapHeld: true, higherLowHeld: true, retestHeld: true,
    volumeSpike: 2.5, rangeFormed: true,
  }], 'FBALLBUSDT');
  assert.notEqual(c.actionability, 'ENTRY_READY');
  assert.notEqual(c.STATUS, 'ENTRY_READY');
});

test('C6-5: fallback reclaim sources do NOT send Telegram', () => {
  const c = candidate([{
    ...RB, symbol: 'FBTGUSDT', bidPrice: 105, askPrice: 105.04, change24hPct: -8,
    high_24h: 104, reclaimConfirmed: true, vwapHeld: true, higherLowHeld: true,
    retestHeld: true, volumeSpike: 2.5,
  }], 'FBTGUSDT');
  assert.equal(c.telegramEligible, false);
});

test('C6-6: fallback reclaim sources do NOT unlock AGGRESSIVE_ENTRY_READY', () => {
  // Even with strict absorb data, fallback reclaim must not enable aggressive
  const c = candidate([{
    ...STRICT_RECLAIM,
    symbol: 'FBAGUSDT',
    // Remove all structural levels, keep only high_24h as fallback
    breakdownLevel: undefined, reclaimLevel: undefined, flushHigh: undefined,
    rangeLow: undefined, previousSupport: undefined, vwap: undefined,
    baseHigh: undefined, preBreakdownPivot: undefined, maResistance: undefined,
    high_24h: 104,
  }], 'FBAGUSDT');
  assert.notEqual(c.STATUS, 'AGGRESSIVE_ENTRY_READY');
});

test('C6-7: missing source fields still produce RECLAIM_DATA_SOURCE_MISSING when only stop/invalidation present', () => {
  // With only stop/invalidation on the market object, no reclaim source fields match,
  // so it must produce RECLAIM_DATA_SOURCE_MISSING
  const c = candidate([{
    ...RB, symbol: 'NORECL2USDT', bidPrice: 100, askPrice: 100.04, change24hPct: -8,
    stop: 95, invalidationLevel: 88,
    // Explicitly no structural or fallback fields
  }], 'NORECL2USDT');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_LEVEL_UNDEFINED');
  assert.equal(c.RECLAIM_SOURCE_DATA_STATUS, 'RECLAIM_DATA_SOURCE_MISSING');
  assert.ok(c.RECLAIM_SOURCE_FIELDS_MISSING.includes('breakdownLevel'));
  assert.equal(c.telegramEligible, false);
  assert.notEqual(c.actionability, 'ENTRY_READY');
});


test('C6-8: scanner-shaped live rows propagate high_24h/low_24h into Reclaim diagnostics', () => {
  const state = evaluateTradingRadar({
    markets: [BTC, ETH],
    scannerCandidates: [{
      symbol: 'LIVEH24USDT', price: 100, volume: 90_000_000,
      c24: -8, c12: -5, c4: -1, c1: 0.2,
      score: 72, signal: 'FLUSH', high_24h: 106, low_24h: 91,
      source: 'scanner-live-shape', ...SAFE_META,
    }],
    source: 'scanner-shaped-fixture',
    now: NOW,
  });
  const c = state.candidates.find((x) => x.symbol === 'LIVEH24USDT');
  assert.ok(c, 'scanner-shaped candidate should be evaluated');
  assert.equal(c.RECLAIM_SOURCE_DATA_STATUS, 'SOURCE_DATA_PRESENT');
  assert.equal(c.RECLAIM_LEVEL_SOURCE, '24h high (fallback)');
  assert.equal(c.RECLAIM_SOURCE_CONFIDENCE, 32);
  assert.ok(c.RECLAIM_SOURCE_FIELDS_PRESENT.includes('high_24h'));
  assert.ok(c.RECLAIM_SOURCE_FIELDS_PRESENT.includes('low_24h'));
  assert.notEqual(c.actionability, 'ENTRY_READY');
  assert.equal(c.telegramEligible, false);
});

test('C6-9: structural reclaim sources outrank 24h fallback sources', () => {
  const c = candidate([{
    ...RB, symbol: 'RANKUSDT', bidPrice: 100, askPrice: 100.04, change24hPct: -8,
    breakdownLevel: 98, high_24h: 106, low_24h: 91,
  }], 'RANKUSDT');
  assert.equal(c.RECLAIM_LEVEL_SOURCE, 'nearest breakdown level');
  assert.equal(c.RECLAIM_SOURCE_CONFIDENCE, 96);
  assert.ok(c.RECLAIM_SOURCE_FIELDS_PRESENT.includes('breakdownLevel'));
  assert.ok(c.RECLAIM_LEVELS.some((lvl) => lvl.source === '24h high (fallback)'));
});

test('C6-10: current price aliases do not count as reclaim source fields', () => {
  const c = candidate([{
    ...RB, symbol: 'PXONLYUSDT', bidPrice: 100, askPrice: 100.04, lastPrice: 100.02,
    price: 100.02, currentPrice: 100.02, change24hPct: -8,
  }], 'PXONLYUSDT');
  assert.equal(c.RECLAIM_STATUS, 'RECLAIM_LEVEL_UNDEFINED');
  assert.equal(c.RECLAIM_SOURCE_DATA_STATUS, 'RECLAIM_DATA_SOURCE_MISSING');
  assert.equal(c.RECLAIM_LEVEL, null);
  assert.equal(c.RECLAIM_SOURCE_FIELDS_PRESENT.includes('price'), false);
  assert.equal(c.RECLAIM_SOURCE_FIELDS_PRESENT.includes('currentPrice'), false);
});
