// Best-effort, Node-side fallback for netlify/functions/_orderbook-client.mjs.
// Used ONLY when the same-origin /api/orderbook bridge (Deno Edge Function)
// is unavailable, so admin-price-history-signals can still get a live book
// instead of degrading straight to a history-only read. Hits Binance's
// PUBLIC depth endpoints directly — the exact same upstream
// apps/edge/netlify/edge-functions/lib/binance.js already uses for spot and
// futures depth, just called from Node instead of through the Edge bridge.
//
// SAFETY MODEL
//   - GET-only, public market-data endpoints only: /api/v3/depth (spot),
//     /fapi/v1/depth (futures). No API key, no signing, no account/order/
//     leverage/margin/withdraw path exists anywhere in this file.
//   - `pair`/`market` are expected already sanitized by the caller (see
//     normalizeOrderbookPair / normalizeOrderbookMarket in
//     _orderbook-client.mjs) — this module re-validates the pair shape
//     defensively but never derives it from raw user input itself.
//   - Bounded by a request timeout (matches the edge fetcher's own 4500ms
//     convention) so a slow/hung upstream can never stall the caller.
//   - Never throws; every path resolves to { ok:true, orderbook, pair,
//     market, source:'binance_direct' } or { ok:false, reason, pair?,
//     market? }. Reason codes are stable strings — no raw upstream body or
//     error message is ever surfaced. Each failure mode is distinguishable:
//       ORDERBOOK_BINANCE_HTTP_<status>   non-2xx (incl. 451/403/418/429 geo
//                                         or rate blocks from a cloud egress)
//       ORDERBOOK_BINANCE_TIMEOUT         aborted by the local timeout
//       ORDERBOOK_BINANCE_FETCH_FAILED    transport/DNS/egress failure
//       ORDERBOOK_BINANCE_PARSE_FAILED    2xx body was not valid JSON
//       ORDERBOOK_BINANCE_INVALID_PAYLOAD valid JSON, unusable book shape
//       INVALID_ORDERBOOK_PAIR            pair rejected before any fetch
//   - Returns only the summarized fields the reclaim/absorption analysis
//     (_price-history-signals.mjs parseOrderbook) actually reads — no raw
//     depth levels, no wall detection — intentionally smaller than the
//     edge summarizer's shape.

const SPOT_BASE = 'https://api.binance.com';
const FUTURES_BASE = 'https://fapi.binance.com';
const DEPTH_LIMIT = 50;
const FETCH_TIMEOUT_MS = 4500;
const PAIR_RE = /^[A-Z0-9]{1,20}$/;

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Same fields analyzeAbsorptionFromPointsAndOrderbook's parseOrderbook()
// reads from the edge-bridge summary — nothing else is computed here.
function summarize(depth) {
  if (!depth || !Array.isArray(depth.bids) || !Array.isArray(depth.asks)) return null;

  const side = (rows) => rows
    .slice(0, DEPTH_LIMIT)
    .map((r) => (Array.isArray(r) ? [toNum(r[0]), toNum(r[1])] : null))
    .filter((r) => r && r[0] !== null && r[1] !== null && r[0] > 0 && r[1] >= 0);

  const bids = side(depth.bids);
  const asks = side(depth.asks);
  if (!bids.length || !asks.length) return null;

  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;

  const sumQty = (rows) => rows.reduce((s, [, q]) => s + q, 0);
  const bidQty = sumQty(bids);
  const askQty = sumQty(asks);
  const total = bidQty + askQty;

  return {
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: +spreadBps.toFixed(2),
    imbalance: total > 0 ? +(((bidQty - askQty) / total).toFixed(4)) : 0,
    cumulative_bid_qty: +bidQty.toFixed(4),
    cumulative_ask_qty: +askQty.toFixed(4),
  };
}

/**
 * Fetches Binance's public depth endpoint directly and returns the same
 * summarized shape as fetchOrderbookSummary's success result
 * ({ ok:true, orderbook, pair, market, source }).
 */
export async function fetchBinanceDepthSummary({ pair, market, fetchImpl, timeoutMs } = {}) {
  const normalizedPair = typeof pair === 'string' ? pair.trim().toUpperCase() : '';
  if (!PAIR_RE.test(normalizedPair)) {
    return { ok: false, reason: 'INVALID_ORDERBOOK_PAIR' };
  }
  const normalizedMarket = market === 'futures' ? 'futures' : 'spot';
  const base = normalizedMarket === 'futures' ? FUTURES_BASE : SPOT_BASE;
  const path = normalizedMarket === 'futures' ? '/fapi/v1/depth' : '/api/v3/depth';
  const url = `${base}${path}?symbol=${normalizedPair}&limit=${DEPTH_LIMIT}`;

  const doFetch = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number.isFinite(timeoutMs) ? timeoutMs : FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
  } catch {
    // A timeout and a transport-level failure are different operational
    // problems (upstream slow vs. egress blocked/unreachable) — the caller
    // must be able to tell them apart from the reason code alone.
    const reason = ctrl.signal.aborted ? 'ORDERBOOK_BINANCE_TIMEOUT' : 'ORDERBOOK_BINANCE_FETCH_FAILED';
    return { ok: false, reason, pair: normalizedPair, market: normalizedMarket };
  } finally {
    clearTimeout(timer);
  }

  // A geo/IP block from a cloud runtime surfaces here as a plain status
  // (commonly 451/403/418/429) — the status is reported, the body never is.
  if (!res.ok) {
    return { ok: false, reason: `ORDERBOOK_BINANCE_HTTP_${res.status}`, pair: normalizedPair, market: normalizedMarket };
  }

  let depth;
  try {
    depth = await res.json();
  } catch {
    return { ok: false, reason: 'ORDERBOOK_BINANCE_PARSE_FAILED', pair: normalizedPair, market: normalizedMarket };
  }

  // Parsed fine but the book is unusable (missing/empty sides, bad levels) —
  // distinct from a parse failure so a shape change upstream is diagnosable.
  const orderbook = summarize(depth);
  if (!orderbook) {
    return { ok: false, reason: 'ORDERBOOK_BINANCE_INVALID_PAYLOAD', pair: normalizedPair, market: normalizedMarket };
  }

  return { ok: true, orderbook, pair: normalizedPair, market: normalizedMarket, source: 'binance_direct' };
}
