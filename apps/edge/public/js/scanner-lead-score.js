// ─────────────────────────────────────────────────────────────
// Swing Terminal — Scanner "Lead Score" (pure, no DOM, no fetch)
//
// ADVISORY ONLY. Answers ONE question for a scanner row: does the
// futures/perp side look like it is LEADING or AMPLIFYING the spot move?
//
//   HIGH / EXTREME → futures pressure is probably driving the spot move
//   MED            → some futures influence, not decisive
//   LOW            → the move does not look strongly futures-led
//   UNKNOWN        → the required data is not there
//
// It is NOT a trade signal and NOT an entry gate. It never reaches
// RADAR, ENTRY_READY, STRICT_ABSORB, the reclaim gates, Telegram,
// alerts, the auto trader, or any order path — it is computed in the
// browser, rendered into one scanner cell, and thrown away.
//
// ── Data honesty (fail-closed) ───────────────────────────────
// Every component is OPTIONAL and must be *proven present* before it
// counts. A missing component is listed in `missing`, never silently
// substituted with a neutral or favourable value:
//   • `Number(null) === 0` is the recurring defect class in this repo,
//     so every reader rejects null / '' / boolean BEFORE Number().
//   • `_funding: 0` / `_takerRatio: 0.5` placeholders that ride along on
//     the markets payload are NOT real readings — callers must not pass
//     them in. This module only ever sees what the caller can prove.
//   • Open interest and taker flow are not collected per scanner row
//     today; they resolve to `missing` for nearly every coin and the
//     score is damped accordingly rather than pretending coverage.
//   • Missing data never becomes a direction. `direction` stays
//     'unknown' or 'mixed' unless a present component votes.
//
// Scored in isolation so it is unit-testable; terminal.js (a classic
// <script>) consumes it through `window.__scannerLeadScore`.
// ─────────────────────────────────────────────────────────────

export const LEAD_SCORE_ADVISORY_NOTE =
  'advisory only — does not affect RADAR entry gates';

// Component weights. They sum to 1 so `coverage` below is a true 0..1
// fraction of the evidence this model would like to have.
export const LEAD_SCORE_WEIGHTS = Object.freeze({
  premium: 0.24,      // futures mark vs spot last  (basis)
  volumeRatio: 0.20,  // futures 24h quote volume vs spot 24h quote volume
  moveGap: 0.18,      // futures 24h % vs spot 24h %
  oi: 0.14,           // open-interest change %
  funding: 0.14,      // funding rate %
  flow: 0.10,         // taker buy/sell imbalance
});

// Saturation points — the reading at which a component is "fully" strong.
const SAT = Object.freeze({
  premiumPct: 0.60,     // 0.60 % basis is already a loud perp premium
  // A liquid perp NORMALLY turns over several times its spot book — that is
  // standing venue structure, not evidence about today's move. Only the
  // excess above VOLUME_RATIO_FLOOR counts, and it takes an unusual multiple
  // to saturate; otherwise every major coin would read MED all day.
  volumeRatio: 15,
  moveGapPct: 1.5,      // 1.5 pp gap between the futures and spot 24h move
  oiChangePct: 12,
  fundingPct: 0.05,     // 0.05 % per 8h funding is extreme
  flowImbalance: 0.20,  // taker buy ratio 0.70 / 0.30
});
// Futures turnover at or below this multiple of spot is ordinary market
// structure and contributes nothing.
const VOLUME_RATIO_FLOOR = 3;

// A component only votes on direction once it clears its own noise floor.
// Below the floor it still contributes magnitude, but it stays neutral —
// a 0.001 % basis is not evidence that futures are pushing the tape up.
const DIRECTION_FLOOR = Object.freeze({
  premiumPct: 0.05,
  moveGapPct: 0.25,
  // Binance's BASE funding rate is 0.01 % per 8h — the resting state of a
  // perp with no lean. Anything inside that band is not directional evidence.
  fundingPct: 0.015,
  flowImbalance: 0.04,
});

// Label thresholds. Deliberately conservative at the top end.
const LABEL_BANDS = Object.freeze([
  { max: 25, label: 'LOW' },
  { max: 55, label: 'MED' },
  { max: 80, label: 'HIGH' },
  { max: Infinity, label: 'EXTREME' },
]);
const MED_CEILING = 54;    // one lone component can never beat this
const HIGH_CEILING = 79;   // two components / conflict can never beat this
const STRONG_COMPONENT = 0.7;

// Human labels for the evidence + missing lists.
const COMPONENT_LABELS = Object.freeze({
  premium: 'futures/spot premium',
  volumeRatio: 'futures/spot 24h volume',
  moveGap: 'futures vs spot 24h move',
  oi: 'open interest change',
  funding: 'funding rate',
  flow: 'taker buy/sell flow',
});

// "The pair comparisons". At least one of these must be present, because
// they are the only components that actually compare the futures side to
// the spot side. Funding/OI/flow on their own describe the perp in
// isolation and say nothing about it LEADING spot.
const CORE_COMPONENTS = Object.freeze(['premium', 'volumeRatio', 'moveGap']);

// ── readers ──────────────────────────────────────────────────
// Strict finite-number reader. Rejects null, undefined, '', booleans and
// numeric-looking junk BEFORE Number() gets a chance to coerce them to 0.
function num(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// Positive-only reader for prices and volumes: a price or a 24h turnover
// of 0 (or below) is "not reported", not a real market reading.
function pos(v) {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function sat(value, ceiling) { return clamp01(Math.abs(value) / ceiling); }
function round(v, dp) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * Normalise whatever the caller could prove into the component input shape.
 * Everything is optional; anything unreadable becomes null.
 */
export function normalizeLeadScoreInput(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    spotPrice: pos(r.spotPrice),
    futuresPrice: pos(r.futuresPrice),
    spotQuoteVolume24h: pos(r.spotQuoteVolume24h),
    futuresQuoteVolume24h: pos(r.futuresQuoteVolume24h),
    spotChange24hPct: num(r.spotChange24hPct),
    futuresChange24hPct: num(r.futuresChange24hPct),
    openInterestChangePct: num(r.openInterestChangePct),
    fundingPct: num(r.fundingPct),
    takerBuyRatio: (() => {
      const n = num(r.takerBuyRatio);
      // A ratio outside (0,1) is not a buy share — reject rather than clamp.
      return n !== null && n > 0 && n < 1 ? n : null;
    })(),
  };
}

// ── components ───────────────────────────────────────────────
// Each returns { strength: 0..1, vote: 'up'|'down'|'neutral', detail: string }
// or null when its inputs are not both present.
function componentPremium(i) {
  if (i.spotPrice === null || i.futuresPrice === null) return null;
  const pct = ((i.futuresPrice - i.spotPrice) / i.spotPrice) * 100;
  if (!Number.isFinite(pct)) return null;
  const vote = Math.abs(pct) < DIRECTION_FLOOR.premiumPct ? 'neutral' : (pct > 0 ? 'up' : 'down');
  return {
    strength: sat(pct, SAT.premiumPct),
    vote,
    value: round(pct, 3),
    detail: `futures ${pct >= 0 ? '+' : ''}${round(pct, 3)}% vs spot`,
  };
}

function componentVolumeRatio(i) {
  if (i.spotQuoteVolume24h === null || i.futuresQuoteVolume24h === null) return null;
  const ratio = i.futuresQuoteVolume24h / i.spotQuoteVolume24h;
  if (!Number.isFinite(ratio)) return null;
  // Only the EXCESS over the ordinary multiple counts; at or below the floor
  // (including when spot is the bigger venue) this contributes 0 rather than
  // going negative or rewarding normal structure.
  const strength = clamp01((ratio - VOLUME_RATIO_FLOOR) / (SAT.volumeRatio - VOLUME_RATIO_FLOOR));
  return {
    strength,
    vote: 'neutral', // turnover has size, not a side
    value: round(ratio, 2),
    detail: `futures 24h volume ${round(ratio, 2)}x spot`,
  };
}

function componentMoveGap(i) {
  if (i.spotChange24hPct === null || i.futuresChange24hPct === null) return null;
  const gap = i.futuresChange24hPct - i.spotChange24hPct;
  if (!Number.isFinite(gap)) return null;
  const vote = Math.abs(gap) < DIRECTION_FLOOR.moveGapPct ? 'neutral' : (gap > 0 ? 'up' : 'down');
  return {
    strength: sat(gap, SAT.moveGapPct),
    vote,
    value: round(gap, 2),
    detail: `futures 24h move ${gap >= 0 ? '+' : ''}${round(gap, 2)}pp vs spot`,
  };
}

function componentOi(i) {
  if (i.openInterestChangePct === null) return null;
  return {
    strength: sat(i.openInterestChangePct, SAT.oiChangePct),
    // Rising OI can accompany either side; it is size, never a direction.
    vote: 'neutral',
    value: round(i.openInterestChangePct, 2),
    detail: `open interest ${i.openInterestChangePct >= 0 ? '+' : ''}${round(i.openInterestChangePct, 2)}%`,
  };
}

function componentFunding(i) {
  if (i.fundingPct === null) return null;
  const vote = Math.abs(i.fundingPct) < DIRECTION_FLOOR.fundingPct
    ? 'neutral'
    : (i.fundingPct > 0 ? 'up' : 'down');
  return {
    strength: sat(i.fundingPct, SAT.fundingPct),
    vote,
    value: round(i.fundingPct, 4),
    detail: `funding ${i.fundingPct >= 0 ? '+' : ''}${round(i.fundingPct, 4)}%`,
  };
}

function componentFlow(i) {
  if (i.takerBuyRatio === null) return null;
  const imbalance = i.takerBuyRatio - 0.5;
  const vote = Math.abs(imbalance) < DIRECTION_FLOOR.flowImbalance
    ? 'neutral'
    : (imbalance > 0 ? 'up' : 'down');
  return {
    strength: sat(imbalance, SAT.flowImbalance),
    vote,
    value: round(i.takerBuyRatio, 3),
    detail: `taker buy share ${round(i.takerBuyRatio * 100, 1)}%`,
  };
}

const COMPONENT_FNS = Object.freeze({
  premium: componentPremium,
  volumeRatio: componentVolumeRatio,
  moveGap: componentMoveGap,
  oi: componentOi,
  funding: componentFunding,
  flow: componentFlow,
});

function bandFor(score) {
  for (const b of LABEL_BANDS) if (score < b.max) return b.label;
  return 'EXTREME';
}

/**
 * Pure Lead Score.
 *
 * @returns {{
 *   score: number|null, label: string, direction: string, confidence: string,
 *   coverage: number, present: string[], missing: string[],
 *   evidence: string[], conflict: boolean, advisory: string
 * }}
 * `score` is null ONLY when `label === 'UNKNOWN'`.
 */
export function computeLeadScore(raw) {
  const input = normalizeLeadScoreInput(raw);

  const present = [];
  const missing = [];
  const evidence = [];
  let presentWeight = 0;
  let weighted = 0;
  let strongCount = 0;
  let upVotes = 0;
  let downVotes = 0;

  for (const key of Object.keys(LEAD_SCORE_WEIGHTS)) {
    const part = COMPONENT_FNS[key](input);
    if (!part || !Number.isFinite(part.strength)) {
      missing.push(COMPONENT_LABELS[key]);
      continue;
    }
    present.push(key);
    evidence.push(part.detail);
    const w = LEAD_SCORE_WEIGHTS[key];
    presentWeight += w;
    weighted += w * part.strength;
    if (part.strength >= STRONG_COMPONENT) strongCount += 1;
    if (part.vote === 'up') upVotes += 1;
    else if (part.vote === 'down') downVotes += 1;
  }

  const hasCore = CORE_COMPONENTS.some((k) => present.includes(k));

  // Fail closed. Without a futures-vs-spot comparison there is nothing
  // here about futures LEADING spot, whatever else happens to be present.
  if (!present.length || !hasCore) {
    return {
      score: null,
      label: 'UNKNOWN',
      direction: 'unknown',
      confidence: 'none',
      coverage: 0,
      present: present.slice(),
      missing,
      evidence,
      conflict: false,
      advisory: LEAD_SCORE_ADVISORY_NOTE,
    };
  }

  const coverage = clamp01(presentWeight);
  // Average over what is PRESENT, then damp by how much of the model we
  // actually observed. Thin evidence cannot reach a loud score.
  const base = (weighted / presentWeight) * 100;
  let score = base * (0.55 + 0.45 * coverage);

  const conflict = upVotes > 0 && downVotes > 0;
  if (conflict) score *= 0.6;

  // Caps — each is a "we do not know enough to shout this loudly" rule.
  //   • a single component, however loud, tops out at MED;
  //   • EXTREME needs >=3 components, >=2 of them individually strong,
  //     and no contradiction between them.
  if (present.length < 2) score = Math.min(score, MED_CEILING);
  if (conflict || present.length < 3 || strongCount < 2) score = Math.min(score, HIGH_CEILING);

  score = Math.max(0, Math.min(100, Math.round(score)));

  let direction;
  if (conflict) direction = 'mixed';
  else if (upVotes > 0) direction = 'futures-led up';
  else if (downVotes > 0) direction = 'futures-led down';
  else direction = 'unknown';

  let confidence;
  if (present.length >= 4 && coverage >= 0.6 && !conflict) confidence = 'high';
  else if (present.length >= 2) confidence = conflict ? 'low' : 'medium';
  else confidence = 'low';

  return {
    score,
    label: bandFor(score),
    direction,
    confidence,
    coverage: round(coverage, 2),
    present: present.slice(),
    missing,
    evidence,
    conflict,
    advisory: LEAD_SCORE_ADVISORY_NOTE,
  };
}

/**
 * Render-ready model. Every string field is guaranteed non-empty and free
 * of 'null' / 'undefined' / 'NaN', so the cell can never leak a placeholder.
 */
export function buildLeadScoreDisplay(raw) {
  const r = computeLeadScore(raw);
  const unknown = r.label === 'UNKNOWN' || r.score === null;
  const scoreText = unknown ? '--' : String(r.score);
  const display = unknown ? 'UNKNOWN' : `${scoreText} ${r.label}`;

  const lines = [
    `Lead Score: ${unknown ? 'UNKNOWN' : `${scoreText} / 100 · ${r.label}`}`,
    `Futures pressure on the spot move · direction: ${r.direction}`,
    `Confidence: ${r.confidence} · evidence coverage ${Math.round(r.coverage * 100)}%`,
    r.evidence.length ? `Evidence: ${r.evidence.join(' · ')}` : 'Evidence: none',
    r.missing.length ? `Missing: ${r.missing.join(' · ')}` : 'Missing: none',
  ];
  if (r.conflict) lines.push('Conflicting evidence — confidence reduced.');
  lines.push(LEAD_SCORE_ADVISORY_NOTE);

  return {
    score: r.score,
    scoreText,
    label: r.label,
    display,
    direction: r.direction,
    confidence: r.confidence,
    evidence: r.evidence,
    missing: r.missing,
    conflict: r.conflict,
    advisory: LEAD_SCORE_ADVISORY_NOTE,
    cssClass: `lead-score--${r.label.toLowerCase()}`,
    tooltip: lines.join('\n'),
  };
}

/**
 * Pull the component inputs off a live scanner row.
 *
 * `row._leadVenue` is the additive spot/futures venue snapshot attached by
 * terminal.js (canonical /api/context dedupe, or the /api/markets fields).
 * `funding` is the caller-supplied real funding reading (the divergence
 * feed) — NEVER `row._funding`, which is a hard-coded 0 placeholder.
 * Open interest and taker flow are not collected per scanner row today, so
 * they stay absent unless a caller can prove a real reading.
 */
export function leadScoreInputFromRow(row, extra) {
  const r = row && typeof row === 'object' ? row : {};
  const e = extra && typeof extra === 'object' ? extra : {};
  const venue = r._leadVenue && typeof r._leadVenue === 'object' ? r._leadVenue : {};
  const spot = venue.spot && typeof venue.spot === 'object' ? venue.spot : {};
  const fut = venue.futures && typeof venue.futures === 'object' ? venue.futures : {};
  return {
    spotPrice: spot.price,
    futuresPrice: fut.price,
    spotQuoteVolume24h: spot.quoteVolume24h,
    futuresQuoteVolume24h: fut.quoteVolume24h,
    spotChange24hPct: spot.change24hPct,
    futuresChange24hPct: fut.change24hPct,
    fundingPct: e.fundingPct,
    openInterestChangePct: e.openInterestChangePct,
    takerBuyRatio: e.takerBuyRatio,
  };
}

export function leadScoreForRow(row, extra) {
  return buildLeadScoreDisplay(leadScoreInputFromRow(row, extra));
}

if (typeof window !== 'undefined') {
  window.__scannerLeadScore = {
    computeLeadScore,
    buildLeadScoreDisplay,
    leadScoreInputFromRow,
    leadScoreForRow,
    LEAD_SCORE_ADVISORY_NOTE,
  };
}
