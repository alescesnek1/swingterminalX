// DB → trusted rolling-microstructure bridge.
//
// Turns the atomic records the 3-minute Netlify collector stored (agg trades,
// 1m candles, order-book depth at run N-1 and N, spread) into a single trusted
// rolling row that the existing STRICT_ABSORB pipeline already understands.
//
// HONESTY CONTRACT — this bridge NEVER fabricates provenance:
//   - source is 'netlify-atomic-collector' (spot), NOT the futures rolling feed.
//   - rollingWindowSec is the REAL elapsed seconds between the N-1 and N depth
//     observations (two genuine, time-separated snapshots), never a hard-coded
//     300s pretending to be the futures window.
//   - Every trusted field is COMPUTED from measured data by computeRollingAbsorption.
//     If the trades / depth / candles are insufficient, the field is simply absent
//     and the row is not strictReady — the pipeline then reports UNKNOWN, never a
//     fake confirmation.
import { computeRollingAbsorption, validateRollingTrades } from './rolling-microstructure-core.mjs';
import { rollingKeyFor } from './rolling-microstructure-snapshot.mjs';

export const COLLECTOR_ROLLING_SOURCE = 'netlify-atomic-collector';
const MIN_TRADE_SAMPLES = 10;
const MIN_KLINE_SAMPLES = 30;
const MIN_DEPTH_SNAPSHOTS = 2;

const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const positive = (value) => finite(value) !== null && Number(value) > 0;

// One symbol's stored atomic inputs → { symbol, market, row } where `row` is a
// rolling snapshot row, or null when the symbol cannot yield a measurable row.
// `row.strictReady`/trust is decided later by validateTrustedRollingRow; here we
// only assemble measured fields and truthful provenance/sample counts.
export function buildCollectorRollingRow(input = {}, nowMs = Date.now()) {
  const symbol = typeof input.symbol === 'string' ? input.symbol.trim().toUpperCase() : '';
  const market = input.market === 'futures' ? 'futures' : input.market === 'spot' ? 'spot' : null;
  if (!symbol || !market) return null;

  const trades = Array.isArray(input.aggTrades) ? input.aggTrades : [];
  const klines = Array.isArray(input.klines) ? input.klines : [];
  const bidDepthBefore = finite(input.bidQuoteDepthBefore);
  const bidDepthAfter = finite(input.bidQuoteDepthAfter);
  const spreadPct = finite(input.spreadPct);
  const depthUsdWithin1Pct = finite(input.depthUsdWithin1Pct);
  const windowSec = positive(input.windowSec) ? Math.round(Number(input.windowSec)) : null;
  const observedAtMs = finite(input.observedAtMs) ?? nowMs;

  // Real window used for trade filtering: cover the elapsed collector window with
  // a small margin so genuinely in-window trades are kept, none invented.
  const windowMs = windowSec ? Math.max(windowSec * 1000, 60_000) : 300_000;
  const validation = validateRollingTrades(trades, observedAtMs, windowMs);
  const absorb = computeRollingAbsorption(
    {
      trades,
      klines,
      snapshots: { before: { bidDepth: bidDepthBefore }, after: { bidDepth: bidDepthAfter } },
      context: { spreadPct: spreadPct === null ? undefined : spreadPct },
      config: { windowMs, minSamples: MIN_TRADE_SAMPLES },
    },
    observedAtMs,
  );

  const takerBuyQuote = finite(input.takerBuyQuote);
  const takerSellQuote = finite(input.takerSellQuote);
  const totalTakerQuote = (takerBuyQuote ?? 0) + (takerSellQuote ?? 0);
  const marketSellRatio = totalTakerQuote > 0 ? (takerSellQuote ?? 0) / totalTakerQuote : null;
  const takerBuySellRatio = takerSellQuote && takerSellQuote > 0 ? (takerBuyQuote ?? 0) / takerSellQuote : null;
  const cumulativeDeltaPct = totalTakerQuote > 0 ? (((takerBuyQuote ?? 0) - (takerSellQuote ?? 0)) / totalTakerQuote) * 100 : null;

  const row = {
    source: COLLECTOR_ROLLING_SOURCE,
    market,
    rollingWindowSec: windowSec,
    rollingMeasuredAtMs: observedAtMs,
    samples: {
      aggTrades: validation.trades.length,
      depthSnapshots: bidDepthBefore !== null && bidDepthAfter !== null ? MIN_DEPTH_SNAPSHOTS : (bidDepthAfter !== null ? 1 : 0),
      klines: klines.length,
    },
    validation: {
      makerFlagsValid: validation.invalidMakerFlags === 0,
      // Only MALFORMED trades invalidate the sample. Trades outside the window are
      // discarded, not held against the symbol — the exchange returns a fixed
      // COUNT of recent trades, so an out-of-window tail is normal, not corruption.
      tradesValidated: validation.malformed === 0 && validation.trades.length >= MIN_TRADE_SAMPLES,
      tradesSorted: true,
      klinesValidated: klines.length >= MIN_KLINE_SAMPLES,
    },
  };

  // Measured trusted fields — copied ONLY when computeRollingAbsorption produced
  // them from real data. Absent fields stay absent (→ not strictReady → UNKNOWN).
  if (finite(absorb.absorptionScore) !== null) row.absorptionScore = Number(absorb.absorptionScore);
  if (finite(absorb.bidDepthRebuildPct) !== null) row.bidDepthRebuildPct = Number(absorb.bidDepthRebuildPct);
  if (typeof absorb.aggressiveSellsFailed === 'boolean') row.aggressiveSellsFailed = absorb.aggressiveSellsFailed;
  if (finite(absorb.deltaImprovementPct) !== null) row.deltaImprovementPct = Number(absorb.deltaImprovementPct);
  if (finite(absorb.marketBuyVolumeDominance) !== null) row.marketBuyVolumeDominance = Number(absorb.marketBuyVolumeDominance);
  if (typeof absorb.supportRetestHeld === 'boolean') row.supportRetestHeld = absorb.supportRetestHeld;
  if (typeof absorb.spreadAndSlippageHealthy === 'boolean') row.spreadAndSlippageHealthy = absorb.spreadAndSlippageHealthy;
  if (marketSellRatio !== null) row.marketSellRatio = marketSellRatio;
  if (spreadPct !== null) row.spreadPct = spreadPct;
  if (depthUsdWithin1Pct !== null) row.depthUsdWithin1Pct = depthUsdWithin1Pct;

  const flow = {};
  if (takerBuySellRatio !== null) flow.takerBuySellRatio = takerBuySellRatio;
  if (cumulativeDeltaPct !== null) flow.cumulativeDeltaPct = cumulativeDeltaPct;
  if (typeof absorb.aggressiveSellsFailed === 'boolean') flow.aggressiveSellExhaustion = absorb.aggressiveSellsFailed;
  if (Object.keys(flow).length) row.flow = flow;

  return { symbol, market, row };
}

// Assembles the full rolling snapshot object consumed by evaluateTradingRadar's
// `rollingMicrostructureSnapshot` input from a list of per-symbol stored inputs.
// `trusted: true` only ASSERTS intent; normalizeRollingMicrostructureSnapshot
// still independently validates every row and will downgrade the snapshot if any
// foundation row fails, so a thin/incomplete symbol can never force a trusted read.
export function buildCollectorRollingSnapshot(symbols = [], opts = {}) {
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const updatedAtMs = Number.isFinite(Number(opts.updatedAtMs)) ? Number(opts.updatedAtMs) : nowMs;
  const data = {};
  let measured = 0;
  let precomputed = 0;
  for (const input of Array.isArray(symbols) ? symbols : []) {
    // A row computed at COLLECTION time is used as-is: recomputing it here would
    // need the raw trades read back per symbol, which is exactly the cost the
    // stored row removes. It came from the same buildCollectorRollingRow, so the
    // provenance and the trust bar are identical — nothing is relaxed.
    if (input?.absorb && typeof input.absorb === 'object' && !Array.isArray(input.absorb)) {
      const symbol = typeof input.symbol === 'string' ? input.symbol.trim().toUpperCase() : '';
      // Venue-qualified key. Keyed by symbol alone, the spot and futures rows of one
      // symbol collided and the later one silently replaced the earlier — and the
      // survivor could then be handed to a candidate on the OTHER venue.
      const key = symbol ? rollingKeyFor(input.market, symbol) : null;
      if (key) { data[key] = { ...input.absorb, market: input.absorb.market ?? input.market ?? null }; measured += 1; precomputed += 1; continue; }
    }
    const built = buildCollectorRollingRow(input, nowMs);
    if (!built) continue;
    data[rollingKeyFor(built.market, built.symbol) || built.symbol] = built.row;
    measured += 1;
  }
  return {
    provider: COLLECTOR_ROLLING_SOURCE,
    source: COLLECTOR_ROLLING_SOURCE,
    trusted: true,
    updatedAtMs,
    timeframe: 'rolling',
    ttlMs: 10 * 60 * 1000,
    data,
    diagnostics: { requested: Array.isArray(symbols) ? symbols.length : 0, measured, precomputed },
  };
}
