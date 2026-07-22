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
  return { status, signal, reason, confidence };
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
    orderbookUsed: r.orderbookUsed === true,
    orderbookModeText: orderbookMode === 'server' ? 'Server orderbook' : 'External browser required',
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
  };
}
