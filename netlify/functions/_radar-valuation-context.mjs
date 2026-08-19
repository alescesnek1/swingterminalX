// Bounded, fail-closed stored-history enrichment for the RADAR valuation
// (oversold / overbought) read.
//
// The RADAR evaluator already attaches a momentum-only `candidate.valuation`
// to every candidate (scripts/radar/valuation-bands.mjs). This module deepens
// the top-ranked slice of that list with the stored `market_price_points`
// window — where the price actually sits inside its own recent range — using a
// SINGLE batched database read.
//
// SAFETY
//   - Read-only. No write, no external fetch, no scheduler, no env read.
//   - Feeds NO gate: not RADAR scoring, not ENTRY_READY, not Absorb, not
//     Reclaim, not Telegram, not the bot. It only replaces `candidate.valuation`
//     with a richer version of the same advisory block.
//   - Fail-closed and VISIBLE: a missing reader, a DB failure, or a symbol with
//     no history leaves the momentum-only reading in place and records a named
//     reason on the returned result and on `radar.valuationSummary`, so the UI
//     can distinguish "no history" from "database unavailable". Nothing is
//     invented and no failure is swallowed.

import { REASON_DB_HISTORY_READS_DISABLED } from './_cost-breaker.mjs';
import { radarPriceHistoryBaseSymbol } from './_price-history-radar-context.mjs';
import {
  computeHistoryValuation,
  mergeValuationHistory,
  summarizeValuationBands,
} from '../../scripts/radar/valuation-bands.mjs';

// How many ranked candidates get the stored-history layer, and how deep the
// window is. Both are hard bounds: the batched reader clamps them again.
export const RADAR_VALUATION_TOP_N = 40;
export const RADAR_VALUATION_POINTS_PER_SYMBOL = 60;

/**
 * Builds the ordered, deduped list of base symbols to read history for, from
 * the ranked candidate list. Exported for tests.
 */
export function valuationSymbolsForCandidates(candidates, topN = RADAR_VALUATION_TOP_N) {
  const limit = Number.isInteger(topN) && topN > 0 ? topN : RADAR_VALUATION_TOP_N;
  const rows = Array.isArray(candidates) ? candidates.slice(0, limit) : [];
  const symbols = [];
  const seen = new Set();
  for (const row of rows) {
    const symbol = radarPriceHistoryBaseSymbol(row && row.symbol);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols;
}

/**
 * Loads the stored-history valuation layer for the top-ranked candidates in one
 * batched read. Returns
 * { ok, layers: Map<baseSymbol, historyLayer>, reason, symbolsRequested,
 *   symbolsWithHistory, pointsPerSymbol }.
 *
 * `ok:false` means the read itself failed (no reader, DB unavailable, thrown) —
 * distinct from `ok:true` with an empty map, which means the database is fine
 * and simply has no points for those symbols yet. Never throws.
 */
export async function loadValuationHistoryForCandidates(candidates, readPointsForSymbols, options = {}) {
  const symbols = valuationSymbolsForCandidates(candidates, options.topN);
  const pointsPerSymbol = Number.isInteger(options.pointsPerSymbol) && options.pointsPerSymbol > 0
    ? options.pointsPerSymbol
    : RADAR_VALUATION_POINTS_PER_SYMBOL;
  const empty = {
    layers: new Map(),
    symbolsRequested: symbols.length,
    symbolsWithHistory: 0,
    pointsPerSymbol,
  };

  if (symbols.length === 0) {
    return { ...empty, ok: true, reason: null };
  }
  if (typeof readPointsForSymbols !== 'function') {
    return { ...empty, ok: false, reason: 'PRICE_HISTORY_READER_UNAVAILABLE' };
  }

  let read;
  try {
    read = await readPointsForSymbols({ symbols, pointsPerSymbol });
  } catch {
    return { ...empty, ok: false, reason: 'DB_UNAVAILABLE' };
  }
  if (!read || read.ok !== true || !(read.bySymbol instanceof Map)) {
    return { ...empty, ok: false, reason: (read && read.reason) || 'DB_UNAVAILABLE' };
  }

  const layers = new Map();
  let symbolsWithHistory = 0;
  for (const symbol of symbols) {
    const points = read.bySymbol.get(symbol) || [];
    let layer;
    try {
      layer = computeHistoryValuation(points, { now: options.now });
    } catch {
      // A single unusable series must not lose the whole batch; it degrades to
      // the momentum-only read for that one symbol, with a named reason.
      layer = { ...computeHistoryValuation(null), status: 'UNKNOWN', reason: 'stored-history valuation analysis unavailable' };
    }
    layers.set(symbol, layer);
    if (layer.available === true) symbolsWithHistory += 1;
  }

  return {
    ok: true,
    reason: null,
    layers,
    symbolsRequested: symbols.length,
    symbolsWithHistory,
    pointsPerSymbol: read.pointsPerSymbol || pointsPerSymbol,
    symbolsDropped: Number.isInteger(read.symbolsDropped) ? read.symbolsDropped : 0,
  };
}

/**
 * Merges the loaded layers into `radar.candidates[*].valuation` and attaches
 * `radar.valuationSummary`. ONLY the `valuation` property of a candidate is
 * touched — no score, stage, gate, status, or Telegram field is read or
 * written. Returns the same `radar` object for chaining. Never throws.
 */
export function applyValuationHistoryToRadar(radar, loaded) {
  const state = radar && typeof radar === 'object' ? radar : null;
  if (!state) return radar;
  const candidates = Array.isArray(state.candidates) ? state.candidates : [];
  const result = loaded && typeof loaded === 'object' ? loaded : { ok: false, reason: 'VALUATION_HISTORY_UNAVAILABLE' };
  const layers = result.layers instanceof Map ? result.layers : new Map();

  let enriched = 0;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const symbol = radarPriceHistoryBaseSymbol(candidate.symbol);
    const layer = symbol ? layers.get(symbol) : null;
    if (!layer) continue;
    candidate.valuation = mergeValuationHistory(candidate.valuation, layer);
    enriched += 1;
  }

  const summary = summarizeValuationBands(candidates);
  state.valuationSummary = {
    ...summary,
    scope: 'relative_to_own_recent_range',
    historyEnrichedCandidates: enriched,
    historySymbolsRequested: Number.isInteger(result.symbolsRequested) ? result.symbolsRequested : 0,
    historySymbolsWithData: Number.isInteger(result.symbolsWithHistory) ? result.symbolsWithHistory : 0,
    historyPointsPerSymbol: Number.isInteger(result.pointsPerSymbol) ? result.pointsPerSymbol : RADAR_VALUATION_POINTS_PER_SYMBOL,
    historyTopN: RADAR_VALUATION_TOP_N,
    // The failure shapes stay distinguishable in the payload the UI reads. The
    // emergency cost breaker is its own third case: the database is healthy and
    // we deliberately did not read it, which must read as HISTORY_DISABLED. In
    // every case the stored-history band stays absent — a candidate keeps its
    // momentum-only reading and NOTHING synthesises a FAIR band out of a read
    // that never happened.
    historyAvailable: result.ok === true,
    historyDisabled: result.reason === REASON_DB_HISTORY_READS_DISABLED,
    historyUnavailableReason: result.ok === true
      ? null
      : (result.reason === REASON_DB_HISTORY_READS_DISABLED ? 'HISTORY_DISABLED' : (result.reason || 'VALUATION_HISTORY_UNAVAILABLE')),
    source: 'price_history_db',
    isEntrySignal: false,
    affectsGate: false,
    affectsTelegram: false,
  };
  return state;
}
