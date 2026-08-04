// valuation-bands.mjs — "is this coin oversold or overbought?" as an explicit,
// two-layer, fail-closed read.
//
// WHAT THIS IS
//   A stretch/position read RELATIVE TO THE COIN'S OWN recent behaviour:
//     • momentum layer — how far the coin has moved across the timeframes the
//       row actually carries (1h/4h/12h/24h/7d), normalized by its own
//       volatility when that is known, plus its move relative to BTC.
//     • history layer  — where the current price sits inside the stored
//       `market_price_points` window: percentile of the window range, a sampled
//       Wilder RSI, a z-score vs the window mean, and the % deviation from that
//       mean.
//   The two layers are scored independently and then combined, so a reading is
//   always traceable to the evidence that produced it.
//
// WHAT THIS IS NOT (enforced by the output contract below)
//   - NOT a fundamental valuation. An OVERSOLD band means price is stretched LOW
//     inside this coin's own recent range — never that the coin is worth more
//     than it costs. Nothing here reads supply, revenue, FDV, or a fair price.
//   - NOT an entry signal, and NOT a gate. Every output carries
//     isEntrySignal:false / affectsGate:false / affectsTelegram:false. Nothing
//     in this file is read by RADAR scoring, ENTRY_READY, Absorb, Reclaim,
//     alerts, Telegram, or the bot. An oversold coin is still only tradable
//     when the existing RADAR gates pass.
//
// SAFETY / OBSERVABILITY
//   - Pure: no DB, no network, no env reads, no clock reads except an injected
//     `now`. Never throws for malformed input.
//   - Missing or unusable data yields band 'UNKNOWN' with a named blocker — it
//     never falls through to OVERSOLD (which a reader could take as an
//     invitation to act) or to OVERBOUGHT (a bearish label). "No data" and
//     "computed FAIR" are distinguishable states.
//   - Presence is decided BEFORE Number(): null / undefined / '' are absent, a
//     genuinely measured 0 is present. (Number(null) === 0 would otherwise turn
//     a missing change into a perfectly flat market.)

export const VALUATION_BANDS = Object.freeze({
  DEEPLY_OVERSOLD: 'DEEPLY_OVERSOLD',
  OVERSOLD: 'OVERSOLD',
  FAIR: 'FAIR',
  OVERBOUGHT: 'OVERBOUGHT',
  DEEPLY_OVERBOUGHT: 'DEEPLY_OVERBOUGHT',
  UNKNOWN: 'UNKNOWN',
});

export const VALUATION_DIRECTIONS = Object.freeze({
  OVERSOLD: 'OVERSOLD',
  NEUTRAL: 'NEUTRAL',
  OVERBOUGHT: 'OVERBOUGHT',
  UNKNOWN: 'UNKNOWN',
});

// Band edges on the -100..+100 score (negative = oversold, positive = overbought).
export const VALUATION_THRESHOLDS = Object.freeze({
  deeplyOversold: -60,
  oversold: -25,
  overbought: 25,
  deeplyOverbought: 60,
});

// Per-timeframe weight and the move that counts as one full unit of stretch.
// A 24h reference of 18% means "-18% in a day" is a full -1 on that timeframe
// before volatility normalization.
const MOMENTUM_TIMEFRAMES = Object.freeze([
  { key: 'change1hPct', label: '1h', weight: 0.10, referencePct: 4 },
  { key: 'change4hPct', label: '4h', weight: 0.15, referencePct: 8 },
  { key: 'change12hPct', label: '12h', weight: 0.20, referencePct: 12 },
  { key: 'change24hPct', label: '24h', weight: 0.30, referencePct: 18 },
  { key: 'change7dPct', label: '7d', weight: 0.25, referencePct: 35 },
]);

// A single timeframe may not dominate: one -40% hour cannot claim -400 stretch.
const MOMENTUM_UNIT_CAP = 1.5;
// Bounded BTC-relative nudge, in score points.
const BTC_RELATIVE_MAX_POINTS = 12;
const BTC_RELATIVE_REFERENCE_PCT = 12;
// Volatility normalization band: a coin that routinely moves 15%/day needs a
// bigger drop to read oversold; a 1%/day stablecoin-like pair needs less.
const VOLATILITY_REFERENCE_PCT = 5;
const VOLATILITY_FACTOR_MIN = 0.5;
const VOLATILITY_FACTOR_MAX = 3;

// History layer bounds. Points are irregular samples of a collector, not
// candles, so the RSI is labelled "sampled" and the window span is reported.
const HISTORY_MIN_POINTS = 12;
const HISTORY_MIN_WINDOW_MS = 30 * 60 * 1000;
const HISTORY_RSI_MAX_PERIOD = 14;
const HISTORY_CONFIDENT_POINTS = 24;
const HISTORY_CONFIDENT_WINDOW_MS = 6 * 60 * 60 * 1000;
// Stored 1h/24h/7d changes may fill momentum gaps only while genuinely fresh.
const HISTORY_CHANGES_MAX_AGE_MS = 90 * 60 * 1000;

const HISTORY_COMPONENT_WEIGHTS = Object.freeze({
  rangePercentile: 0.45,
  sampledRsi: 0.35,
  zScore: 0.20,
});

const SCOPE_NOTE = 'Valuation is relative to this coin\'s own recent range and momentum — not a fundamental valuation, and not an entry signal.';

// Presence-preserving numeric read: null/undefined/'' are ABSENT (null), a
// measured 0 stays 0. Never use Number() directly on these inputs.
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function toMs(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Extracts the momentum inputs a market/candidate row can supply. Absent
 * fields stay null so the caller can report them as missing rather than
 * scoring them as flat.
 */
export function valuationInputsFromMarket(market) {
  const m = market && typeof market === 'object' ? market : {};
  const diag = m.diagnostics && typeof m.diagnostics === 'object' ? m.diagnostics : {};
  return {
    change1hPct: num(m.change1hPct ?? diag.change1hPct),
    change4hPct: num(m.change4hPct ?? diag.change4hPct),
    change12hPct: num(m.change12hPct ?? diag.change12hPct),
    change24hPct: num(m.change24hPct ?? m.priceChangePercent ?? diag.change24hPct),
    change7dPct: num(m.change7dPct ?? diag.change7dPct),
    btcRelativeChangePct: num(m.btcRelativeChangePct ?? m.relativeToBtcPct),
    atrPct: num(m.atrPct ?? m.realizedVolatilityPct),
  };
}

/**
 * Momentum layer. Returns { available, score, ... }; `available:false` with a
 * `reason` when the row carries no usable timeframe change at all.
 */
export function computeMomentumValuation(inputs = {}) {
  const src = inputs && typeof inputs === 'object' ? inputs : {};
  const atrPct = num(src.atrPct);
  // Volatility normalization is applied only when volatility is actually known.
  const volatilityFactor = atrPct !== null && atrPct > 0
    ? clamp(atrPct / VOLATILITY_REFERENCE_PCT, VOLATILITY_FACTOR_MIN, VOLATILITY_FACTOR_MAX)
    : 1;

  const contributions = [];
  const missing = [];
  let weighted = 0;
  let weightSum = 0;
  for (const tf of MOMENTUM_TIMEFRAMES) {
    const changePct = num(src[tf.key]);
    if (changePct === null) {
      missing.push(tf.key);
      continue;
    }
    const reference = tf.referencePct * volatilityFactor;
    const units = clamp(changePct / reference, -MOMENTUM_UNIT_CAP, MOMENTUM_UNIT_CAP);
    weighted += units * tf.weight;
    weightSum += tf.weight;
    contributions.push({
      timeframe: tf.label,
      field: tf.key,
      changePct: round(changePct, 2),
      referencePct: round(reference, 2),
      units: round(units, 3),
      weight: tf.weight,
    });
  }

  if (weightSum <= 0) {
    return {
      available: false,
      reason: 'no timeframe change data on the row',
      score: null,
      volatilityFactor: round(volatilityFactor, 3),
      volatilityKnown: atrPct !== null && atrPct > 0,
      btcRelativeChangePct: num(src.btcRelativeChangePct) === null ? null : round(num(src.btcRelativeChangePct), 2),
      btcRelativePoints: null,
      contributions: [],
      timeframesUsed: 0,
      missing,
      inputs: { ...src },
    };
  }

  let score = (weighted / weightSum) * 100;

  // Down harder than BTC = more dislocated. Bounded, and never the whole read.
  const btcRel = num(src.btcRelativeChangePct);
  let btcRelativePoints = null;
  if (btcRel !== null) {
    btcRelativePoints = clamp(btcRel / BTC_RELATIVE_REFERENCE_PCT, -1, 1) * BTC_RELATIVE_MAX_POINTS;
    score += btcRelativePoints;
  } else {
    missing.push('btcRelativeChangePct');
  }
  if (atrPct === null || !(atrPct > 0)) missing.push('atrPct');

  return {
    available: true,
    reason: null,
    score: round(clamp(score, -100, 100), 1),
    volatilityFactor: round(volatilityFactor, 3),
    volatilityKnown: atrPct !== null && atrPct > 0,
    btcRelativeChangePct: btcRel === null ? null : round(btcRel, 2),
    btcRelativePoints: btcRelativePoints === null ? null : round(btcRelativePoints, 1),
    contributions,
    timeframesUsed: contributions.length,
    missing,
    inputs: { ...src },
  };
}

// Normalizes stored `market_price_points` rows (pg numerics arrive as strings)
// into ascending { t, price } samples, dropping unusable rows. Mirrors the
// normalization in _price-history-signals.mjs so the two agree on what counts.
function normalizeHistoryPoints(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const point of points) {
    if (!point || typeof point !== 'object') continue;
    const t = toMs(point.sampled_at ?? point.sampledAt);
    const price = num(point.price_usd ?? point.priceUsd);
    if (t === null || price === null || !(price > 0)) continue;
    out.push({
      t,
      price,
      change1hPct: num(point.change_1h_pct ?? point.change1hPct),
      change24hPct: num(point.change_24h_pct ?? point.change24hPct),
      change7dPct: num(point.change_7d_pct ?? point.change7dPct),
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Wilder RSI over an irregularly sampled close series. Returns null when the
// series is too short for the requested period — never a 50 placeholder, which
// would read as a genuine neutral measurement.
function sampledWilderRsi(prices, period) {
  if (!Array.isArray(prices) || prices.length < period + 1 || period < 2) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = prices[i] - prices[i - 1];
    if (delta >= 0) gainSum += delta;
    else lossSum -= delta;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < prices.length; i += 1) {
    const delta = prices[i] - prices[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }
  // A series with no movement at all has NO defined RSI. Returning the
  // conventional 50 here would manufacture a "neutral measurement" out of an
  // absence of data — and a flat window would then read FAIR instead of
  // FLAT_WINDOW. Undefined stays undefined.
  if (avgGain === 0 && avgLoss === 0) return null;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * History layer over stored price points. Returns
 * { available:false, status, reason } when there is not enough usable history —
 * INSUFFICIENT_HISTORY and NO_HISTORY are distinct from a computed reading.
 */
export function computeHistoryValuation(points, options = {}) {
  const minPoints = Number.isInteger(options.minPoints) && options.minPoints > 2
    ? options.minPoints
    : HISTORY_MIN_POINTS;
  const series = normalizeHistoryPoints(points);
  const base = {
    available: false,
    status: 'NO_HISTORY',
    reason: 'no stored price history for this symbol',
    score: null,
    rangePercentile: null,
    sampledRsi: null,
    rsiPeriod: null,
    zScore: null,
    meanDeviationPct: null,
    windowLow: null,
    windowHigh: null,
    windowMeanPrice: null,
    latestPrice: null,
    pointsUsed: 0,
    windowHours: null,
    latestPointAgeMs: null,
    storedChanges: null,
    componentsUsed: [],
    source: 'price_history_db',
  };
  if (series.length === 0) return base;

  const spanMs = series[series.length - 1].t - series[0].t;
  if (series.length < minPoints || spanMs < HISTORY_MIN_WINDOW_MS) {
    return {
      ...base,
      status: 'INSUFFICIENT_HISTORY',
      reason: `need >= ${minPoints} points spanning >= ${Math.round(HISTORY_MIN_WINDOW_MS / 60000)}m, have ${series.length} spanning ${Math.round(spanMs / 60000)}m`,
      pointsUsed: series.length,
      windowHours: round(spanMs / 3600000, 2),
    };
  }

  const prices = series.map((p) => p.price);
  const latest = prices[prices.length - 1];
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  const variance = prices.reduce((sum, p) => sum + ((p - mean) ** 2), 0) / prices.length;
  const stdev = Math.sqrt(variance);

  // A perfectly flat window has no range to be cheap or expensive inside of.
  const rangePercentile = high > low ? ((latest - low) / (high - low)) * 100 : null;
  const zScore = stdev > 0 ? (latest - mean) / stdev : null;
  const meanDeviationPct = mean > 0 ? ((latest - mean) / mean) * 100 : null;
  const rsiPeriod = Math.min(HISTORY_RSI_MAX_PERIOD, Math.floor(series.length / 2));
  const sampledRsi = sampledWilderRsi(prices, rsiPeriod);

  const componentsUsed = [];
  let weighted = 0;
  let weightSum = 0;
  if (rangePercentile !== null) {
    weighted += ((rangePercentile - 50) / 50) * HISTORY_COMPONENT_WEIGHTS.rangePercentile;
    weightSum += HISTORY_COMPONENT_WEIGHTS.rangePercentile;
    componentsUsed.push('rangePercentile');
  }
  if (sampledRsi !== null) {
    weighted += ((sampledRsi - 50) / 50) * HISTORY_COMPONENT_WEIGHTS.sampledRsi;
    weightSum += HISTORY_COMPONENT_WEIGHTS.sampledRsi;
    componentsUsed.push('sampledRsi');
  }
  if (zScore !== null) {
    weighted += clamp(zScore / 2, -1, 1) * HISTORY_COMPONENT_WEIGHTS.zScore;
    weightSum += HISTORY_COMPONENT_WEIGHTS.zScore;
    componentsUsed.push('zScore');
  }

  const newest = series[series.length - 1];
  const nowMs = toMs(options.now) ?? newest.t;
  const latestPointAgeMs = Math.max(0, nowMs - newest.t);
  const storedChangesUsable = latestPointAgeMs <= HISTORY_CHANGES_MAX_AGE_MS;
  const storedChanges = {
    change1hPct: newest.change1hPct,
    change24hPct: newest.change24hPct,
    change7dPct: newest.change7dPct,
    ageMs: latestPointAgeMs,
    usable: storedChangesUsable
      && (newest.change1hPct !== null || newest.change24hPct !== null || newest.change7dPct !== null),
  };

  const measured = {
    ...base,
    status: 'OK',
    rangePercentile: round(rangePercentile, 1),
    sampledRsi: round(sampledRsi, 1),
    rsiPeriod,
    zScore: round(zScore, 2),
    meanDeviationPct: round(meanDeviationPct, 2),
    windowLow: round(low, 8),
    windowHigh: round(high, 8),
    windowMeanPrice: round(mean, 8),
    latestPrice: round(latest, 8),
    pointsUsed: series.length,
    windowHours: round(spanMs / 3600000, 2),
    latestPointAgeMs,
    storedChanges,
    componentsUsed,
  };

  if (weightSum <= 0) {
    return {
      ...measured,
      available: false,
      status: 'FLAT_WINDOW',
      reason: 'stored window has no price range, deviation, or RSI to measure',
    };
  }

  return {
    ...measured,
    available: true,
    reason: null,
    score: round(clamp((weighted / weightSum) * 100, -100, 100), 1),
  };
}

export function valuationBandFromScore(score) {
  const value = num(score);
  if (value === null) return VALUATION_BANDS.UNKNOWN;
  if (value <= VALUATION_THRESHOLDS.deeplyOversold) return VALUATION_BANDS.DEEPLY_OVERSOLD;
  if (value <= VALUATION_THRESHOLDS.oversold) return VALUATION_BANDS.OVERSOLD;
  if (value >= VALUATION_THRESHOLDS.deeplyOverbought) return VALUATION_BANDS.DEEPLY_OVERBOUGHT;
  if (value >= VALUATION_THRESHOLDS.overbought) return VALUATION_BANDS.OVERBOUGHT;
  return VALUATION_BANDS.FAIR;
}

export function valuationDirectionFromBand(band) {
  if (band === VALUATION_BANDS.DEEPLY_OVERSOLD || band === VALUATION_BANDS.OVERSOLD) return VALUATION_DIRECTIONS.OVERSOLD;
  if (band === VALUATION_BANDS.DEEPLY_OVERBOUGHT || band === VALUATION_BANDS.OVERBOUGHT) return VALUATION_DIRECTIONS.OVERBOUGHT;
  if (band === VALUATION_BANDS.FAIR) return VALUATION_DIRECTIONS.NEUTRAL;
  return VALUATION_DIRECTIONS.UNKNOWN;
}

export function valuationBandLabel(band) {
  return {
    [VALUATION_BANDS.DEEPLY_OVERSOLD]: 'Deeply oversold',
    [VALUATION_BANDS.OVERSOLD]: 'Oversold',
    [VALUATION_BANDS.FAIR]: 'Fair range',
    [VALUATION_BANDS.OVERBOUGHT]: 'Overbought',
    [VALUATION_BANDS.DEEPLY_OVERBOUGHT]: 'Deeply overbought',
  }[band] || 'Unknown';
}

// Do the two layers tell the same story? null when one of them is missing.
function layerAgreement(momentumScore, historyScore) {
  if (momentumScore === null || historyScore === null) return null;
  const bandOf = (score) => valuationDirectionFromBand(valuationBandFromScore(score));
  const a = bandOf(momentumScore);
  const b = bandOf(historyScore);
  if (a === b) return true;
  // NEUTRAL next to a directional read is a partial, not a contradiction.
  return a === VALUATION_DIRECTIONS.NEUTRAL || b === VALUATION_DIRECTIONS.NEUTRAL ? null : false;
}

function buildSummary({ band, score, momentum, history, confidence, layersAgree }) {
  if (band === VALUATION_BANDS.UNKNOWN) {
    return 'Valuation unknown — not enough data to place this coin inside its own recent range.';
  }
  const parts = [];
  parts.push(`${valuationBandLabel(band)} (${score > 0 ? '+' : ''}${score}) vs its own recent range`);
  if (history.available) {
    const bits = [];
    if (history.rangePercentile !== null) bits.push(`${history.rangePercentile}% of the ${history.windowHours}h stored range`);
    if (history.sampledRsi !== null) bits.push(`sampled RSI ${history.sampledRsi}`);
    if (history.meanDeviationPct !== null) bits.push(`${history.meanDeviationPct > 0 ? '+' : ''}${history.meanDeviationPct}% vs window mean`);
    if (bits.length) parts.push(bits.join(', '));
  }
  if (momentum.available && momentum.timeframesUsed > 0) {
    parts.push(`${momentum.timeframesUsed} timeframe${momentum.timeframesUsed === 1 ? '' : 's'} of momentum`);
  }
  parts.push(`confidence ${confidence}`);
  if (layersAgree === false) parts.push('momentum and stored history disagree');
  return `${parts.join('; ')}.`;
}

function buildBlockers({ momentum, history, layersAgree }) {
  const blockers = [];
  if (!momentum.available) blockers.push(momentum.reason || 'momentum layer unavailable');
  if (!history.available) blockers.push(history.reason || 'stored price history unavailable');
  if (layersAgree === false) blockers.push('momentum and stored-history layers disagree — treat the band as low conviction');
  if (momentum.available && !momentum.volatilityKnown) {
    blockers.push('no volatility (ATR) on the row — momentum stretch is not volatility-normalized');
  }
  // Advisory only, stated without directional trading wording (the house rule for
  // RADAR display strings): a band describes where price sits, never what to do.
  blockers.push('advisory only — a valuation band is a context read, never an entry or exit trigger; RADAR entry gates are unchanged');
  return Array.from(new Set(blockers)).slice(0, 8);
}

// Assembles the final, self-describing valuation block from two already-computed
// layers. Kept separate from the layer math so both the momentum-only path and
// the history-merged path produce a byte-identical output shape.
function assembleValuation(momentum, history) {
  const momentumScore = momentum.available ? num(momentum.score) : null;
  const historyScore = history.available ? num(history.score) : null;

  let score = null;
  let basis = 'none';
  if (momentumScore !== null && historyScore !== null) {
    // Stored history is the range-relative evidence, so it carries more weight
    // than a momentum read that can be a single 24h number.
    score = round((momentumScore * 0.45) + (historyScore * 0.55), 1);
    basis = 'momentum+history';
  } else if (historyScore !== null) {
    score = historyScore;
    basis = 'history_only';
  } else if (momentumScore !== null) {
    score = momentumScore;
    basis = 'momentum_only';
  }

  const layersAgree = layerAgreement(momentumScore, historyScore);
  const band = valuationBandFromScore(score);
  const direction = valuationDirectionFromBand(band);

  // Confidence never outruns the evidence: momentum alone is 'low', a stored
  // window alone is 'medium', and 'high' additionally requires the two layers to
  // agree over a deep enough window. Disagreement pulls it back to 'low'.
  let confidence;
  if (basis === 'none') confidence = 'unknown';
  else if (basis === 'momentum_only') confidence = 'low';
  else if (basis === 'history_only') confidence = 'medium';
  else if (layersAgree === true
    && history.pointsUsed >= HISTORY_CONFIDENT_POINTS
    && Number(history.windowHours) * 3600000 >= HISTORY_CONFIDENT_WINDOW_MS) confidence = 'high';
  else if (layersAgree === false) confidence = 'low';
  else confidence = 'medium';

  const missingInputs = Array.from(new Set([
    ...(Array.isArray(momentum.missing) ? momentum.missing : []),
    ...(history.available ? [] : ['storedPriceHistory']),
  ])).slice(0, 10);

  return {
    VALUATION_BAND: band,
    VALUATION_LABEL: valuationBandLabel(band),
    VALUATION_DIRECTION: direction,
    VALUATION_SCORE: band === VALUATION_BANDS.UNKNOWN ? null : score,
    VALUATION_CONFIDENCE: confidence,
    VALUATION_BASIS: basis,
    VALUATION_SUMMARY: buildSummary({ band, score, momentum, history, confidence, layersAgree }),
    VALUATION_BLOCKERS: buildBlockers({ momentum, history, layersAgree }),
    VALUATION_MISSING_INPUTS: missingInputs,
    momentum,
    history,
    layersAgree,
    thresholds: VALUATION_THRESHOLDS,
    // Honesty contract — asserted by tests, read by the UI so an operator can
    // never mistake this block for a gate or a trade instruction.
    isEntrySignal: false,
    affectsGate: false,
    affectsTelegram: false,
    scope: 'relative_to_own_recent_range',
    note: SCOPE_NOTE,
  };
}

/**
 * Momentum-only valuation for one market/candidate row. This is what the RADAR
 * evaluator attaches to every candidate: it needs no database, so every row
 * gets at least a low-confidence, honestly-labelled reading. The history layer
 * is merged in later by mergeValuationHistory().
 */
export function buildValuationContext({ market } = {}) {
  const momentum = computeMomentumValuation(valuationInputsFromMarket(market));
  const history = computeHistoryValuation(null);
  return assembleValuation(momentum, history);
}

/**
 * Re-assembles a valuation block with a stored-history layer merged in.
 *
 * When the row itself lacked 1h/24h/7d changes and the newest stored point
 * carries fresh ones, those fill the momentum gaps — the only place stored data
 * substitutes for row data, bounded by HISTORY_CHANGES_MAX_AGE_MS and reported
 * via momentum.filledFromHistory. Returns a fresh object; the input is never
 * mutated. Never throws: an unusable layer degrades to the momentum-only read.
 */
export function mergeValuationHistory(valuation, history) {
  const previous = valuation && typeof valuation === 'object' ? valuation : null;
  const baseMomentum = previous && previous.momentum && typeof previous.momentum === 'object'
    ? previous.momentum
    : computeMomentumValuation({});
  // Only a well-formed layer (one this module produced) is trusted. Anything
  // else — null, a bare object, a number — is replaced with a proper
  // unavailable layer so the UI always reads a complete block with a named
  // reason instead of a half-shaped object with undefined fields.
  const isLayer = history && typeof history === 'object'
    && typeof history.status === 'string'
    && typeof history.available === 'boolean';
  const historyLayer = isLayer
    ? history
    : { ...computeHistoryValuation(null), status: 'UNKNOWN', reason: 'stored-history valuation layer unavailable' };

  const stored = historyLayer.storedChanges;
  const inputs = baseMomentum.inputs && typeof baseMomentum.inputs === 'object' ? { ...baseMomentum.inputs } : {};
  const filledFromHistory = [];
  if (stored && stored.usable === true) {
    for (const key of ['change1hPct', 'change24hPct', 'change7dPct']) {
      if (num(inputs[key]) === null && num(stored[key]) !== null) {
        inputs[key] = stored[key];
        filledFromHistory.push(key);
      }
    }
  }
  const momentum = filledFromHistory.length
    ? { ...computeMomentumValuation(inputs), filledFromHistory, filledFromHistorySource: 'price_history_db' }
    : { ...baseMomentum, filledFromHistory: [], filledFromHistorySource: null };

  return assembleValuation(momentum, historyLayer);
}

/**
 * Counts the bands across a candidate list, for the RADAR summary line and the
 * Oversold/Overbought filter chips. Candidates with no valuation block count as
 * unknown — never as fair.
 */
export function summarizeValuationBands(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const summary = {
    total: rows.length,
    deeplyOversold: 0,
    oversold: 0,
    fair: 0,
    overbought: 0,
    deeplyOverbought: 0,
    unknown: 0,
    historyBacked: 0,
    momentumOnly: 0,
  };
  for (const row of rows) {
    const valuation = row && typeof row === 'object' && row.valuation && typeof row.valuation === 'object'
      ? row.valuation
      : null;
    const band = valuation ? valuation.VALUATION_BAND : VALUATION_BANDS.UNKNOWN;
    if (band === VALUATION_BANDS.DEEPLY_OVERSOLD) summary.deeplyOversold += 1;
    else if (band === VALUATION_BANDS.OVERSOLD) summary.oversold += 1;
    else if (band === VALUATION_BANDS.FAIR) summary.fair += 1;
    else if (band === VALUATION_BANDS.OVERBOUGHT) summary.overbought += 1;
    else if (band === VALUATION_BANDS.DEEPLY_OVERBOUGHT) summary.deeplyOverbought += 1;
    else summary.unknown += 1;
    if (valuation && valuation.VALUATION_BASIS === 'momentum_only') summary.momentumOnly += 1;
    if (valuation && (valuation.VALUATION_BASIS === 'momentum+history' || valuation.VALUATION_BASIS === 'history_only')) {
      summary.historyBacked += 1;
    }
  }
  summary.oversoldTotal = summary.deeplyOversold + summary.oversold;
  summary.overboughtTotal = summary.deeplyOverbought + summary.overbought;
  return summary;
}
