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

// Degraded basis used when the row has no matched spot leg. Same machinery,
// different evidence: this describes the PERP's own pressure, which is why it
// carries its own weights, an honesty discount, and a hard label ceiling.
export const FUTURES_ONLY_WEIGHTS = Object.freeze({
  futuresTurnover: 0.25, // absolute 24h perp turnover (log-scaled)
  futuresMove: 0.30,     // 24h move strength on the perp
  funding: 0.20,
  oi: 0.15,
  flow: 0.10,
});
// A futures-only read cannot see spot, so it can never be as informative as a
// paired one. Discount it rather than let it compete on equal terms.
const FUTURES_ONLY_DAMP = 0.85;
const FUTURES_ONLY_NOTE = 'No matched spot leg found — score uses futures pressure only.';
const SPOT_ONLY_NOTE = 'No futures venue found for this asset — nothing futures-side can be leading it here.';
// Perp turnover below this is not a pressure signal at any scale.
const FUTURES_TURNOVER_FLOOR_USD = 5e6;

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
  futuresTurnoverUsd: 5e9, // $5B/24h perp turnover saturates the size read
  futuresMovePct: 15,      // a 15 % 24h perp move is a full-strength push
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
  futuresMovePct: 1.5,
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
  futuresTurnover: 'futures 24h turnover',
  futuresMove: 'futures 24h move',
});

// Every basis the score can report, so callers can switch on a closed set.
export const LEAD_SCORE_BASES = Object.freeze([
  'FULL_SPOT_FUTURES', // both legs, real futures-vs-spot comparison
  'FUTURES_ONLY',      // perp pressure only, no matched spot leg
  'SPOT_ONLY',         // spot listing with no futures venue
  'NO_VENUE_PAIR',     // venue data present but nothing comparable
  'NO_USABLE_DATA',    // nothing readable at all
]);

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

// ── futures-only components ──────────────────────────────────
// Used when the row has NO matched spot leg. These describe the perp's own
// pressure; they cannot claim it is leading spot, and the basis says so.
function componentFuturesTurnover(i) {
  if (i.futuresQuoteVolume24h === null) return null;
  // Log-scaled: perp turnover spans orders of magnitude ($1M .. $20B), so a
  // linear scale would read every non-major as zero.
  const decades = (Math.log10(i.futuresQuoteVolume24h) - Math.log10(FUTURES_TURNOVER_FLOOR_USD))
    / (Math.log10(SAT.futuresTurnoverUsd) - Math.log10(FUTURES_TURNOVER_FLOOR_USD));
  return {
    strength: clamp01(decades),
    vote: 'neutral', // turnover has size, not a side
    detail: `futures 24h turnover $${compactUsd(i.futuresQuoteVolume24h)}`,
  };
}

function componentFuturesMove(i) {
  if (i.futuresChange24hPct === null) return null;
  const vote = Math.abs(i.futuresChange24hPct) < DIRECTION_FLOOR.futuresMovePct
    ? 'neutral'
    : (i.futuresChange24hPct > 0 ? 'up' : 'down');
  return {
    strength: sat(i.futuresChange24hPct, SAT.futuresMovePct),
    vote,
    detail: `futures 24h move ${i.futuresChange24hPct >= 0 ? '+' : ''}${round(i.futuresChange24hPct, 2)}%`,
  };
}

function compactUsd(v) {
  if (v >= 1e9) return `${round(v / 1e9, 2)}B`;
  if (v >= 1e6) return `${round(v / 1e6, 1)}M`;
  if (v >= 1e3) return `${round(v / 1e3, 1)}K`;
  return String(round(v, 2));
}

const COMPONENT_FNS = Object.freeze({
  premium: componentPremium,
  volumeRatio: componentVolumeRatio,
  moveGap: componentMoveGap,
  oi: componentOi,
  funding: componentFunding,
  flow: componentFlow,
  futuresTurnover: componentFuturesTurnover,
  futuresMove: componentFuturesMove,
});

function bandFor(score) {
  for (const b of LABEL_BANDS) if (score < b.max) return b.label;
  return 'EXTREME';
}

// Run one weight table over the input and collect everything the caller needs
// to score it. Shared by the full and the futures-only paths so the two can
// never drift apart on damping, conflict handling, or the missing-data list.
function tally(input, weights) {
  const present = [];
  const missing = [];
  const evidence = [];
  let presentWeight = 0;
  let weighted = 0;
  let strongCount = 0;
  let upVotes = 0;
  let downVotes = 0;

  for (const key of Object.keys(weights)) {
    const part = COMPONENT_FNS[key](input);
    if (!part || !Number.isFinite(part.strength)) {
      missing.push(COMPONENT_LABELS[key]);
      continue;
    }
    present.push(key);
    evidence.push(part.detail);
    const w = weights[key];
    presentWeight += w;
    weighted += w * part.strength;
    if (part.strength >= STRONG_COMPONENT) strongCount += 1;
    if (part.vote === 'up') upVotes += 1;
    else if (part.vote === 'down') downVotes += 1;
  }
  return { present, missing, evidence, presentWeight, weighted, strongCount, upVotes, downVotes };
}

// Turn a tally into the scored result. `extraDamp` (<=1) is the honesty
// discount applied to a degraded basis; `ceiling` is a hard label cap.
function scoreFromTally(t, { extraDamp = 1, ceiling = 100 } = {}) {
  const coverage = clamp01(t.presentWeight);
  const base = (t.weighted / t.presentWeight) * 100;
  let score = base * (0.55 + 0.45 * coverage) * extraDamp;

  const conflict = t.upVotes > 0 && t.downVotes > 0;
  if (conflict) score *= 0.6;

  // Caps — each is a "we do not know enough to shout this loudly" rule.
  //   • a single component, however loud, tops out at MED;
  //   • EXTREME needs >=3 components, >=2 of them individually strong,
  //     and no contradiction between them.
  if (t.present.length < 2) score = Math.min(score, MED_CEILING);
  if (conflict || t.present.length < 3 || t.strongCount < 2) score = Math.min(score, HIGH_CEILING);
  score = Math.min(score, ceiling);
  score = Math.max(0, Math.min(100, Math.round(score)));

  let direction;
  if (conflict) direction = 'mixed';
  else if (t.upVotes > 0) direction = 'futures-led up';
  else if (t.downVotes > 0) direction = 'futures-led down';
  else direction = 'unknown';

  let confidence;
  if (t.present.length >= 4 && coverage >= 0.6 && !conflict) confidence = 'high';
  else if (t.present.length >= 2) confidence = conflict ? 'low' : 'medium';
  else confidence = 'low';

  return {
    score,
    label: bandFor(score),
    direction,
    confidence,
    coverage: round(coverage, 2),
    present: t.present.slice(),
    missing: t.missing,
    evidence: t.evidence,
    conflict,
    advisory: LEAD_SCORE_ADVISORY_NOTE,
  };
}

function unknownResult(basis, missing, note) {
  return {
    score: null,
    label: 'UNKNOWN',
    basis,
    basisNote: note,
    direction: 'unknown',
    confidence: 'none',
    coverage: 0,
    present: [],
    missing,
    evidence: [],
    conflict: false,
    advisory: LEAD_SCORE_ADVISORY_NOTE,
  };
}

// Is there anything readable on this venue at all?
function venueUsable(price, volume, change) {
  return price !== null || volume !== null || change !== null;
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
  const hasSpot = venueUsable(input.spotPrice, input.spotQuoteVolume24h, input.spotChange24hPct);
  const hasFutures = venueUsable(input.futuresPrice, input.futuresQuoteVolume24h, input.futuresChange24hPct);

  // ── 1. FULL: both legs present and at least one real comparison ──
  // Unchanged from the original model — this is still the only basis that
  // can actually claim futures are leading SPOT, because it is the only one
  // that measures the two against each other.
  if (hasSpot && hasFutures) {
    const t = tally(input, LEAD_SCORE_WEIGHTS);
    if (CORE_COMPONENTS.some((k) => t.present.includes(k))) {
      return {
        ...scoreFromTally(t),
        basis: 'FULL_SPOT_FUTURES',
        basisNote: 'Spot and futures both available — full futures-vs-spot comparison.',
      };
    }
  }

  // ── 2. FUTURES_ONLY: degraded futures-pressure read ──
  // No matched spot leg (or nothing comparable across the two). We can still
  // describe how hard the PERP is being pushed — but not that it is leading
  // spot, so the result is damped, capped, and labelled FUTURES_ONLY.
  if (hasFutures) {
    const t = tally(input, FUTURES_ONLY_WEIGHTS);
    // Needs a real pressure reading, not just a lone funding/OI number.
    if (t.present.includes('futuresTurnover') || t.present.includes('futuresMove')) {
      // EXTREME requires >=3 individually strong components; otherwise HIGH is
      // the ceiling — a futures-only read is never allowed to top the scale on
      // thin evidence.
      const ceiling = t.strongCount >= 3 ? 100 : HIGH_CEILING;
      const scored = scoreFromTally(t, { extraDamp: FUTURES_ONLY_DAMP, ceiling });
      return {
        ...scored,
        basis: 'FUTURES_ONLY',
        basisNote: FUTURES_ONLY_NOTE,
        // Direction on this basis is the perp's OWN push, not a lead over spot.
        direction: scored.direction === 'futures-led up' ? 'futures pressure up'
          : scored.direction === 'futures-led down' ? 'futures pressure down'
            : scored.direction,
      };
    }
  }

  // ── 3. SPOT_ONLY: a real spot listing with no futures venue ──
  // There is no perp for this asset in our universe, so within this system's
  // data nothing futures-side can be driving it. That is a genuine LOW, not
  // an absence of information — but the basis says exactly why.
  if (hasSpot) {
    const missing = [...CORE_COMPONENTS, 'oi', 'funding', 'flow'].map((k) => COMPONENT_LABELS[k]);
    return {
      score: 0,
      label: 'LOW',
      basis: 'SPOT_ONLY',
      basisNote: SPOT_ONLY_NOTE,
      direction: 'unknown',
      confidence: 'low',
      coverage: 0,
      present: [],
      missing,
      evidence: ['spot venue only — no Binance futures leg for this asset'],
      conflict: false,
      advisory: LEAD_SCORE_ADVISORY_NOTE,
    };
  }

  // ── 4. Nothing usable ──
  const allMissing = Object.keys(COMPONENT_LABELS).map((k) => COMPONENT_LABELS[k]);
  const bothVenuesSeen = input.spotPrice !== null || input.futuresPrice !== null;
  return bothVenuesSeen
    ? unknownResult('NO_VENUE_PAIR', allMissing, 'Venue data present but nothing comparable could be read.')
    : unknownResult('NO_USABLE_DATA', allMissing, 'No usable spot or futures market data for this row.');
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

  const basis = LEAD_SCORE_BASES.includes(r.basis) ? r.basis : 'NO_USABLE_DATA';
  const basisNote = typeof r.basisNote === 'string' && r.basisNote ? r.basisNote : 'Basis unavailable.';

  const lines = [
    `Lead Score: ${unknown ? 'UNKNOWN' : `${scoreText} / 100 · ${r.label}`}`,
    `Futures pressure on the spot move · direction: ${r.direction}`,
    `Basis: ${basis} — ${basisNote}`,
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
    basis,
    basisNote,
    direction: r.direction,
    confidence: r.confidence,
    evidence: r.evidence,
    missing: r.missing,
    conflict: r.conflict,
    advisory: LEAD_SCORE_ADVISORY_NOTE,
    cssClass: `lead-score--${r.label.toLowerCase()}`,
    // Degraded bases get a muted marker so a FUTURES_ONLY 70 never looks
    // like a fully-evidenced 70 at a glance.
    basisClass: `lead-basis--${basis.toLowerCase().replace(/_/g, '-')}`,
    degraded: basis !== 'FULL_SPOT_FUTURES',
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
