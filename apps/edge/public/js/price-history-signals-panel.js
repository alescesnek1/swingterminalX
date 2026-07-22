// ─────────────────────────────────────────────────────────────
// Swing Terminal — Admin price-history reclaim/absorption diagnostics
// (pure, no DOM, no fetch, no network)
//
// Phase 1: read-only UI diagnostics for BTC/ETH only, sourced from the
// already-live, admin-only GET /api/admin-price-history-signals
// (netlify/functions/admin-price-history-signals.mjs). That endpoint is
// pure read (DB SELECT only, no writes, no trading/RADAR/alert side
// effects) and already fails closed to 'UNKNOWN' / 'INSUFFICIENT_HISTORY'
// on missing or insufficient data — this module never reinterprets or
// upgrades a signal, it only validates shape and supplies safe fallback
// text for malformed/missing fields so the panel can never crash or
// silently show nothing.
//
// This is a terminal heuristic diagnostics display, NOT a trading
// recommendation: no directional trading-action wording is ever rendered
// here — only the backend's own diagnostic status/signal/reason codes.
// ─────────────────────────────────────────────────────────────

function safeSignalBlock(block) {
  if (!block || typeof block !== 'object') {
    return { status: 'UNKNOWN', signal: 'UNKNOWN', reason: 'No data.', confidence: 'low' };
  }
  const status = typeof block.status === 'string' && block.status ? block.status : 'UNKNOWN';
  const signal = typeof block.signal === 'string' && block.signal ? block.signal : 'UNKNOWN';
  const reason = typeof block.reason === 'string' ? block.reason : '';
  const confidence = typeof block.confidence === 'string' && block.confidence ? block.confidence : 'low';
  const out = { status, signal, reason, confidence };
  // Preserve the browser-orderbook support direction ('bid'|'ask'|'neutral')
  // when a merge set it, so the readiness decision can read it without a
  // second source. Additive: absent on history-only / reclaim blocks.
  if (block.orderbookSupport === 'bid' || block.orderbookSupport === 'ask' || block.orderbookSupport === 'neutral') {
    out.orderbookSupport = block.orderbookSupport;
  }
  return out;
}

/**
 * Shapes one /api/admin-price-history-signals response into a render model.
 * Never throws — any unusable input degrades to an explicit error/unknown
 * model, never a fabricated reading.
 */
export function priceHistorySignalRenderModel(apiResponse, symbolFallback) {
  const r = apiResponse && typeof apiResponse === 'object' ? apiResponse : {};
  const symbol = typeof r.symbol === 'string' && r.symbol ? r.symbol : (symbolFallback || null);

  if (r.ok !== true) {
    const unavailable = r.reason === 'DB_UNAVAILABLE';
    return {
      ok: false,
      symbol,
      status: unavailable ? 'DB_UNAVAILABLE' : 'ERROR',
      reasonCode: unavailable ? 'DB_UNAVAILABLE' : 'ERROR',
      reasonText: unavailable ? 'Price-history database unavailable in this environment.' : '',
      points: 0,
      error: true,
      statusText: unavailable ? 'Unavailable' : 'Could not load price-history signals.',
      reclaim: safeSignalBlock(null),
      absorption: safeSignalBlock(null),
      orderbookModeText: 'Unknown',
      orderbookReasonText: '',
    };
  }

  const points = Number.isInteger(r.points) ? r.points : 0;
  const apiStatus = typeof r.status === 'string' && r.status ? r.status : 'OK';
  const reclaim = safeSignalBlock(r.reclaim);
  const absorption = safeSignalBlock(r.absorption);
  const orderbookMode = typeof r.orderbookMode === 'string' && r.orderbookMode ? r.orderbookMode : 'external_browser_required';
  const orderbookReason = typeof r.orderbookReason === 'string' ? r.orderbookReason : '';
  const orderbookUsed = r.orderbookUsed === true;
  const orderbookSource = typeof r.orderbookSource === 'string' && r.orderbookSource ? r.orderbookSource : null;

  // Honest orderbook label (display only — no analysis/confidence change).
  // When the browser-side merge succeeds (price-history-orderbook.js sets
  // orderbookSource:'browser_api_orderbook' + orderbookUsed:true) a REAL live
  // book was applied, so the panel must never still read "External browser
  // required" — that stale label plus orderbookReason:'OK' produced the
  // misleading "External browser required (OK)". A live book is labelled as
  // such; the "external browser required" wording is kept ONLY for the true
  // history-only fallback where no book was used.
  let orderbookModeText;
  if (orderbookSource === 'browser_api_orderbook') {
    orderbookModeText = 'Browser live book';
  } else if (orderbookUsed) {
    orderbookModeText = orderbookMode === 'server' || orderbookSource === 'server' ? 'Server orderbook' : 'Browser live book';
  } else {
    orderbookModeText = orderbookMode === 'server' ? 'Server orderbook' : 'External browser required';
  }

  return {
    ok: true,
    symbol,
    status: apiStatus,
    points,
    error: false,
    statusText: apiStatus === 'NO_HISTORY' ? 'No scheduled history yet.'
      : apiStatus === 'INSUFFICIENT_HISTORY' || points === 0 ? 'Insufficient history'
        : `${points} history point${points === 1 ? '' : 's'}`,
    reclaim,
    absorption,
    orderbookUsed,
    orderbookModeText,
    orderbookReasonText: orderbookReason,
  };
}

export function priceHistorySignalErrorModel(message, kind) {
  const unavailable = kind === 'DB_UNAVAILABLE';
  return {
    ok: false,
    symbol: null,
    status: unavailable ? 'DB_UNAVAILABLE' : 'ERROR',
    reasonCode: unavailable ? 'DB_UNAVAILABLE' : (kind || 'ERROR'),
    reasonText: unavailable ? 'Price-history database unavailable in this environment.' : '',
    points: 0,
    error: true,
    statusText: message || (unavailable ? 'Unavailable' : 'Could not load price-history signals.'),
    reclaim: safeSignalBlock(null),
    absorption: safeSignalBlock(null),
    orderbookUsed: false,
    orderbookModeText: 'Unknown',
    orderbookReasonText: '',
  };
}

export function priceHistorySignalSignedOutModel() {
  return priceHistorySignalErrorModel('Sign in as an admin to view price-history diagnostics.');
}

// ─────────────────────────────────────────────────────────────
// RADAR-facing derived signal STATE codes (pure, no DOM/fetch).
//
// The Cockpit model above already fails closed to safe defaults; these
// functions add one more layer on top — collapsing the backend's raw
// status/signal/reason strings into a small, closed set of STATE codes a
// RADAR badge can switch on directly, so the UI never has to special-case
// backend string values itself. NO_RECLAIM/NO_ABSORPTION are neutral
// outcomes (the analysis ran fine and found nothing) and must never be
// styled as broken; ORDERBOOK_DEGRADED/ERROR are the only states meant to
// read as a problem.
// ─────────────────────────────────────────────────────────────

// The exact top-level reason the backend emits when BOTH the Node->Edge
// orderbook bridge AND the Binance-direct fallback failed for the
// documented, known reason (see admin-price-history-signals.mjs's "KNOWN
// PRODUCTION CONSTRAINT" header comment: bridge 502 + fallback 451, i.e.
// Netlify's Node runtime cannot itself reach a Binance book right now).
// That specific combined-failure code is today's expected baseline, not a
// surprise outage, so it renders as the calmer HISTORY_ONLY state. Any
// OTHER non-'OK' orderbook reason (auth rejected, invalid pair, an
// unexpected HTTP code, a fetch failure, a malformed upstream body) is
// something beyond that known baseline and renders as ORDERBOOK_DEGRADED.
const BASELINE_ORDERBOOK_REASON = 'ORDERBOOK_UNAVAILABLE';

/** One of ACTIVE_RECLAIM | NO_RECLAIM | INSUFFICIENT_HISTORY | UNKNOWN | ERROR. */
export function priceHistoryReclaimState(model) {
  if (model && model.status === 'DB_UNAVAILABLE') return 'DB_UNAVAILABLE';
  if (!model || model.ok !== true) return 'ERROR';
  const rc = model.reclaim || {};
  if (rc.status === 'INSUFFICIENT_HISTORY') return 'INSUFFICIENT_HISTORY';
  if (rc.signal === 'BULLISH_RECLAIM') return 'ACTIVE_RECLAIM';
  // FAILED_RECLAIM ("broke above the level but fell back below it") is
  // still a neutral, non-error outcome — collapsed into NO_RECLAIM rather
  // than given its own badge, per the product's 5-state reclaim model.
  if (rc.signal === 'NO_RECLAIM' || rc.signal === 'FAILED_RECLAIM') return 'NO_RECLAIM';
  return 'UNKNOWN';
}

/**
 * One of ABSORPTION | NO_ABSORPTION | HISTORY_ONLY | ORDERBOOK_DEGRADED |
 * INSUFFICIENT_HISTORY | UNKNOWN | ERROR.
 */
export function priceHistoryAbsorptionState(model) {
  if (model && model.status === 'DB_UNAVAILABLE') return 'DB_UNAVAILABLE';
  if (!model || model.ok !== true) return 'ERROR';
  const ab = model.absorption || {};
  if (ab.status === 'INSUFFICIENT_HISTORY') return 'INSUFFICIENT_HISTORY';
  if (ab.signal === 'BULLISH_ABSORPTION' || ab.signal === 'BEARISH_ABSORPTION') return 'ABSORPTION';
  if (model.orderbookUsed !== true) {
    const reason = model.orderbookReasonText || '';
    return (reason === BASELINE_ORDERBOOK_REASON || !reason) ? 'HISTORY_ONLY' : 'ORDERBOOK_DEGRADED';
  }
  if (ab.signal === 'NO_ABSORPTION') return 'NO_ABSORPTION';
  return 'UNKNOWN';
}

const RADAR_STATE_LABELS = {
  ACTIVE_RECLAIM: 'Reclaim',
  NO_RECLAIM: 'No reclaim',
  ABSORPTION: 'Absorption',
  NO_ABSORPTION: 'No absorption',
  HISTORY_ONLY: 'History-only',
  ORDERBOOK_DEGRADED: 'Orderbook degraded',
  ORDERBOOK_UNAVAILABLE: 'Orderbook unavailable',
  INSUFFICIENT_HISTORY: 'Insufficient history',
  AUTH_REQUIRED: 'Admin sign-in required',
  FETCH_ERROR: 'Fetch error',
  MALFORMED_RESPONSE: 'Malformed response',
  UNKNOWN: 'Unknown',
  ERROR: 'Error',
  DB_UNAVAILABLE: 'Unavailable',
};

// Every state sorts into exactly one tone so the RADAR badge colours
// consistently and a human can read severity in one glance:
//   positive — a real detected signal (reclaim/absorption)
//   neutral  — analysis ran fine, found nothing actionable (never "broken")
//   degraded — worked but on a reduced data source (history-only / no book)
//   error    — transport/endpoint/auth/data problem — could not evaluate
//   waiting  — nothing to show yet (no selected symbol / insufficient data)
const RADAR_STATE_TONES = {
  ACTIVE_RECLAIM: 'positive',
  ABSORPTION: 'positive',
  NO_RECLAIM: 'neutral',
  NO_ABSORPTION: 'neutral',
  HISTORY_ONLY: 'degraded',
  ORDERBOOK_DEGRADED: 'degraded',
  ORDERBOOK_UNAVAILABLE: 'degraded',
  INSUFFICIENT_HISTORY: 'waiting',
  UNKNOWN: 'waiting',
  AUTH_REQUIRED: 'error',
  FETCH_ERROR: 'error',
  MALFORMED_RESPONSE: 'error',
  ERROR: 'error',
  DB_UNAVAILABLE: 'degraded',
};

const TRANSPORT_ERROR_STATES = new Set(['AUTH_REQUIRED', 'FETCH_ERROR', 'MALFORMED_RESPONSE', 'ERROR', 'DB_UNAVAILABLE']);

/** Conservative, fixed display text for a state code — no directional trading-action wording. */
export function radarSignalStateLabel(stateCode) {
  return RADAR_STATE_LABELS[stateCode] || 'Unknown';
}

/** One of positive | neutral | degraded | error | waiting. Never throws. */
export function radarSignalStateTone(stateCode) {
  return RADAR_STATE_TONES[stateCode] || 'waiting';
}

// RADAR candidate symbols are venue PAIRS (e.g. "BTCUSDT", "ERAUSDC") — the
// scanner adds a stablecoin quote. The price-history DB stores BASE symbols
// ("BTC", "ERA"). This strips a known quote suffix so the admin endpoint is
// queried by base symbol; if no known quote is present the symbol is already
// a base (many DEX tokens) and is returned as-is rather than dropped. Kept in
// the pure module (not terminal.js) so the exact mapping is unit-testable.
const RADAR_QUOTE_SUFFIXES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USD'];

/** "BTCUSDT" -> "BTC", "ERAUSDC" -> "ERA", "PEPE" -> "PEPE", "" -> null. */
export function radarBaseSymbolFromPair(pairSymbol) {
  const sym = typeof pairSymbol === 'string' ? pairSymbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  if (!sym) return null;
  for (const quote of RADAR_QUOTE_SUFFIXES) {
    if (sym.endsWith(quote) && sym.length > quote.length) return sym.slice(0, -quote.length);
  }
  return sym;
}

/**
 * Full RADAR-facing render model: the Cockpit model's safe fields plus the
 * two derived state codes a RADAR badge switches on.
 */
export function radarPriceHistorySignalRenderModel(apiResponse, symbolFallback) {
  const base = priceHistorySignalRenderModel(apiResponse, symbolFallback);
  return {
    ...base,
    reclaimState: priceHistoryReclaimState(base),
    absorptionState: priceHistoryAbsorptionState(base),
  };
}

// ─────────────────────────────────────────────────────────────
// PRICE-HISTORY READINESS DECISION (pure, no DOM/fetch)
//
// Turns the already-derived reclaim/absorption STATE codes into a single,
// normalized decision object the Focus Candidate card can display as an
// explicit VERDICT (reclaim/absorption/orderbook-support + blockers) rather
// than a wall of raw diagnostics — this is the "analyze, don't just show"
// step the product wants.
//
// HARD BOUNDARIES (fail-closed, advisory only):
//   • This is a FRONTEND, price-history + point-in-time-orderbook readiness
//     read. It is NOT strict rolling absorption and NOT the server's
//     ENTRY_READY / Telegram / SETUP / EXECUTION gate. Nothing here changes
//     any of those — the caller renders it as a separate, labeled verdict.
//   • Missing/insufficient inputs stay UNKNOWN. It NEVER manufactures a
//     directional (bullish/bearish) call from missing data, and NEVER claims
//     flow / OI / funding / strict absorption it does not have.
//   • orderbook support is 'unknown' unless a real browser book was merged
//     (orderbookUsed === true); confidence is capped to 'medium' without a
//     book so a history-only read can never read as high-confidence.
// ─────────────────────────────────────────────────────────────

// reclaimState -> CONFIRMED | NOT_CONFIRMED | UNKNOWN (fail-closed: anything
// that is not a clean detected/absent outcome stays UNKNOWN).
function _phReclaimVerdict(reclaimState) {
  if (reclaimState === 'ACTIVE_RECLAIM') return 'CONFIRMED';
  if (reclaimState === 'NO_RECLAIM') return 'NOT_CONFIRMED';
  return 'UNKNOWN';
}

// absorptionState -> CONFIRMED | NOT_CONFIRMED | UNKNOWN. Only a real detected
// absorption confirms; a clean no-absorption is NOT_CONFIRMED; history-only,
// degraded, insufficient, unknown, or error all stay UNKNOWN (never forced to
// a directional read).
function _phAbsorptionVerdict(absorptionState) {
  if (absorptionState === 'ABSORPTION') return 'CONFIRMED';
  if (absorptionState === 'NO_ABSORPTION') return 'NOT_CONFIRMED';
  return 'UNKNOWN';
}

const _PH_CONFIDENCE_ORDER = ['low', 'medium', 'high'];
function _phCapConfidence(confidence, hasBook) {
  const c = _PH_CONFIDENCE_ORDER.includes(confidence) ? confidence : 'low';
  // Without a live book a history-only read can never be "high".
  if (!hasBook && c === 'high') return 'medium';
  return c;
}

/**
 * Normalized readiness decision from a RADAR price-history render model
 * (the shape returned by radarPriceHistorySignalRenderModel, optionally after
 * a browser-orderbook merge that set orderbookUsed:true). Never throws.
 *
 * Returns:
 *   { reclaim, absorption, orderbookSupport, confidence, source,
 *     readyForExecutionContext, blockers, note }
 * where reclaim/absorption are CONFIRMED|NOT_CONFIRMED|UNKNOWN,
 * orderbookSupport is 'yes'|'no'|'unknown', and readyForExecutionContext is a
 * DISPLAY-ONLY readiness flag — never a gate.
 */
export function priceHistoryReadinessDecision(model) {
  const m = model && typeof model === 'object' ? model : {};
  const NOTE = 'Frontend price-history readiness — advisory only; does not change server ENTRY_READY, Telegram, or setup/execution score.';

  // A hard error / unavailable model is entirely UNKNOWN.
  if (m.ok !== true || m.error === true || m.status === 'DB_UNAVAILABLE') {
    return {
      reclaim: 'UNKNOWN',
      absorption: 'UNKNOWN',
      orderbookSupport: 'unknown',
      confidence: 'low',
      source: 'price_history',
      readyForExecutionContext: false,
      blockers: ['price-history signals unavailable'],
      note: NOTE,
    };
  }

  const hasBook = m.orderbookUsed === true;
  const reclaim = _phReclaimVerdict(m.reclaimState);
  const absorption = _phAbsorptionVerdict(m.absorptionState);

  // orderbook support only exists when a real book was merged.
  const rawSupport = m.absorption && typeof m.absorption === 'object' ? m.absorption.orderbookSupport : null;
  let orderbookSupport;
  if (!hasBook) orderbookSupport = 'unknown';
  else if (rawSupport === 'bid') orderbookSupport = 'yes';
  else if (rawSupport === 'ask' || rawSupport === 'neutral') orderbookSupport = 'no';
  else orderbookSupport = 'unknown';

  const absConfidence = m.absorption && typeof m.absorption === 'object' ? m.absorption.confidence : 'low';
  const confidence = _phCapConfidence(absConfidence, hasBook);

  const blockers = [];
  if (reclaim !== 'CONFIRMED') blockers.push(reclaim === 'UNKNOWN' ? 'reclaim unknown (insufficient history)' : 'reclaim not confirmed');
  if (absorption !== 'CONFIRMED') blockers.push(absorption === 'UNKNOWN' ? 'absorption unknown (needs history or live book)' : 'absorption not confirmed');
  if (!hasBook) blockers.push('orderbook support unknown (no live book)');
  else if (orderbookSupport !== 'yes') blockers.push('orderbook does not support the read');

  // DISPLAY-ONLY readiness context: all three price-history dimensions positive
  // AND a real book present. This is never a gate — it can never set
  // ENTRY_READY or Telegram, which are server-owned.
  const readyForExecutionContext = reclaim === 'CONFIRMED'
    && absorption === 'CONFIRMED'
    && hasBook
    && orderbookSupport === 'yes';

  return {
    reclaim,
    absorption,
    orderbookSupport,
    confidence,
    source: hasBook ? 'price_history+browser_orderbook' : 'price_history',
    readyForExecutionContext,
    blockers,
    note: NOTE,
  };
}

/**
 * Error model for the RADAR section. `kind` distinguishes the transport
 * failure (auth vs. network/HTTP vs. malformed body) so the UI can show the
 * specific, honest reason rather than a generic "error". Defaults to the
 * generic ERROR so existing callers/tests keep the ERROR/ERROR contract.
 */
export function radarPriceHistorySignalErrorModel(message, kind) {
  const state = TRANSPORT_ERROR_STATES.has(kind) ? kind : 'ERROR';
  const base = priceHistorySignalErrorModel(message);
  return { ...base, reclaimState: state, absorptionState: state };
}

// ─────────────────────────────────────────────────────────────
// BACKEND price-history SCORING context (pure, no DOM/fetch).
//
// This is a DIFFERENT source from everything above. The models above shape
// the FRONTEND advisory read (the admin GET /api/admin-price-history-signals
// fetch + optional browser orderbook merge). The functions below shape the
// SERVER-owned `priceHistoryContext` + score-adjustment fields the trading
// radar attached to the candidate itself
// (netlify/functions/_price-history-radar-context.mjs + scripts/radar/
// trading-radar.mjs). That backend context is the ONLY price-history read
// that actually moved SETUP_SCORE (+2 reclaim / +1 history-only absorption,
// capped +3). It is attached to the top-five ranked candidates only, so a
// focused candidate outside that set legitimately has none — which must be
// stated honestly ('ABSENT'), never rendered as a failure or conflated with
// the advisory frontend read.
//
// HARD BOUNDARIES (mirrors the backend contract, display only): this context
// never affects EXECUTION_SCORE and never affects Telegram eligibility.
// Missing/unknown inputs stay UNKNOWN; nothing here is a gate.
// ─────────────────────────────────────────────────────────────

const BACKEND_PH_NOTE = 'Backend price-history scoring support — the only price-history read that moves SETUP_SCORE (capped +3). Never affects EXECUTION_SCORE or Telegram.';

function _phBackendState(status) {
  return status === 'CONFIRMED' ? 'CONFIRMED' : status === 'NOT_CONFIRMED' ? 'NOT_CONFIRMED' : 'UNKNOWN';
}

/**
 * Normalized display model for the SERVER-owned price-history scoring context
 * carried on a radar candidate. Never throws.
 *
 * When the candidate carries no `priceHistoryContext` (it is not one of the
 * top-five price-history-scored candidates) the model is explicitly ABSENT
 * with a plain-language blocker — it is never rendered as a failed/negative
 * reading.
 */
export function radarBackendPriceHistoryModel(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const ctx = c.priceHistoryContext && typeof c.priceHistoryContext === 'object' ? c.priceHistoryContext : null;
  const adjRaw = Number(c.priceHistoryScoreAdjustment);
  const adjustment = Number.isFinite(adjRaw) ? Math.max(0, Math.min(3, Math.round(adjRaw))) : 0;
  const usedForScoring = c.priceHistoryUsedForScoring === true;
  const gate = c.priceHistoryGateSupport && typeof c.priceHistoryGateSupport === 'object' ? c.priceHistoryGateSupport : {};
  const gateReclaim = gate.reclaim === true;
  const gateAbsorption = gate.absorption === true;
  const gateBlockers = Array.isArray(c.priceHistoryGateBlockers) ? c.priceHistoryGateBlockers.slice(0, 8) : [];

  if (!ctx) {
    return {
      present: false,
      status: 'ABSENT',
      points: 0,
      reclaim: 'UNKNOWN',
      reclaimReason: '',
      absorption: 'UNKNOWN',
      absorptionMode: null,
      absorptionConfidence: 'unknown',
      absorptionReason: '',
      adjustment: 0,
      usedForScoring: false,
      gateReclaim: false,
      gateAbsorption: false,
      blockers: ['not in the top-five price-history-scored set — backend scoring support N/A for this symbol'],
      affectsExecution: false,
      affectsTelegram: false,
      source: 'price_history_db',
      note: BACKEND_PH_NOTE,
    };
  }

  const rc = ctx.reclaim && typeof ctx.reclaim === 'object' ? ctx.reclaim : {};
  const ab = ctx.absorption && typeof ctx.absorption === 'object' ? ctx.absorption : {};
  const blockers = gateBlockers.length ? gateBlockers : (Array.isArray(ctx.blockers) ? ctx.blockers.slice(0, 8) : []);
  return {
    present: true,
    status: typeof ctx.status === 'string' && ctx.status ? ctx.status : 'UNKNOWN',
    points: Number.isInteger(ctx.points) ? ctx.points : 0,
    reclaim: _phBackendState(rc.status),
    reclaimReason: typeof rc.reason === 'string' ? rc.reason : '',
    absorption: _phBackendState(ab.status),
    absorptionMode: typeof ab.mode === 'string' && ab.mode ? ab.mode : 'history_only',
    absorptionConfidence: ['low', 'medium', 'high'].includes(ab.confidence) ? ab.confidence : 'unknown',
    absorptionReason: typeof ab.reason === 'string' ? ab.reason : '',
    adjustment,
    usedForScoring,
    gateReclaim,
    gateAbsorption,
    blockers,
    affectsExecution: false,
    affectsTelegram: false,
    source: 'price_history_db',
    note: BACKEND_PH_NOTE,
  };
}

/**
 * Compact, source-labeled breakdown of the backend SETUP adjustment for a
 * candidate — used by the RADAR table's Setup cell tag/tooltip so the +N is
 * traceable to reclaim (+2) / history-only absorption (+1). Never throws.
 */
export function radarBackendPriceHistoryAdjustmentBreakdown(candidate) {
  const m = radarBackendPriceHistoryModel(candidate);
  const parts = [];
  if (m.gateReclaim) parts.push('+2 price-history reclaim');
  if (m.gateAbsorption) parts.push('+1 history-only absorption');
  let summary;
  if (m.adjustment > 0) {
    summary = `+${m.adjustment} setup from price-history (${parts.join(', ') || 'capped +3'}). No effect on execution score or Telegram.`;
  } else if (m.present) {
    summary = 'Price-history evaluated but added nothing to setup (no confirmed reclaim / history-only absorption).';
  } else {
    summary = 'Not in the top-five price-history-scored set — backend setup support N/A for this symbol.';
  }
  return { adjustment: m.adjustment, usedForScoring: m.usedForScoring, present: m.present, parts, summary };
}

if (typeof window !== 'undefined') {
  window.__priceHistorySignalsPanel = {
    toRenderModel: priceHistorySignalRenderModel,
    errorModel: priceHistorySignalErrorModel,
    signedOutModel: priceHistorySignalSignedOutModel,
    reclaimState: priceHistoryReclaimState,
    absorptionState: priceHistoryAbsorptionState,
    stateLabel: radarSignalStateLabel,
    stateTone: radarSignalStateTone,
    baseSymbolFromPair: radarBaseSymbolFromPair,
    toRadarRenderModel: radarPriceHistorySignalRenderModel,
    radarErrorModel: radarPriceHistorySignalErrorModel,
    readinessDecision: priceHistoryReadinessDecision,
    backendModel: radarBackendPriceHistoryModel,
    backendAdjustmentBreakdown: radarBackendPriceHistoryAdjustmentBreakdown,
  };
}
