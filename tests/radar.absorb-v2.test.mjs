// Absorb v2 contract for Trading RADAR (Phase B).
//
// Proves the STRICT vs PROXY separation is FAIL-CLOSED:
//   - STRICT is the only branch that can CONFIRM, and only with trusted, fresh
//     rolling microstructure. Missing/stale/untrusted provider can never confirm.
//   - PROXY is information-only: it never confirms absorb, never unlocks
//     aggressive entry, never unlocks Telegram.
//   - Missing strict fields are surfaced, never invented.
// Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';

const NOW = new Date('2026-06-12T10:00:00Z').getTime();
const BTC = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70007, spreadPct: 0.01, change24hPct: 1.2 };
const ETH = { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 600e6, bidPrice: 3600, askPrice: 3601, spreadPct: 0.03, change24hPct: 0.8 };

// Price-only row: a flush/stabilization shape but ZERO order-flow / order-book
// microstructure (what a public snapshot looks like with no provider).
const NO_MICRO = {
  symbol: 'NOMUSDT', baseAsset: 'NOM', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 140, askPrice: 145,
  change24hPct: -9.5, change12hPct: -6, change1hPct: 0.8, btcRelativeChangePct: 2,
  volumeSpike: 2.4, atrPct: 4, wickRecoveryPct: 48,
  noNewLowMinutes: 34, rangeFormed: true, sellAggressionFading: true,
  higherLowHeld: true, reclaimConfirmed: true, flushLow: 132,
};

// Full, FRESH rolling microstructure with strong absorption inputs.
const STRONG_TRUSTED = {
  symbol: 'STRONGUSDT', baseAsset: 'STRONG', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 140, askPrice: 140.04, spreadPct: 0.028,
  change24hPct: -9.5, volumeSpike: 2.4, atrPct: 4,
  longLiquidationSpike: 2.2, shortLiquidationSpike: 1.5, openInterestChangePct: -7,
  marketSellRatio: 0.50, fundingRate: -0.01,
  noNewLowMinutes: 34, rangeFormed: true, sellAggressionFading: true,
  absorptionScore: 82, aggressiveSellsFailed: true, supportRetested: true,
  bidAbsorption: true, bidDepthRebuildPct: 14, marketBuyVolumeDominance: 0.59,
  vwap: 140, flushLow: 132, depthUsdWithin1Pct: 1_800_000, depthUsd: 2_000_000,
};

// Trusted, FRESH rolling microstructure present (so STRICT mode is active) but
// every component is below threshold -> strict score 0 -> ABSORB_REJECTED.
const WEAK_TRUSTED = {
  symbol: 'WEAKUSDT', baseAsset: 'WEAK', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 140, askPrice: 140.2, spreadPct: 0.12,
  change24hPct: -9.5, volumeSpike: 2.4, atrPct: 4,
  absorptionScore: 30, aggressiveSellsFailed: false, supportRetested: false,
  bidDepthRebuildPct: 2, marketBuyVolumeDominance: 0.40,
  depthUsdWithin1Pct: 1_800_000, depthUsd: 2_000_000, flushLow: 132,
};

// Trusted-shaped strong data, but explicitly STALE / UNTRUSTED via the flags.
const STALE_MICRO = { ...STRONG_TRUSTED, symbol: 'STALEUSDT', microstructureStale: true };
const UNTRUSTED_MICRO = { ...STRONG_TRUSTED, symbol: 'UNTRUSTUSDT', staticMicrostructureTrusted: false };

function rollingSnapshot(rows, extra = {}) {
  return {
    provider: 'test-rolling',
    trusted: true,
    updatedAtMs: NOW,
    data: rows,
    ...extra,
  };
}

const STRONG_ROLLING = {
  bidDepthRebuildPct: 14,
  marketSellRatio: 0.50,
  openInterestChangePct: -7,
  longLiquidationSpike: 2.2,
  flow: { takerBuySellRatio: 1.4, cumulativeDeltaPct: 1.2, aggressiveSellExhaustion: true },
};

const WEAK_ROLLING = {
  bidDepthRebuildPct: 2,
  marketSellRatio: 0.72,
  openInterestChangePct: -1,
  longLiquidationSpike: 0.2,
  flow: { takerBuySellRatio: 0.7, cumulativeDeltaPct: -1.1, aggressiveSellExhaustion: false },
};

function candidateFor(symbol, extraMarkets = [], extra = {}) {
  const state = evaluateTradingRadar({ markets: [BTC, ETH, ...extraMarkets], source: 'test', now: NOW, ...extra });
  return { state, c: state.candidates.find((x) => x.symbol === symbol) };
}

test('1: missing provider — STRICT not confirmed, mode is PROXY, proxy may evaluate', () => {
  const { c } = candidateFor('NOMUSDT', [NO_MICRO]);
  assert.ok(c);
  assert.equal(c.ABSORB_MODE, 'PROXY');
  assert.equal(c.STRICT_ABSORB_CONFIRMED, false);
  assert.notEqual(c.STRICT_ABSORB_STATUS, 'ABSORB_CONFIRMED');
  assert.equal(c.STRICT_ABSORB_STATUS, 'ABSORB_DATA_UNAVAILABLE');
  assert.notEqual(c.ABSORB_STATUS, 'ABSORB_CONFIRMED');
  // Proxy is allowed to evaluate to a non-confirm status.
  assert.ok(['ABSORB_PARTIAL_EVIDENCE', 'ABSORB_WATCH', 'ABSORB_REJECTED'].includes(c.PROXY_ABSORB_STATUS));
  assert.notEqual(c.STATUS, 'AGGRESSIVE_ENTRY_READY');
});

test('2: stale microstructure — ABSORB_DATA_STALE, never strict-confirmed', () => {
  const { c } = candidateFor('STALEUSDT', [STALE_MICRO], { rollingMicrostructureSnapshot: rollingSnapshot({ STALEUSDT: STRONG_ROLLING }, { updatedAtMs: NOW - 20 * 60 * 1000 }) });
  assert.ok(c);
  assert.equal(c.STRICT_ABSORB_STATUS, 'ABSORB_DATA_STALE');
  assert.equal(c.STRICT_ABSORB_CONFIRMED, false);
  assert.notEqual(c.ABSORB_MODE, 'STRICT');
  assert.equal(c.ABSORB_BLOCK_REASON, 'stale static cache');
  assert.notEqual(c.STATUS, 'AGGRESSIVE_ENTRY_READY');
});

test('3: untrusted provider — ABSORB_PROVIDER_UNTRUSTED, never strict-confirmed', () => {
  const { c } = candidateFor('UNTRUSTUSDT', [UNTRUSTED_MICRO], { rollingMicrostructureSnapshot: rollingSnapshot({ UNTRUSTUSDT: STRONG_ROLLING }, { trusted: false }) });
  assert.ok(c);
  assert.equal(c.STRICT_ABSORB_STATUS, 'ABSORB_PROVIDER_UNTRUSTED');
  assert.equal(c.STRICT_ABSORB_CONFIRMED, false);
  assert.notEqual(c.ABSORB_MODE, 'STRICT');
  assert.equal(c.ABSORB_BLOCK_REASON, 'untrusted provider');
  assert.notEqual(c.STATUS, 'AGGRESSIVE_ENTRY_READY');
});

test('4: trusted FRESH but weak data — STRICT evaluated and REJECTED, not confirmed', () => {
  const { c } = candidateFor('WEAKUSDT', [WEAK_TRUSTED], { rollingMicrostructureSnapshot: rollingSnapshot({ WEAKUSDT: WEAK_ROLLING }) });
  assert.ok(c);
  assert.equal(c.ABSORB_MODE, 'STRICT');
  assert.equal(c.STRICT_ABSORB_STATUS, 'ABSORB_REJECTED');
  assert.equal(c.STRICT_ABSORB_CONFIRMED, false);
  assert.ok(c.STRICT_ABSORB_SCORE < 50, `score=${c.STRICT_ABSORB_SCORE}`);
});

test('5: trusted FRESH strong data — STRICT confirmed (ABSORB_CONFIRMED)', () => {
  const { c } = candidateFor('STRONGUSDT', [STRONG_TRUSTED], { rollingMicrostructureSnapshot: rollingSnapshot({ STRONGUSDT: STRONG_ROLLING }) });
  assert.ok(c);
  assert.equal(c.ABSORB_MODE, 'STRICT');
  assert.equal(c.STRICT_ABSORB_STATUS, 'ABSORB_CONFIRMED');
  assert.equal(c.ABSORB_STATUS, 'ABSORB_CONFIRMED');
  assert.equal(c.STRICT_ABSORB_CONFIRMED, true);
  assert.ok(c.STRICT_ABSORB_SCORE >= 65, `score=${c.STRICT_ABSORB_SCORE}`);
});

test('6: proxy partial/watch evidence never unlocks aggressive entry', () => {
  const { state } = candidateFor('NOMUSDT', [NO_MICRO]);
  for (const c of state.candidates) {
    if (c.ABSORB_MODE !== 'STRICT' || !c.STRICT_ABSORB_CONFIRMED) {
      assert.notEqual(c.STATUS, 'AGGRESSIVE_ENTRY_READY', `${c.symbol} must not be aggressive without strict confirm`);
      assert.notEqual(c.ENTRY_IMPACT, 'STRICT_CONFIRMED_AGGRESSIVE_ALLOWED_IF_ALL_GATES_PASS');
    }
  }
});

test('7: proxy partial/watch evidence never unlocks Telegram', () => {
  const { c } = candidateFor('NOMUSDT', [NO_MICRO]);
  assert.ok(c);
  // Proxy can produce evidence, but Telegram eligibility is driven by V1
  // ENTRY_READY gates only — never by a proxy absorb reading.
  assert.notEqual(c.ABSORB_MODE, 'STRICT');
  assert.equal(c.telegramEligible, false);
});

test('8: missing strict fields are surfaced, never invented', () => {
  const { c } = candidateFor('NOMUSDT', [NO_MICRO]);
  assert.ok(c);
  assert.ok(Array.isArray(c.ABSORB_MISSING_FIELDS));
  // A price-only row is missing the order-flow / order-book inputs.
  for (const k of ['aggressiveSellsFailed', 'priceImpactWeakVsSellVolume', 'bidDepthRebuildPct', 'deltaImprovement']) {
    assert.ok(c.ABSORB_MISSING_FIELDS.includes(k), `expected missing field ${k}, got ${c.ABSORB_MISSING_FIELDS.join(',')}`);
  }
  assert.match(c.ABSORB_NEXT_REQUIRED_CONDITION, /trusted rolling microstructure/i);
});

test('10: snapshot absorb funnel counters are present and consistent', () => {
  const { state } = candidateFor('STRONGUSDT', [STRONG_TRUSTED, NO_MICRO, WEAK_TRUSTED], { rollingMicrostructureSnapshot: rollingSnapshot({ STRONGUSDT: STRONG_ROLLING, WEAKUSDT: WEAK_ROLLING }) });
  const f = state.absorbFunnel;
  assert.ok(f, 'absorbFunnel present');
  assert.equal(f, state.pipeline.absorbFunnel);
  const keys = [
    'coinsScanned', 'dislocationConfirmed', 'longFlushConfirmed', 'stabilizationDetected',
    'proxyAbsorbWatch', 'proxyPartialEvidence', 'strictAbsorbEvaluated', 'strictAbsorbConfirmed',
    'aggressiveAbsorptionEntry', 'blockedByMissingProvider', 'blockedByStaleCache',
    'blockedByUntrustedProvider', 'blockedByMarketRegime', 'blockedBySpreadLiquidity', 'blockedByMissingFields',
  ];
  for (const k of keys) assert.equal(typeof f[k], 'number', `funnel.${k} should be a number`);
  assert.ok(f.coinsScanned >= 3);
  // STRONG_TRUSTED is the only strict-confirmed row in this set.
  assert.ok(f.strictAbsorbConfirmed >= 1, `strictAbsorbConfirmed=${f.strictAbsorbConfirmed}`);
  assert.ok(f.strictAbsorbEvaluated >= f.strictAbsorbConfirmed);
  assert.equal(f.rollingWindow, 'snapshot-only');
});

test('11: stale / untrusted / proxy rows are never Telegram-eligible and never aggressive', () => {
  const { state } = candidateFor('STALEUSDT', [STALE_MICRO, UNTRUSTED_MICRO, NO_MICRO]);
  for (const c of state.candidates) {
    assert.equal(c.STRICT_ABSORB_CONFIRMED, false, `${c.symbol} must not be strict-confirmed`);
    assert.notEqual(c.STATUS, 'AGGRESSIVE_ENTRY_READY', `${c.symbol} must not be aggressive`);
    assert.equal(c.telegramEligible, false, `${c.symbol} must not be Telegram-eligible`);
    assert.notEqual(c.ENTRY_IMPACT, 'STRICT_CONFIRMED_AGGRESSIVE_ALLOWED_IF_ALL_GATES_PASS');
  }
});

test('9: every required Absorb v2 output field is present on each candidate', () => {
  const { state } = candidateFor('STRONGUSDT', [STRONG_TRUSTED, NO_MICRO, WEAK_TRUSTED], { rollingMicrostructureSnapshot: rollingSnapshot({ STRONGUSDT: STRONG_ROLLING, WEAKUSDT: WEAK_ROLLING }) });
  const required = [
    'ABSORB_STATUS', 'ABSORB_MODE', 'STRICT_ABSORB_STATUS', 'PROXY_ABSORB_STATUS',
    'STRICT_ABSORB_SCORE', 'PROXY_ABSORB_SCORE', 'ABSORB_BLOCK_REASON',
    'ABSORB_MISSING_FIELDS', 'ABSORB_NEXT_REQUIRED_CONDITION', 'ENTRY_IMPACT',
  ];
  for (const c of state.candidates) {
    for (const k of required) assert.ok(Object.hasOwn(c, k), `${c.symbol} missing ${k}`);
    assert.ok(['STRICT', 'PROXY', 'DISABLED'].includes(c.ABSORB_MODE), `${c.symbol} mode=${c.ABSORB_MODE}`);
  }
});

test('12: partial rolling data with missing longLiquidationSpike has specific block reason and stays fail-closed', () => {
  const PARTIAL_ROLLING = { ...STRONG_ROLLING };
  delete PARTIAL_ROLLING.longLiquidationSpike;
  PARTIAL_ROLLING.strictReady = false;
  PARTIAL_ROLLING.missingFields = ['longLiquidationSpike'];
  
  const PARTIAL_TRUSTED = { ...STRONG_TRUSTED, symbol: 'PARTIALUSDT' };
  const { c } = candidateFor('PARTIALUSDT', [PARTIAL_TRUSTED], { rollingMicrostructureSnapshot: rollingSnapshot({ PARTIALUSDT: PARTIAL_ROLLING }) });
  assert.ok(c);
  
  // Rolling data is present but incomplete
  assert.equal(c.hasRollingMicrostructure, true);
  assert.equal(c.absorbV2.hasRollingMicrostructure, true);
  assert.equal(c.absorbV2.microstructureStale, false);
  
  // Strict absorb remains unavailable
  assert.equal(c.STRICT_ABSORB_CONFIRMED, false);
  assert.equal(c.absorbV2.STRICT_ABSORB_CONFIRMED, false);
  assert.notEqual(c.ABSORB_STATUS, 'ABSORB_CONFIRMED');
  assert.notEqual(c.STRICT_ABSORB_STATUS, 'ABSORB_CONFIRMED');
  
  assert.equal(c.STRICT_ABSORB_STATUS, 'ABSORB_DATA_UNAVAILABLE');
  assert.equal(c.absorbV2.STRICT_ABSORB_STATUS, 'ABSORB_DATA_UNAVAILABLE');
  
  // Specific block reason correctly formulated
  assert.equal(c.ABSORB_BLOCK_REASON, 'Rolling data present, strict Absorb incomplete: liquidation data unavailable');
  assert.equal(c.absorbV2.ABSORB_BLOCK_REASON, 'Rolling data present, strict Absorb incomplete: liquidation data unavailable');
  
  // ENTRY_READY / Telegram remain blocked
  assert.notEqual(c.STATUS, 'AGGRESSIVE_ENTRY_READY');
  assert.equal(c.telegramEligible, false);
});
