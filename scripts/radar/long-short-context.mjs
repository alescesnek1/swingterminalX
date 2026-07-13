// long-short-context.mjs — context-only long/short positioning read-model.
//
// PURE parser/helper: no fetch, no env, no producer, no network. It normalizes
// the DOCUMENTED public Binance futures-data response arrays into a compact,
// honest context block. It is the deterministic core a future (approval-gated)
// operator-local producer would call after fetching — kept isolated and fully
// testable here without any network.
//
// SAFETY CONTRACT (same class as positioning-context.mjs / pressure-zones.mjs):
//   - context-only: never a gate, never an action, never an alert trigger
//   - no BUY/SELL/entry/exit semantics, no score field, no action field
//   - missing or stale inputs yield an explicit unavailable state — never a
//     fabricated value, never a neutral-positive default
//   - derived from account/position ratios; it is not liquidation data and not
//     order-book data
//
// Thresholds are imported from positioning-context.mjs so the two positioning
// read-models can never drift apart (single source of truth).
import {
  LS_CROWDED_LONG_RATIO,
  LS_CROWDED_SHORT_RATIO,
  POSITIONING_STALE_TTL_MS,
} from './positioning-context.mjs';

export { LS_CROWDED_LONG_RATIO, LS_CROWDED_SHORT_RATIO, POSITIONING_STALE_TTL_MS };

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Pick the freshest row from a raw Binance futures-data series (array of
// `{ ...ratio, timestamp }`). Non-array / empty → null. Rows with a
// non-finite timestamp are ignored so a malformed entry can never win.
function latestRow(series) {
  if (!Array.isArray(series) || series.length === 0) return null;
  let best = null;
  let bestTs = -Infinity;
  for (const row of series) {
    if (!row || typeof row !== 'object') continue;
    const ts = num(row.timestamp);
    if (ts == null) continue;
    if (ts > bestTs) { bestTs = ts; best = row; }
  }
  if (!best) return null;
  return { row: best, timestamp: bestTs };
}

function classifyLongShort(globalAccountRatio, topTraderPositionRatio) {
  const ratios = [globalAccountRatio, topTraderPositionRatio].filter((r) => r != null);
  if (ratios.length === 0) return 'unavailable';
  if (ratios.some((r) => r >= LS_CROWDED_LONG_RATIO)) return 'crowded long';
  if (ratios.some((r) => r <= LS_CROWDED_SHORT_RATIO)) return 'crowded short';
  return 'balanced';
}

// Build a compact context-only long/short block from raw Binance futures-data
// series. Inputs:
//   symbol                        — market symbol (display echo only)
//   period                        — sampling period echo ("5m" | "15m" | "1h" …)
//   globalAccountRatioSeries      — raw /futures/data/globalLongShortAccountRatio array
//   topTraderPositionRatioSeries  — raw /futures/data/topLongShortPositionRatio array
//   takerRatioSeries              — raw /futures/data/takerlongshortRatio array
//   nowMs                         — clock (injectable for tests)
//   staleTtlMs                    — stale cutoff (defaults to positioning TTL)
//   source                        — provenance string
export function buildLongShortContext(input = {}) {
  const s = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const nowMs = Number.isFinite(Number(s.nowMs)) ? Number(s.nowMs) : Date.now();
  const staleTtlMs = Number.isFinite(Number(s.staleTtlMs)) && Number(s.staleTtlMs) > 0
    ? Number(s.staleTtlMs)
    : POSITIONING_STALE_TTL_MS;

  const globalLatest = latestRow(s.globalAccountRatioSeries);
  const topLatest = latestRow(s.topTraderPositionRatioSeries);
  const takerLatest = latestRow(s.takerRatioSeries);

  const globalAccountRatio = globalLatest ? num(globalLatest.row.longShortRatio) : null;
  const topTraderPositionRatio = topLatest ? num(topLatest.row.longShortRatio) : null;
  const takerBuySellRatio = takerLatest ? num(takerLatest.row.buySellRatio) : null;

  // Freshest observation across whichever series produced a usable ratio.
  const timestamps = [
    globalAccountRatio != null ? globalLatest.timestamp : null,
    topTraderPositionRatio != null ? topLatest.timestamp : null,
    takerBuySellRatio != null ? takerLatest.timestamp : null,
  ].filter((t) => t != null);
  const newestTs = timestamps.length ? Math.max(...timestamps) : null;
  const stale = newestTs != null && (nowMs - newestTs) > staleTtlMs;

  const missing = [];
  if (globalAccountRatio == null) missing.push('globalAccountRatio');
  if (topTraderPositionRatio == null) missing.push('topTraderPositionRatio');
  if (takerBuySellRatio == null) missing.push('takerBuySellRatio');

  const base = {
    contextOnly: true,
    source: typeof s.source === 'string' && s.source ? s.source : 'binance-futures-data',
    symbol: typeof s.symbol === 'string' ? s.symbol : null,
    period: typeof s.period === 'string' && s.period ? s.period : null,
    updatedAt: newestTs != null ? new Date(newestTs).toISOString() : null,
    warnings: [],
    missing,
  };

  const noneUsable = globalAccountRatio == null && topTraderPositionRatio == null && takerBuySellRatio == null;
  if (stale || noneUsable) {
    return {
      ...base,
      available: false,
      stale: stale === true,
      topTraderPositionRatio: null,
      globalAccountRatio: null,
      takerBuySellRatio: null,
      interpretation: 'unavailable',
      warnings: stale ? ['long/short snapshot stale'] : [],
    };
  }

  const interpretation = classifyLongShort(globalAccountRatio, topTraderPositionRatio);
  const warnings = [];
  if (interpretation === 'crowded long') warnings.push('crowded long positioning');
  if (interpretation === 'crowded short') warnings.push('crowded short positioning');

  return {
    ...base,
    available: true,
    stale: false,
    topTraderPositionRatio,
    globalAccountRatio,
    takerBuySellRatio,
    interpretation,
    warnings,
  };
}
