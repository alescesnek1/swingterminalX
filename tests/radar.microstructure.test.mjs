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

// First-slice static fields ONLY (order-book depth + spread + funding), with NO
// rolling-window / structural fields — exactly what the OFF-by-default sidecar
// can honestly produce today.
const STATIC_ONLY = {
  symbol: 'STAUSDT', baseAsset: 'STA', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 100, askPrice: 100.02, spreadPct: 0.02,
  change24hPct: -9.5, volumeSpike: 2.4, atrPct: 4,
  orderBookDepthWithin1Pct: 50000, depthUsdWithin1Pct: 1_800_000, depthUsd: 1_800_000,
  fundingRate: -0.0001,
};

// ── E) Candidate diagnostics: no microstructure at all ───────────────────────
test('E: a price-only row reports static+rolling missing and lists the blocking fields', () => {
  const { c } = candidateFor('NOMUSDT', [NO_MICRO]);
  assert.ok(c);
  assert.equal(c.hasStaticMicrostructure, false);
  assert.equal(c.hasRollingMicrostructure, false);
  // Every rolling absorption group is missing.
  for (const k of ['absorptionScore', 'supportRetest', 'aggressiveSellsFailed', 'bidAbsorption', 'deltaImprovement']) {
    assert.ok(c.missingAbsorptionFields.includes(k), `missingAbsorptionFields should include ${k}`);
  }
  // Reclaim is blocked on structure.
  assert.ok(c.missingReclaimFields.includes('structuralReclaim'));
  assert.ok(c.absorptionBlockedReason && /no microstructure data/i.test(c.absorptionBlockedReason));
  assert.ok(c.reclaimBlockedReason && /structural reclaim/i.test(c.reclaimBlockedReason));
  assert.notEqual(c.actionability, 'ENTRY_READY');
});

// ── F) Candidate diagnostics: static first-slice only ────────────────────────
test('F: static depth/spread/funding present but rolling absent — Absorb/Reclaim never PASS', () => {
  const { c } = candidateFor('STAUSDT', [STATIC_ONLY]);
  assert.ok(c);
  assert.equal(c.hasStaticMicrostructure, true);
  assert.equal(c.hasRollingMicrostructure, false);
  // The static fields cannot satisfy the absorption gate.
  assert.notEqual((c.conditionChecklist.absorption || {}).status, 'PASS');
  assert.notEqual((c.conditionChecklist.squeezeOrReclaim || {}).status, 'PASS');
  assert.ok(c.absorptionBlockedReason && /static order-book\/funding only|no rolling absorption/i.test(c.absorptionBlockedReason));
  assert.equal(c.telegramEligible, false);
});

// ── G) Candidate diagnostics: full rolling data present ──────────────────────
test('G: with real rolling absorption data, diagnostics report it present and not the blocker', () => {
  const { c } = candidateFor('ABSUSDT', [WITH_MICRO]);
  assert.ok(c);
  assert.equal(c.hasStaticMicrostructure, true);
  assert.equal(c.hasRollingMicrostructure, true);
  assert.deepEqual(c.missingAbsorptionFields, []);
  assert.equal(c.absorptionBlockedReason, null); // absorption checklist PASSes here
  // Reclaim still needs structure (this fixture has none) and stays blocked.
  assert.ok(c.missingReclaimFields.includes('structuralReclaim'));
  assert.ok(c.reclaimBlockedReason);
});

// ── F2) Stale/untrusted static cache is fail-closed at the evaluator too ──────
// A provider-none / stale snapshot is still merged into the candidate as static
// fields (so the UI can label it "stale diagnostic cache"). It carries NO
// rolling data, so the evaluator can never pass Absorb/Reclaim from it, and it
// never reaches ENTRY_READY or Telegram — regardless of how the UI labels it.
test('F2: untrusted/stale static cache (static-only) never passes Absorb/Reclaim, never ENTRY_READY/Telegram', () => {
  const { c } = candidateFor('STAUSDT', [STATIC_ONLY]);
  assert.ok(c);
  assert.equal(c.hasStaticMicrostructure, true);   // fields present (diagnostic cache)
  assert.equal(c.hasRollingMicrostructure, false); // but no trusted rolling data
  assert.notEqual((c.conditionChecklist.absorption || {}).status, 'PASS');
  assert.notEqual((c.conditionChecklist.squeezeOrReclaim || {}).status, 'PASS');
  assert.notEqual(c.actionability, 'ENTRY_READY');
  assert.equal(c.telegramEligible, false);
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
