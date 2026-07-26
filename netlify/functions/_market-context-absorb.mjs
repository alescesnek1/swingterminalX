// Collection-time rolling absorption.
//
// The absorb row used to be rebuilt in the publisher by reading every symbol's
// raw agg trades and 1m candles back out of Postgres — two round trips PER
// SYMBOL. That is affordable for five symbols and impossible for the full
// tradable universe, and it forced raw trades to be retained for every symbol
// purely so they could be read back.
//
// The raw data is already in memory at collection time, so the row is computed
// there instead and stored once. This module is a thin, pure adapter: it maps
// the Binance collector shapes onto buildCollectorRollingRow and adds nothing of
// its own. Every honesty guarantee still lives in the bridge and the validator —
// a symbol whose inputs are insufficient yields a row that is simply not
// strictReady, never a fabricated confirmation.
import { buildCollectorRollingRow } from '../../scripts/radar/collector-absorb-bridge.mjs';

const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

export function buildMeasurementAbsorb(micro, { bidQuoteDepthBefore = null, windowSec = null, observedAtMs = Date.now() } = {}) {
  if (!micro || typeof micro !== 'object') return null;
  const depth = micro.depthSummary || {};
  const trades = micro.tradesSummary || {};
  const bidQuote = finite(depth.bidQuote);
  const askQuote = finite(depth.askQuote);
  const spreadBps = finite(depth.spreadBps);
  const built = buildCollectorRollingRow({
    market: micro.market,
    symbol: micro.symbol,
    observedAtMs,
    windowSec,
    aggTrades: Array.isArray(micro.aggTrades) ? micro.aggTrades : [],
    klines: Array.isArray(micro.klines1m) ? micro.klines1m : [],
    bidQuoteDepthBefore,
    bidQuoteDepthAfter: bidQuote,
    spreadPct: spreadBps === null ? null : spreadBps / 100,
    depthUsdWithin1Pct: (bidQuote ?? 0) + (askQuote ?? 0) > 0 ? (bidQuote ?? 0) + (askQuote ?? 0) : null,
    takerBuyQuote: finite(trades.takerBuyQuote),
    takerSellQuote: finite(trades.takerSellQuote),
  }, observedAtMs);
  return built ? built.row : null;
}

// Attaches an `absorb` row to every collected microstructure entry. The baseline
// supplies the N-1 bid depth per venue+symbol; a symbol the baseline run did not
// measure simply has no depth-rebuild input and stays non-strictReady.
export function attachAbsorbRows(microstructure, baseline, observedAt) {
  const observedAtMs = new Date(observedAt).getTime();
  const bidDepth = baseline?.bidDepth instanceof Map ? baseline.bidDepth : new Map();
  const windowSec = finite(baseline?.windowSec);
  let computed = 0;
  let withBaseline = 0;
  const rows = (Array.isArray(microstructure) ? microstructure : []).map((micro) => {
    const key = `${micro?.market}:${micro?.symbol}`;
    const before = bidDepth.has(key) ? bidDepth.get(key) : null;
    if (before !== null) withBaseline += 1;
    const absorb = buildMeasurementAbsorb(micro, { bidQuoteDepthBefore: before, windowSec, observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : Date.now() });
    if (absorb) computed += 1;
    return absorb ? { ...micro, absorb } : micro;
  });
  return { rows, diagnostics: { absorbComputed: computed, absorbWithDepthBaseline: withBaseline, absorbWindowSec: windowSec } };
}
