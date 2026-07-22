// Bounded, fail-closed price-history context for backend RADAR candidates.
// It supplies only bounded setup corroboration; it never supplies strict absorption, Flow/OI/Funding, or Telegram eligibility.

import { analyzeAbsorptionFromPointsAndOrderbook, analyzeReclaimFromPoints } from './_price-history-signals.mjs';

export const RADAR_PRICE_HISTORY_TOP_N = 5;
const READ_LIMIT = 40;

export function radarPriceHistoryBaseSymbol(value) {
  const raw = typeof value === 'string' ? value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  if (!raw || raw.length > 30) return null;
  for (const quote of ['USDT', 'USDC', 'FDUSD', 'BUSD', 'USD']) {
    if (raw.length > quote.length && raw.endsWith(quote)) return raw.slice(0, -quote.length);
  }
  return raw;
}

function unknownContext(symbol, status, blocker) {
  return {
    status,
    symbol: radarPriceHistoryBaseSymbol(symbol),
    points: 0,
    reclaim: { status: 'UNKNOWN', reason: blocker },
    absorption: { status: 'UNKNOWN', mode: 'history_only', confidence: 'unknown', reason: blocker },
    blockers: [blocker, 'strict rolling absorption unavailable'],
    source: 'price_history_db',
    affectsServerGate: false,
    affectsTelegram: false,
  };
}

function reclaimStatus(result) {
  if (result?.signal === 'BULLISH_RECLAIM') return 'CONFIRMED';
  if (result && ['FAILED_RECLAIM', 'NO_RECLAIM'].includes(result.signal)) return 'NOT_CONFIRMED';
  return 'UNKNOWN';
}

function absorptionStatus(result) {
  if (result?.signal === 'BULLISH_ABSORPTION') return 'CONFIRMED';
  if (result && ['BEARISH_ABSORPTION', 'NO_ABSORPTION'].includes(result.signal)) return 'NOT_CONFIRMED';
  return 'UNKNOWN';
}

function historyConfidence(result) {
  return result?.confidence === 'medium' || result?.confidence === 'high' ? 'medium' : 'low';
}

export function buildPriceHistoryContext(symbol, history) {
  if (!history || history.ok !== true || !Array.isArray(history.points)) {
    return unknownContext(symbol, 'DB_UNAVAILABLE', 'price-history database unavailable');
  }
  if (history.points.length === 0) return unknownContext(symbol, 'NO_HISTORY', 'no price-history points');

  let reclaim;
  let absorption;
  try {
    reclaim = analyzeReclaimFromPoints({ symbol, points: history.points });
    // Deliberately omit orderbook: browser/point-in-time orderbook data must
    // never become a backend scoring dependency.
    absorption = analyzeAbsorptionFromPointsAndOrderbook({ symbol, points: history.points });
  } catch {
    return unknownContext(symbol, 'UNKNOWN', 'price-history analysis unavailable');
  }

  const insufficient = reclaim.status === 'INSUFFICIENT_HISTORY' || absorption.status === 'INSUFFICIENT_HISTORY';
  const reclaimState = reclaimStatus(reclaim);
  const absorptionState = absorptionStatus(absorption);
  const canSupportScoring = reclaimState === 'CONFIRMED'
    || (absorptionState === 'CONFIRMED' && historyConfidence(absorption) === 'medium');
  const blockers = [
    'history-only absorption does not provide flow, open interest, or funding',
    'strict rolling absorption unavailable',
  ];
  if (insufficient) blockers.unshift('insufficient price-history points');
  if (reclaimState !== 'CONFIRMED') blockers.unshift('price-history reclaim not confirmed');
  if (absorptionState !== 'CONFIRMED') blockers.unshift('price-history absorption not confirmed');

  return {
    status: insufficient ? 'INSUFFICIENT_HISTORY' : 'OK',
    symbol: radarPriceHistoryBaseSymbol(symbol),
    points: history.points.length,
    reclaim: { status: reclaimState, reason: reclaim.reason || 'price-history reclaim unavailable' },
    absorption: {
      status: absorptionState,
      mode: 'history_only',
      confidence: insufficient ? 'unknown' : historyConfidence(absorption),
      reason: absorption.reason || 'price-history absorption unavailable',
    },
    blockers: Array.from(new Set(blockers)),
    source: 'price_history_db',
    affectsServerGate: canSupportScoring,
    affectsTelegram: false,
  };
}

export async function loadPriceHistoryContextsForCandidates(candidates, listRecentPricePoints) {
  const top = Array.isArray(candidates) ? candidates.slice(0, RADAR_PRICE_HISTORY_TOP_N) : [];
  const contexts = new Map();
  const read = typeof listRecentPricePoints === 'function' ? listRecentPricePoints : null;
  for (const candidate of top) {
    const symbol = radarPriceHistoryBaseSymbol(candidate?.symbol);
    if (!symbol || contexts.has(symbol)) continue;
    if (!read) {
      contexts.set(symbol, unknownContext(symbol, 'DB_UNAVAILABLE', 'price-history reader unavailable'));
      continue;
    }
    try {
      const history = await read({ symbol, limit: READ_LIMIT });
      contexts.set(symbol, buildPriceHistoryContext(symbol, history));
    } catch {
      contexts.set(symbol, unknownContext(symbol, 'DB_UNAVAILABLE', 'price-history database unavailable'));
    }
  }
  return contexts;
}

export function applyPriceHistoryContextsToRows(rows, contexts) {
  const contextMap = contexts instanceof Map ? contexts : new Map();
  if (!Array.isArray(rows) || contextMap.size === 0) return Array.isArray(rows) ? rows : [];
  return rows.map((row) => {
    const symbol = radarPriceHistoryBaseSymbol(row?.symbol);
    const context = symbol ? contextMap.get(symbol) : null;
    return context ? { ...row, priceHistoryContext: context } : row;
  });
}
export function attachPriceHistoryContextsToRadarCandidates(radar, contexts) {
  const candidates = Array.isArray(radar?.candidates) ? radar.candidates : [];
  const contextMap = contexts instanceof Map ? contexts : new Map();
  for (const candidate of candidates.slice(0, RADAR_PRICE_HISTORY_TOP_N)) {
    const symbol = radarPriceHistoryBaseSymbol(candidate?.symbol);
    if (!symbol) continue;
    candidate.priceHistoryContext = contextMap.get(symbol)
      || unknownContext(symbol, 'UNKNOWN', 'price-history context unavailable');
  }
  return radar;
}
