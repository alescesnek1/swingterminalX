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
    return {
      ok: false,
      symbol,
      points: 0,
      error: true,
      statusText: 'Insufficient history',
      reclaim: safeSignalBlock(null),
      absorption: safeSignalBlock(null),
      orderbookModeText: 'Unknown',
      orderbookReasonText: '',
    };
  }

  const points = Number.isInteger(r.points) ? r.points : 0;
  const reclaim = safeSignalBlock(r.reclaim);
  const absorption = safeSignalBlock(r.absorption);
  const orderbookMode = typeof r.orderbookMode === 'string' && r.orderbookMode ? r.orderbookMode : 'external_browser_required';
  const orderbookReason = typeof r.orderbookReason === 'string' ? r.orderbookReason : '';

  return {
    ok: true,
    symbol,
    points,
    error: false,
    statusText: points > 0 ? `${points} history point${points === 1 ? '' : 's'}` : 'Insufficient history',
    reclaim,
    absorption,
    orderbookModeText: orderbookMode === 'server' ? 'Server orderbook' : 'External browser required',
    orderbookReasonText: orderbookReason,
  };
}

export function priceHistorySignalErrorModel(message) {
  return {
    ok: false,
    symbol: null,
    points: 0,
    error: true,
    statusText: message || 'Could not load price-history signals.',
    reclaim: safeSignalBlock(null),
    absorption: safeSignalBlock(null),
    orderbookModeText: 'Unknown',
    orderbookReasonText: '',
  };
}

export function priceHistorySignalSignedOutModel() {
  return priceHistorySignalErrorModel('Sign in as an admin to view price-history diagnostics.');
}

if (typeof window !== 'undefined') {
  window.__priceHistorySignalsPanel = {
    toRenderModel: priceHistorySignalRenderModel,
    errorModel: priceHistorySignalErrorModel,
    signedOutModel: priceHistorySignalSignedOutModel,
  };
}
