// Admin-only, read-only debug endpoint for price-history analytics. The pure
// helpers never write, alert, score decision gates, or affect trading/ENTRY_READY.
//
// `/api/orderbook` is an authenticated Deno Edge Function reached here via
// the same-origin Node bridge in _orderbook-client.mjs. If that bridge
// fails for any reason other than an invalid pair, a best-effort fallback
// (_binance-orderbook-fallback.mjs) hits Binance's public depth endpoint
// directly — same upstream, GET-only, no private/order/account calls. The
// book is best effort either way: total failure still returns a normal 200
// with orderbookUsed:false and a stable orderbookReason — absorption always
// falls back to a history-only read. `orderbookSource` in the response
// tells the caller which path (if either) actually supplied the book.
import {
  analyzeAbsorptionFromPointsAndOrderbook,
  analyzeReclaimFromPoints,
} from './_price-history-signals.mjs';

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 200;

async function loadAuth() { return await import('./_auth.mjs'); }
async function loadPriceHistory() { return await import('./_price-history.mjs'); }
async function loadOrderbookClient() { return await import('./_orderbook-client.mjs'); }
async function loadBinanceDepthClient() { return await import('./_binance-orderbook-fallback.mjs'); }

function headers(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin, Authorization',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  };
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(req) });
}

function boundedInt(raw, fallback, min, max) {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

function parseSymbol(raw) {
  const symbol = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return /^[A-Z0-9]{1,30}$/.test(symbol) ? symbol : null;
}

export async function runAdminPriceHistorySignals(req, deps = {}) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });
  if (req.method !== 'GET') return json(req, { ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405);

  let getIdentity = deps.getIdentity;
  let isAdmin = deps.isAdmin;
  if (!getIdentity || !isAdmin) {
    try {
      const auth = await (deps.loadAuth || loadAuth)();
      getIdentity ||= auth.getIdentity;
      isAdmin ||= auth.isAdmin;
    } catch {
      return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);
    }
  }

  let identity;
  try { identity = await getIdentity(req); } catch { return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401); }
  if (!identity?.ok) return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);
  let admin = false;
  try { admin = isAdmin(identity); } catch { return json(req, { ok: false, reason: 'FORBIDDEN' }, 403); }
  if (identity.verified !== true || !admin) return json(req, { ok: false, reason: 'FORBIDDEN' }, 403);

  const url = new URL(req.url);
  const symbol = parseSymbol(url.searchParams.get('symbol'));
  if (!symbol) return json(req, { ok: false, reason: 'MISSING_OR_INVALID_SYMBOL' }, 400);
  const limit = boundedInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 8, MAX_LIMIT);
  const lookback = boundedInt(url.searchParams.get('lookback'), 20, 5, 200);
  const confirmations = boundedInt(url.searchParams.get('confirmations'), 2, 1, 10);
  const pairParam = url.searchParams.get('pair');
  const marketParam = url.searchParams.get('market');

  let reads = deps.reads;
  if (!reads) {
    try { reads = await (deps.loadPriceHistory || loadPriceHistory)(); } catch { return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503); }
  }
  let history;
  try { history = await reads.listRecentPricePoints({ symbol, limit }); } catch { return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503); }
  if (!history?.ok || !Array.isArray(history.points)) return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503);

  // Orderbook is best-effort context only — any failure here still lets the
  // endpoint succeed with a history-only read (see module header).
  let fetchOrderbookSummary = deps.fetchOrderbookSummary;
  if (!fetchOrderbookSummary) {
    try {
      const mod = await (deps.loadOrderbookClient || loadOrderbookClient)();
      fetchOrderbookSummary = mod.fetchOrderbookSummary;
    } catch {
      fetchOrderbookSummary = null;
    }
  }

  let orderbookUsed = false;
  let orderbookReason = 'ORDERBOOK_CLIENT_UNAVAILABLE';
  let orderbookSource = null;
  let orderbook;
  if (fetchOrderbookSummary) {
    let origin = null;
    try { origin = new URL(req.url).origin; } catch { origin = null; }
    const authorization = req.headers.get('authorization') || null;
    let obResult;
    try {
      obResult = await fetchOrderbookSummary({
        origin,
        pair: pairParam,
        symbol,
        market: marketParam,
        fetchImpl: deps.orderbookFetchImpl,
        headers: authorization ? { authorization } : undefined,
      });
    } catch {
      obResult = { ok: false, reason: 'ORDERBOOK_UNAVAILABLE' };
    }
    if (obResult && obResult.ok) {
      orderbookUsed = true;
      orderbookReason = 'OK';
      orderbookSource = 'api_orderbook';
      orderbook = obResult.orderbook;
    } else {
      orderbookReason = (obResult && obResult.reason) || 'ORDERBOOK_UNAVAILABLE';

      // Best-effort fallback: the same-origin edge bridge failed for a
      // reason other than an invalid pair — try Binance's PUBLIC depth
      // endpoint directly (same upstream /api/orderbook already uses) so a
      // Netlify Node->Edge routing hiccup doesn't silently drop live book
      // context. Reuses the pair/market the bridge already sanitized.
      const fallbackPair = obResult && obResult.pair;
      const fallbackMarket = obResult && obResult.market;
      if (fallbackPair) {
        let fetchBinanceDepthSummary = deps.fetchBinanceDepthSummary;
        if (!fetchBinanceDepthSummary) {
          try {
            const mod = await (deps.loadBinanceDepthClient || loadBinanceDepthClient)();
            fetchBinanceDepthSummary = mod.fetchBinanceDepthSummary;
          } catch {
            fetchBinanceDepthSummary = null;
          }
        }
        if (fetchBinanceDepthSummary) {
          let fbResult;
          try {
            fbResult = await fetchBinanceDepthSummary({
              pair: fallbackPair,
              market: fallbackMarket,
              fetchImpl: deps.binanceFetchImpl,
            });
          } catch {
            fbResult = { ok: false, reason: 'ORDERBOOK_BINANCE_FETCH_FAILED' };
          }
          if (fbResult && fbResult.ok) {
            orderbookUsed = true;
            orderbookReason = 'OK';
            orderbookSource = 'binance_direct';
            orderbook = fbResult.orderbook;
          }
        }
      }
    }
  }

  const options = { lookback, confirmations };
  const reclaim = analyzeReclaimFromPoints({ symbol, points: history.points, options });
  const absorption = analyzeAbsorptionFromPointsAndOrderbook({ symbol, points: history.points, orderbook, options });
  return json(req, {
    ok: true,
    symbol,
    points: history.points.length,
    orderbookUsed,
    orderbookReason,
    orderbookSource,
    reclaim,
    absorption,
  });
}

export default async function handler(req) { return await runAdminPriceHistorySignals(req); }

export const config = { path: '/api/admin-price-history-signals' };
