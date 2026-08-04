// Tests for scripts/radar/valuation-bands.mjs — the oversold / overbought
// (valuation band) engine.
//
// The engine is advisory-only by contract, so the tests pin BOTH the maths and
// the honesty rules: missing data must land on UNKNOWN (never OVERSOLD, which a
// reader could take as an invitation to act, and never OVERBOUGHT, a bearish
// label), a measured 0 must stay a measurement, and no output may ever claim to
// be a gate, an entry signal, or a Telegram input.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VALUATION_BANDS,
  VALUATION_DIRECTIONS,
  VALUATION_THRESHOLDS,
  buildValuationContext,
  computeHistoryValuation,
  computeMomentumValuation,
  mergeValuationHistory,
  summarizeValuationBands,
  valuationBandFromScore,
  valuationBandLabel,
  valuationDirectionFromBand,
  valuationInputsFromMarket,
} from '../scripts/radar/valuation-bands.mjs';

const HOUR = 3600000;
const T0 = Date.parse('2026-08-01T00:00:00.000Z');

// Builds an ascending stored-points series (newest last) shaped like the rows
// listRecentPricePointsForSymbols returns — pg numerics as strings included.
function points(prices, opts = {}) {
  const stepMs = opts.stepMs || (30 * 60 * 1000);
  const start = opts.start ?? (T0 - (prices.length - 1) * stepMs);
  return prices.map((price, i) => ({
    symbol: opts.symbol || 'TEST',
    price_usd: opts.asStrings ? String(price) : price,
    change_1h_pct: opts.change1h ?? null,
    change_24h_pct: opts.change24h ?? null,
    change_7d_pct: opts.change7d ?? null,
    volume_24h_usd: 1_000_000,
    sampled_at: new Date(start + i * stepMs).toISOString(),
  }));
}

function ramp(from, to, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(from + ((to - from) * (i / (n - 1))));
  return out;
}

// ── band arithmetic ─────────────────────────────────────────────────────────

test('band edges follow the published thresholds and UNKNOWN is reserved for no score', () => {
  assert.equal(valuationBandFromScore(-100), VALUATION_BANDS.DEEPLY_OVERSOLD);
  assert.equal(valuationBandFromScore(VALUATION_THRESHOLDS.deeplyOversold), VALUATION_BANDS.DEEPLY_OVERSOLD);
  assert.equal(valuationBandFromScore(-59.9), VALUATION_BANDS.OVERSOLD);
  assert.equal(valuationBandFromScore(VALUATION_THRESHOLDS.oversold), VALUATION_BANDS.OVERSOLD);
  assert.equal(valuationBandFromScore(-24.9), VALUATION_BANDS.FAIR);
  assert.equal(valuationBandFromScore(0), VALUATION_BANDS.FAIR);
  assert.equal(valuationBandFromScore(24.9), VALUATION_BANDS.FAIR);
  assert.equal(valuationBandFromScore(VALUATION_THRESHOLDS.overbought), VALUATION_BANDS.OVERBOUGHT);
  assert.equal(valuationBandFromScore(59.9), VALUATION_BANDS.OVERBOUGHT);
  assert.equal(valuationBandFromScore(VALUATION_THRESHOLDS.deeplyOverbought), VALUATION_BANDS.DEEPLY_OVERBOUGHT);
  for (const noScore of [null, undefined, '', NaN, 'abc', {}]) {
    assert.equal(valuationBandFromScore(noScore), VALUATION_BANDS.UNKNOWN);
  }
});

test('direction and label maps never leak a directional word for UNKNOWN', () => {
  assert.equal(valuationDirectionFromBand(VALUATION_BANDS.OVERSOLD), VALUATION_DIRECTIONS.OVERSOLD);
  assert.equal(valuationDirectionFromBand(VALUATION_BANDS.DEEPLY_OVERBOUGHT), VALUATION_DIRECTIONS.OVERBOUGHT);
  assert.equal(valuationDirectionFromBand(VALUATION_BANDS.FAIR), VALUATION_DIRECTIONS.NEUTRAL);
  assert.equal(valuationDirectionFromBand(VALUATION_BANDS.UNKNOWN), VALUATION_DIRECTIONS.UNKNOWN);
  assert.equal(valuationDirectionFromBand('nonsense'), VALUATION_DIRECTIONS.UNKNOWN);
  assert.equal(valuationBandLabel(VALUATION_BANDS.UNKNOWN), 'Unknown');
  assert.equal(valuationBandLabel('nonsense'), 'Unknown');
});

// ── momentum layer ──────────────────────────────────────────────────────────

test('a row with no timeframe change at all yields an UNAVAILABLE momentum layer, not a flat 0', () => {
  const m = computeMomentumValuation({});
  assert.equal(m.available, false);
  assert.equal(m.score, null);
  assert.match(m.reason, /no timeframe change data/);
  assert.equal(m.timeframesUsed, 0);
  assert.ok(m.missing.includes('change24hPct'));
});

test('missing changes are absent, but a genuinely measured 0 is a measurement (Number(null) trap)', () => {
  const absent = computeMomentumValuation({ change24hPct: null, change12hPct: undefined, change1hPct: '' });
  assert.equal(absent.available, false, 'null/undefined/"" must not become 0% moves');

  const measured = computeMomentumValuation({ change24hPct: 0 });
  assert.equal(measured.available, true);
  assert.equal(measured.score, 0);
  assert.equal(measured.timeframesUsed, 1);
  assert.ok(!measured.missing.includes('change24hPct'));
});

test('a deep multi-timeframe drawdown scores oversold; a strong rally scores overbought', () => {
  const dumped = computeMomentumValuation({ change1hPct: -3, change4hPct: -7, change12hPct: -14, change24hPct: -22, change7dPct: -40 });
  assert.ok(dumped.score < VALUATION_THRESHOLDS.oversold, `expected oversold score, got ${dumped.score}`);
  assert.equal(valuationDirectionFromBand(valuationBandFromScore(dumped.score)), VALUATION_DIRECTIONS.OVERSOLD);

  const pumped = computeMomentumValuation({ change1hPct: 3, change4hPct: 7, change12hPct: 14, change24hPct: 22, change7dPct: 40 });
  assert.ok(pumped.score > VALUATION_THRESHOLDS.overbought, `expected overbought score, got ${pumped.score}`);
  assert.equal(valuationDirectionFromBand(valuationBandFromScore(pumped.score)), VALUATION_DIRECTIONS.OVERBOUGHT);
});

test('volatility normalization makes the same drop less oversold on a high-ATR coin', () => {
  const calm = computeMomentumValuation({ change24hPct: -12, atrPct: 2 });
  const wild = computeMomentumValuation({ change24hPct: -12, atrPct: 15 });
  assert.ok(calm.score < wild.score, `calm ${calm.score} should be more oversold than wild ${wild.score}`);
  assert.equal(calm.volatilityKnown, true);
  assert.equal(wild.volatilityKnown, true);
  const unknownVol = computeMomentumValuation({ change24hPct: -12 });
  assert.equal(unknownVol.volatilityKnown, false);
  assert.equal(unknownVol.volatilityFactor, 1, 'unknown volatility must not scale anything');
  assert.ok(unknownVol.missing.includes('atrPct'));
});

test('the BTC-relative nudge is bounded and reported, never the whole read', () => {
  const neutralBase = computeMomentumValuation({ change24hPct: 0 });
  const laggard = computeMomentumValuation({ change24hPct: 0, btcRelativeChangePct: -50 });
  const leader = computeMomentumValuation({ change24hPct: 0, btcRelativeChangePct: 50 });
  assert.equal(neutralBase.btcRelativePoints, null);
  assert.equal(laggard.btcRelativePoints, -12);
  assert.equal(leader.btcRelativePoints, 12);
  assert.equal(Math.abs(laggard.score), 12, 'extreme BTC divergence alone cannot exceed the bounded nudge');
});

test('one extreme timeframe cannot dominate past the per-timeframe unit cap', () => {
  const insane = computeMomentumValuation({ change1hPct: -400 });
  assert.ok(insane.score >= -100 && insane.score <= 0);
  const contribution = insane.contributions.find((c) => c.timeframe === '1h');
  assert.equal(contribution.units, -1.5);
});

test('valuationInputsFromMarket reads both row and diagnostics aliases without inventing values', () => {
  assert.deepEqual(valuationInputsFromMarket({ priceChangePercent: -5 }).change24hPct, -5);
  assert.deepEqual(valuationInputsFromMarket({ diagnostics: { change24hPct: -7 } }).change24hPct, -7);
  assert.deepEqual(valuationInputsFromMarket({ relativeToBtcPct: -3 }).btcRelativeChangePct, -3);
  assert.deepEqual(valuationInputsFromMarket({ realizedVolatilityPct: 4 }).atrPct, 4);
  const empty = valuationInputsFromMarket(null);
  assert.equal(empty.change24hPct, null);
  assert.equal(empty.atrPct, null);
});

// ── history layer ───────────────────────────────────────────────────────────

test('no history and too-little history are distinct, named, unavailable states', () => {
  const none = computeHistoryValuation(null);
  assert.equal(none.available, false);
  assert.equal(none.status, 'NO_HISTORY');
  assert.equal(none.score, null);

  const thin = computeHistoryValuation(points([10, 11, 12, 11]));
  assert.equal(thin.available, false);
  assert.equal(thin.status, 'INSUFFICIENT_HISTORY');
  assert.equal(thin.pointsUsed, 4);
  assert.match(thin.reason, /need >= 12 points/);

  // Enough points but a window far too short to mean anything.
  const compressed = computeHistoryValuation(points(ramp(10, 9, 20), { stepMs: 1000 }));
  assert.equal(compressed.available, false);
  assert.equal(compressed.status, 'INSUFFICIENT_HISTORY');
});

test('price at the bottom of the stored range reads oversold; at the top, overbought', () => {
  const falling = computeHistoryValuation(points(ramp(100, 60, 30)));
  assert.equal(falling.available, true);
  assert.equal(falling.status, 'OK');
  assert.equal(falling.rangePercentile, 0);
  assert.ok(falling.score < VALUATION_THRESHOLDS.oversold, `expected oversold, got ${falling.score}`);
  assert.ok(falling.sampledRsi !== null && falling.sampledRsi < 50);
  assert.ok(falling.meanDeviationPct < 0);
  assert.deepEqual(falling.componentsUsed.sort(), ['rangePercentile', 'sampledRsi', 'zScore']);

  const rising = computeHistoryValuation(points(ramp(60, 100, 30)));
  assert.equal(rising.rangePercentile, 100);
  assert.ok(rising.score > VALUATION_THRESHOLDS.overbought, `expected overbought, got ${rising.score}`);
});

test('a perfectly flat stored window is FLAT_WINDOW, not FAIR', () => {
  const flat = computeHistoryValuation(points(new Array(30).fill(42)));
  assert.equal(flat.available, false);
  assert.equal(flat.status, 'FLAT_WINDOW');
  assert.equal(flat.score, null);
  assert.match(flat.reason, /no price range/);
});

test('history layer parses pg numeric strings and drops unusable rows without throwing', () => {
  const raw = points(ramp(100, 70, 30), { asStrings: true });
  raw.push({ symbol: 'TEST', price_usd: null, sampled_at: null });
  raw.push({ symbol: 'TEST', price_usd: '0', sampled_at: new Date(T0).toISOString() });
  raw.push(null);
  const result = computeHistoryValuation(raw);
  assert.equal(result.available, true);
  assert.equal(result.pointsUsed, 30, 'null/zero/garbage rows must be dropped, not scored');
});

test('stored 1h/24h/7d changes are only marked usable while fresh', () => {
  const series = points(ramp(100, 80, 30), { change1h: -1, change24h: -9, change7d: -20 });
  const fresh = computeHistoryValuation(series, { now: T0 + (10 * 60 * 1000) });
  assert.equal(fresh.storedChanges.usable, true);
  assert.equal(fresh.storedChanges.change24hPct, -9);

  const stale = computeHistoryValuation(series, { now: T0 + (10 * HOUR) });
  assert.equal(stale.storedChanges.usable, false, 'a 10h-old stored change must not be presented as current');
});

// ── assembly, merging, contract ─────────────────────────────────────────────

test('buildValuationContext gives every row a momentum-only band with the honesty contract attached', () => {
  const v = buildValuationContext({ market: { change24hPct: -20, change12hPct: -14 } });
  assert.equal(v.VALUATION_BASIS, 'momentum_only');
  assert.equal(v.VALUATION_CONFIDENCE, 'low');
  assert.equal(v.VALUATION_DIRECTION, VALUATION_DIRECTIONS.OVERSOLD);
  assert.equal(v.history.available, false);
  assert.ok(v.VALUATION_MISSING_INPUTS.includes('storedPriceHistory'));
  assert.equal(v.isEntrySignal, false);
  assert.equal(v.affectsGate, false);
  assert.equal(v.affectsTelegram, false);
  assert.equal(v.scope, 'relative_to_own_recent_range');
  assert.match(v.note, /not a fundamental valuation/);
  assert.ok(v.VALUATION_BLOCKERS.some((b) => /advisory only — a valuation band is a context read/.test(b)));
});

test('a row with no usable input at all is UNKNOWN with a null score — never OVERSOLD or FAIR', () => {
  for (const market of [null, undefined, {}, { symbol: 'X' }, { change24hPct: null }]) {
    const v = buildValuationContext({ market });
    assert.equal(v.VALUATION_BAND, VALUATION_BANDS.UNKNOWN);
    assert.equal(v.VALUATION_DIRECTION, VALUATION_DIRECTIONS.UNKNOWN);
    assert.equal(v.VALUATION_SCORE, null);
    assert.equal(v.VALUATION_CONFIDENCE, 'unknown');
    assert.equal(v.VALUATION_BASIS, 'none');
    assert.match(v.VALUATION_SUMMARY, /unknown/i);
  }
});

test('merging a stored-history layer upgrades basis and confidence and keeps the contract', () => {
  const base = buildValuationContext({ market: { change24hPct: -18, change12hPct: -12, atrPct: 6 } });
  const history = computeHistoryValuation(points(ramp(100, 62, 40), { stepMs: HOUR }));
  const merged = mergeValuationHistory(base, history);
  assert.equal(merged.VALUATION_BASIS, 'momentum+history');
  assert.equal(merged.VALUATION_CONFIDENCE, 'high', 'agreeing layers over a deep window are high confidence');
  assert.equal(merged.layersAgree, true);
  assert.equal(merged.VALUATION_DIRECTION, VALUATION_DIRECTIONS.OVERSOLD);
  assert.equal(merged.history.available, true);
  assert.equal(merged.isEntrySignal, false);
  assert.equal(merged.affectsGate, false);
  assert.equal(merged.affectsTelegram, false);
  // The input block is never mutated in place.
  assert.equal(base.VALUATION_BASIS, 'momentum_only');
});

test('disagreeing layers are reported and pull confidence down to low', () => {
  const base = buildValuationContext({ market: { change1hPct: 6, change4hPct: 12, change24hPct: 30 } });
  const history = computeHistoryValuation(points(ramp(100, 55, 30)));
  const merged = mergeValuationHistory(base, history);
  assert.equal(merged.layersAgree, false);
  assert.equal(merged.VALUATION_CONFIDENCE, 'low');
  assert.ok(merged.VALUATION_BLOCKERS.some((b) => /disagree/.test(b)));
  assert.match(merged.VALUATION_SUMMARY, /disagree/);
});

test('stored changes fill momentum gaps only when the row lacked them, and the fill is disclosed', () => {
  const base = buildValuationContext({ market: {} });
  assert.equal(base.momentum.available, false);
  const history = computeHistoryValuation(
    points(ramp(100, 70, 30), { change1h: -2, change24h: -16, change7d: -33 }),
    { now: T0 },
  );
  const merged = mergeValuationHistory(base, history);
  assert.equal(merged.momentum.available, true, 'fresh stored changes should rescue a bare row');
  assert.deepEqual(merged.momentum.filledFromHistory, ['change1hPct', 'change24hPct', 'change7dPct']);
  assert.equal(merged.momentum.filledFromHistorySource, 'price_history_db');
  assert.equal(merged.VALUATION_BASIS, 'momentum+history');

  // A row that already carries its own 24h change keeps it.
  const own = buildValuationContext({ market: { change24hPct: -1 } });
  const mergedOwn = mergeValuationHistory(own, history);
  assert.ok(!mergedOwn.momentum.filledFromHistory.includes('change24hPct'));
  assert.equal(mergedOwn.momentum.inputs.change24hPct, -1);
});

test('merging a stale or unusable history layer degrades to the momentum-only read, never throws', () => {
  const base = buildValuationContext({ market: { change24hPct: -20 } });
  for (const bad of [null, undefined, {}, 'nope', 42]) {
    const merged = mergeValuationHistory(base, bad);
    assert.equal(merged.VALUATION_BASIS, 'momentum_only');
    assert.equal(merged.VALUATION_DIRECTION, VALUATION_DIRECTIONS.OVERSOLD);
    assert.equal(merged.history.available, false);
  }
  assert.equal(mergeValuationHistory(null, null).VALUATION_BAND, VALUATION_BANDS.UNKNOWN);
});

test('history-only rows are medium confidence, never high', () => {
  const merged = mergeValuationHistory(
    buildValuationContext({ market: {} }),
    computeHistoryValuation(points(ramp(100, 60, 40), { stepMs: HOUR })),
  );
  assert.equal(merged.VALUATION_BASIS, 'history_only');
  assert.equal(merged.VALUATION_CONFIDENCE, 'medium');
});

test('summarizeValuationBands counts every band and treats a missing block as unknown, not fair', () => {
  const candidates = [
    { valuation: buildValuationContext({ market: { change24hPct: -40, change12hPct: -30, change7dPct: -60 } }) },
    { valuation: buildValuationContext({ market: { change24hPct: -12 } }) },
    { valuation: buildValuationContext({ market: { change24hPct: 0 } }) },
    { valuation: buildValuationContext({ market: { change24hPct: 40, change12hPct: 30, change7dPct: 60 } }) },
    { symbol: 'NOVALUATION' },
    null,
  ];
  const s = summarizeValuationBands(candidates);
  assert.equal(s.total, 6);
  assert.equal(s.unknown, 2, 'a candidate with no valuation block and a null row are both unknown');
  assert.equal(s.fair, 1);
  assert.equal(s.oversoldTotal, s.oversold + s.deeplyOversold);
  assert.equal(s.overboughtTotal, s.overbought + s.deeplyOverbought);
  assert.ok(s.oversoldTotal >= 2);
  assert.ok(s.overboughtTotal >= 1);
  assert.equal(s.momentumOnly, 4);
  assert.equal(s.historyBacked, 0);
  assert.deepEqual(summarizeValuationBands(null), summarizeValuationBands([]));
});
