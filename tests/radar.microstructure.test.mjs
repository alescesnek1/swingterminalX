// Microstructure absorption contract for Trading RADAR.
//
// Proves the absorption gate is FAIL-CLOSED:
//   A) with no microstructure data, absorption is never PASS, the missing keys
//      are surfaced, and the candidate is neither ENTRY_READY nor Telegram-eligible.
//   B) with real microstructure fields present, absorption can become PASS — and
//      ENTRY_READY is still only reachable when every V1 gate also passes.
//   D) WATCH / NEAR_ENTRY / blocked candidates are never Telegram-eligible; only a
//      confirmed V1 ENTRY_READY with strictly-SAFE safety can be.
// Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTradingRadar } from '../scripts/radar/trading-radar.mjs';

const NOW = new Date('2026-06-12T10:00:00Z').getTime();
const BTC = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70007, spreadPct: 0.01, change24hPct: 1.2 };
const ETH = { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 600e6, bidPrice: 3600, askPrice: 3601, spreadPct: 0.03, change24hPct: 0.8 };

// Flush + stabilization, but ZERO order book / derivatives / flow / absorption
// microstructure (what a price-only public snapshot looks like today).
const NO_MICRO = {
  symbol: 'NOMUSDT', baseAsset: 'NOM', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 140, askPrice: 145, // wide bid/ask => no spreadPct field supplied
  change24hPct: -9.5, volumeSpike: 2.4, atrPct: 4, wickRecoveryPct: 48,
  noNewLowMinutes: 34, rangeFormed: true, sellAggressionFading: true,
  flushLow: 132,
};

// Same setup WITH genuine, worker-measured absorption microstructure present.
const WITH_MICRO = {
  symbol: 'ABSUSDT', baseAsset: 'ABS', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 140, askPrice: 140.04, spreadPct: 0.028,
  change24hPct: -9.5, volumeSpike: 2.4, atrPct: 4, wickRecoveryPct: 48,
  longLiquidationSpike: 2.2, shortLiquidationSpike: 1.5, openInterestChangePct: -7,
  marketSellRatio: 0.68, fundingRate: -0.01,
  noNewLowMinutes: 34, rangeFormed: true, sellAggressionFading: true,
  // The real absorption inputs:
  absorptionScore: 82, aggressiveSellsFailed: true, supportRetested: true,
  bidAbsorption: true, bidDepthRebuildPct: 14, marketBuyVolumeDominance: 0.59,
  reclaimConfirmed: false, retestHeld: false,
  vwap: 140, flushLow: 132, depthUsdWithin1Pct: 1_800_000, depthUsd: 2_000_000,
};

const MICRO_KEYS = [
  'orderBookDepthWithin1Pct',
  'openInterestChangePct',
  'fundingRate',
  'longLiquidationSpike',
  'shortLiquidationSpike',
  'marketSellRatio',
];

function candidateFor(symbol, extraMarkets = []) {
  const state = evaluateTradingRadar({ markets: [BTC, ETH, ...extraMarkets], source: 'test', now: NOW });
  return { state, c: state.candidates.find((x) => x.symbol === symbol) };
}

// ── A) Missing microstructure ────────────────────────────────────────────────
test('A: with no microstructure, absorption is never PASS and ENTRY_READY/Telegram stay false', () => {
  const { c } = candidateFor('NOMUSDT', [NO_MICRO]);
  assert.ok(c, 'candidate present');
  const absorption = (c.conditionChecklist.absorption || {}).status;
  assert.notEqual(absorption, 'PASS');
  assert.ok(['WAIT', 'MISSING DATA'].includes(absorption), `absorption=${absorption}`);

  // The required microstructure keys are surfaced as missing, not invented.
  for (const key of MICRO_KEYS) {
    assert.ok(c.missingSignals.includes(key), `missingSignals should include ${key} (got ${c.missingSignals.join(',')})`);
  }
  assert.notEqual(c.actionability, 'ENTRY_READY');
  assert.equal(c.telegramEligible, false);
});

// ── B) Valid microstructure ──────────────────────────────────────────────────
test('B: absorption becomes PASS only because real fields exist, with no fake ENTRY_READY', () => {
  const { c } = candidateFor('ABSUSDT', [WITH_MICRO]);
  assert.ok(c, 'candidate present');
  assert.equal((c.conditionChecklist.absorption || {}).status, 'PASS');

  // Contrast: the identical setup with the absorption microstructure stripped
  // must NOT pass absorption — proving the PASS came from real data, not price.
  const stripped = { ...WITH_MICRO, symbol: 'ABSUSDT' };
  for (const k of ['absorptionScore', 'aggressiveSellsFailed', 'supportRetested', 'bidAbsorption',
    'bidDepthRebuildPct', 'marketBuyVolumeDominance', 'longLiquidationSpike', 'shortLiquidationSpike',
    'openInterestChangePct', 'marketSellRatio', 'fundingRate', 'depthUsdWithin1Pct', 'depthUsd', 'spreadPct']) {
    delete stripped[k];
  }
  const { c: cStripped } = candidateFor('ABSUSDT', [stripped]);
  assert.notEqual((cStripped.conditionChecklist.absorption || {}).status, 'PASS');

  // ENTRY_READY (if any) is gated by the full V1 contract — never absorption alone.
  if (c.actionability === 'ENTRY_READY') {
    assert.equal(c.allRadarConditionsPassed, true);
    assert.ok(c.SETUP_SCORE >= 65);
    assert.ok(c.EXECUTION_SCORE >= 65);
    assert.ok(c.RISK_REWARD_SCORE >= 55);
    assert.ok(c.MARKET_REGIME_SCORE >= 50);
    assert.ok(c.entryZone && c.entryZone.low != null && c.entryZone.high != null);
    assert.ok(c.suggestedStop != null || c.invalidationLevel != null);
    // Telegram only when ENTRY_READY AND safety strictly SAFE.
    assert.equal(c.telegramEligible, c.safetyStatus === 'SAFE');
  } else {
    assert.equal(c.telegramEligible, false);
  }
});

// ── D) Telegram safety on non-ENTRY_READY ────────────────────────────────────
test('D: WATCH / NEAR_ENTRY / blocked candidates are never Telegram-eligible', () => {
  const { state } = candidateFor('NOMUSDT', [NO_MICRO, WITH_MICRO]);
  for (const c of state.candidates) {
    if (c.actionability !== 'ENTRY_READY') {
      assert.equal(c.telegramEligible, false, `${c.symbol} (${c.actionability}) must not be Telegram-eligible`);
    }
  }
  // Every Telegram-eligible row (if any) is a confirmed V1 ENTRY_READY + SAFE.
  for (const c of state.candidates.filter((x) => x.telegramEligible)) {
    assert.equal(c.actionability, 'ENTRY_READY');
    assert.equal(c.allRadarConditionsPassed, true);
    assert.equal(c.safetyStatus, 'SAFE');
  }
});
