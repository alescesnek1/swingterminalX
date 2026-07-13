// positioning-context.mjs — context-only OI / positioning read-model.
//
// PURE helper: no fetch, no env reads, no side effects. It projects OI /
// positioning inputs the pipeline ALREADY carries (open interest change from the
// operator-local rolling microstructure producer; long/short ratios only if a
// future approved producer supplies them) into a compact, honest display block.
//
// SAFETY CONTRACT (same class as pressure-zones.mjs):
//   - context-only: never a gate, never an action, never an alert trigger
//   - no BUY/SELL/entry/exit semantics, no score field, no action field
//   - missing or stale inputs yield an explicit unavailable state — never a
//     fabricated value, never a neutral-positive default
//   - this is derived from open interest deltas and account/position ratios;
//     it is not liquidation data and not order-book data
//
// Transparent classification thresholds (documented, display-only):
//   OI trend      : |changePct| < OI_FLAT_BAND_PCT → "flat"; sign decides rise/fall
//   crowded long  : long/short ratio >= LS_CROWDED_LONG_RATIO
//   crowded short : long/short ratio <= LS_CROWDED_SHORT_RATIO
//   stale         : updatedAt older than STALE_TTL_MS → unavailable

export const OI_FLAT_BAND_PCT = 1;          // ±1% between samples reads as flat
export const LS_CROWDED_LONG_RATIO = 2.5;   // longs per short — crowded long
export const LS_CROWDED_SHORT_RATIO = 0.5;  // longs per short — crowded short
export const POSITIONING_STALE_TTL_MS = 15 * 60 * 1000;

const OI_TRENDS = new Set(['rising', 'falling', 'flat']);

function num(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function classifyOiTrend(changePct) {
  if (changePct == null) return 'unknown';
  if (Math.abs(changePct) < OI_FLAT_BAND_PCT) return 'flat';
  return changePct > 0 ? 'rising' : 'falling';
}

function oiLabel(trend, priceChangePct) {
  if (!OI_TRENDS.has(trend)) return 'OI unavailable';
  if (trend === 'flat') return 'OI flat';
  const dir = trend === 'rising' ? 'OI rising' : 'OI falling';
  if (priceChangePct == null) return dir;
  return `${dir} with price ${priceChangePct > 0 ? 'up' : priceChangePct < 0 ? 'down' : 'flat'}`;
}

function classifyLongShort(globalAccountRatio, topTraderPositionRatio) {
  const ratios = [globalAccountRatio, topTraderPositionRatio].filter((r) => r != null);
  if (ratios.length === 0) return 'unavailable';
  if (ratios.some((r) => r >= LS_CROWDED_LONG_RATIO)) return 'crowded long';
  if (ratios.some((r) => r <= LS_CROWDED_SHORT_RATIO)) return 'crowded short';
  return 'balanced';
}

// Build a compact context-only positioning block. Inputs:
//   symbol                  — market symbol (display echo only)
//   openInterestChangePct   — % change between two real OI samples (or null)
//   priceChangePct          — matching price change % over a recent window (or null)
//   windowMinutes           — sample window in minutes if known (or null)
//   updatedAtMs             — when the underlying snapshot was produced
//   nowMs                   — clock (injectable for tests)
//   globalAccountRatio      — long/short accounts ratio (null until a producer exists)
//   topTraderPositionRatio  — top-trader position ratio (null until a producer exists)
//   timeframe               — label echo only ("5m" | "15m" | "1h")
//   source                  — provenance string
export function buildPositioningContext(input = {}) {
  const s = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const nowMs = Number.isFinite(Number(s.nowMs)) ? Number(s.nowMs) : Date.now();
  const updatedAtMs = num(s.updatedAtMs);
  const oiChangePct = num(s.openInterestChangePct);
  const priceChangePct = num(s.priceChangePct);
  const globalAccountRatio = num(s.globalAccountRatio);
  const topTraderPositionRatio = num(s.topTraderPositionRatio);
  const takerBuySellRatio = num(s.takerBuySellRatio);

  const stale = updatedAtMs != null && nowMs - updatedAtMs > POSITIONING_STALE_TTL_MS;
  const missing = [];
  if (oiChangePct == null) missing.push('openInterestChangePct');
  if (globalAccountRatio == null && topTraderPositionRatio == null) missing.push('longShortRatio');

  const base = {
    contextOnly: true,
    source: typeof s.source === 'string' && s.source ? s.source : 'rolling-microstructure',
    symbol: typeof s.symbol === 'string' ? s.symbol : null,
    timeframe: typeof s.timeframe === 'string' && s.timeframe ? s.timeframe : 'rolling',
    stale: stale === true,
    updatedAt: updatedAtMs != null ? new Date(updatedAtMs).toISOString() : null,
    warnings: [],
    missing,
  };

  // Stale or fully missing → honest unavailable block, no derived fields kept.
  if (stale || (oiChangePct == null && globalAccountRatio == null && topTraderPositionRatio == null)) {
    return {
      ...base,
      available: false,
      openInterest: { trend: 'unknown', changePct: null, windowMinutes: null, label: 'OI unavailable' },
      longShort: { globalAccountRatio: null, topTraderPositionRatio: null, takerBuySellRatio: null, interpretation: 'unavailable' },
      warnings: stale ? ['positioning snapshot stale'] : [],
    };
  }

  const trend = classifyOiTrend(oiChangePct);
  const interpretation = classifyLongShort(globalAccountRatio, topTraderPositionRatio);
  const warnings = [];
  if (interpretation === 'crowded long') warnings.push('crowded long positioning');
  if (interpretation === 'crowded short') warnings.push('crowded short positioning');

  return {
    ...base,
    available: true,
    openInterest: {
      trend,
      changePct: oiChangePct,
      windowMinutes: num(s.windowMinutes),
      label: oiLabel(trend, oiChangePct == null ? null : priceChangePct),
    },
    longShort: {
      globalAccountRatio,
      topTraderPositionRatio,
      takerBuySellRatio,
      interpretation,
    },
    warnings,
  };
}
