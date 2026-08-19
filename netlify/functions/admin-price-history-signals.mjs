// Admin-only, read-only debug endpoint for price-history analytics. The pure
// helpers never write, alert, score decision gates, or affect trading/ENTRY_READY.
//
// `/api/orderbook` is an authenticated Deno Edge Function reached here via
// the same-origin Node bridge in _orderbook-client.mjs. If that bridge
// fails for a NON-auth reason, a best-effort fallback
// (_binance-orderbook-fallback.mjs) hits Binance's public depth endpoint
// directly — same upstream, GET-only, no private/order/account calls.
//
// The book is best effort either way: total failure still returns a normal
// 200 with orderbookUsed:false — absorption always degrades to a
// history-only read. Four response fields make the outcome unambiguous,
// because a swallowed fallback error previously made a dead bridge and a
// dead fallback look identical in production:
//   orderbookUsed          — did we get a live book at all
//   orderbookSource        — 'api_orderbook' | 'binance_direct' | null
//   orderbookBridgeReason  — the edge bridge's own stable code ('OK' on success)
//   orderbookFallbackReason— the Binance-direct code, or null if not attempted
//   orderbookReason        — 'OK', the specific bridge reason when no fallback
//                            was attempted, else 'ORDERBOOK_UNAVAILABLE'
// Both failure paths are also console.warn'd with stable codes only — never
// a raw upstream body, header, or token.
//
// KNOWN PRODUCTION CONSTRAINT — this endpoint is history-first by design.
// Netlify's Node runtime cannot obtain a Binance book at all: the Node->Edge
// bridge answers ORDERBOOK_HTTP_502, and a direct public-depth call answers
// ORDERBOOK_BINANCE_HTTP_451 (Binance geo-blocks the cloud egress IP). The
// same /api/orderbook route works fine from the BROWSER, which egresses from
// the user's own network. So the server no longer pretends it can supply a
// book: when it cannot, it reports serverOrderbookAvailable:false and
// orderbookMode:'external_browser_required', and the client is expected to
// GET /api/orderbook itself and merge the result via the browser-safe helper
// in apps/edge/public/js/price-history-orderbook.js. Reclaim is unaffected —
// it is pure history. Absorption degrades to a history-only read server-side
// and is enriched client-side when a browser book is available.
import {
  analyzeAbsorptionFromPointsAndOrderbook,
  analyzeReclaimFromPoints,
} from './_price-history-signals.mjs';

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 200;

// Bridge failures the Binance-direct fallback must NOT retry: a different
// upstream cannot fix an authorization/origin rejection or an unusable pair,
// and flattening those into a generic "unavailable" would hide the real,
// actionable reason from the operator.
const NO_FALLBACK_BRIDGE_REASONS = new Set([
  'ORDERBOOK_AUTH_REQUIRED',
  'INVALID_ORDERBOOK_PAIR',
]);

import {
  costGuardHeaders,
  noteCostBreakerBlock,
  priceHistoryReadsAllowed,
  REASON_DB_HISTORY_READS_DISABLED,
} from './_cost-breaker.mjs';

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

  // Emergency cost breaker: after auth, before the storage module is imported.
  // Reported as an explicit disabled state with UNKNOWN signals — never
  // DB_UNAVAILABLE (the database is fine; we declined to read) and never a
  // NO_ABSORPTION / NOT_CONFIRMED reading, which would be a bearish verdict
  // invented out of missing data.
  if (!priceHistoryReadsAllowed(deps.env || process.env)) {
    noteCostBreakerBlock('admin_price_history_signals', REASON_DB_HISTORY_READS_DISABLED);
    return new Response(JSON.stringify({
      ok: true, disabled: true, symbol, status: 'HISTORY_DISABLED',
      reason: REASON_DB_HISTORY_READS_DISABLED,
      points: 0,
      reclaim: { signal: 'UNKNOWN', status: 'UNKNOWN', reason: REASON_DB_HISTORY_READS_DISABLED },
      absorption: { signal: 'UNKNOWN', status: 'UNKNOWN', reason: REASON_DB_HISTORY_READS_DISABLED },
      orderbookMode: 'unavailable', orderbookReason: REASON_DB_HISTORY_READS_DISABLED,
    }), { status: 200, headers: costGuardHeaders(REASON_DB_HISTORY_READS_DISABLED, headers(req)) });
  }

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

  const options = { lookback, confirmations };
  const preliminaryReclaim = analyzeReclaimFromPoints({ symbol, points: history.points, options });
  const preliminaryAbsorption = analyzeAbsorptionFromPointsAndOrderbook({ symbol, points: history.points, orderbook: null, options });
  const historyStatus = history.points.length === 0
    ? 'NO_HISTORY'
    : (preliminaryReclaim.status === 'INSUFFICIENT_HISTORY' || preliminaryAbsorption.status === 'INSUFFICIENT_HISTORY')
      ? 'INSUFFICIENT_HISTORY' : null;
  if (historyStatus) {
    const noHistory = historyStatus === 'NO_HISTORY';
    const reason = noHistory ? 'No scheduled history yet.' : 'Insufficient history.';
    const reclaim = noHistory
      ? { ...preliminaryReclaim, status: 'INSUFFICIENT_HISTORY', reason }
      : preliminaryReclaim;
    const absorption = noHistory
      ? { ...preliminaryAbsorption, status: 'INSUFFICIENT_HISTORY', reason }
      : preliminaryAbsorption;
    return json(req, {
      ok: true,
      symbol,
      status: historyStatus,
      points: history.points.length,
      orderbookUsed: false,
      orderbookReason: noHistory ? 'NO_HISTORY' : 'INSUFFICIENT_HISTORY',
      orderbookBridgeReason: null,
      orderbookFallbackReason: null,
      orderbookSource: null,
      serverOrderbookAvailable: false,
      orderbookMode: 'external_browser_required',
      reclaim,
      absorption,
    });
  }

  let orderbookUsed = false;
  let orderbookReason = 'ORDERBOOK_CLIENT_UNAVAILABLE';
  let orderbookBridgeReason = null;
  let orderbookFallbackReason = null;
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
      orderbookBridgeReason = 'OK';
      orderbookSource = 'api_orderbook';
      orderbook = obResult.orderbook;
    } else {
      orderbookBridgeReason = (obResult && obResult.reason) || 'ORDERBOOK_UNAVAILABLE';
      orderbookReason = orderbookBridgeReason;
      console.warn('[ADMIN_PRICE_HISTORY_SIGNALS] orderbook_bridge_failed', { reason: orderbookBridgeReason });

      // Best-effort fallback: try Binance's PUBLIC depth endpoint directly
      // (the same upstream /api/orderbook itself calls) so a Netlify
      // Node->Edge routing failure doesn't silently drop live book context.
      // Reuses the pair/market the bridge already sanitized.
      //
      // Deliberately NOT retried when the bridge rejected the caller
      // (auth/origin) or the pair was invalid: a different upstream cannot
      // repair an authorization problem, and the specific, safe reason must
      // survive rather than being flattened into a generic unavailable.
      const fallbackPair = obResult && obResult.pair;
      const fallbackMarket = obResult && obResult.market;
      const fallbackAllowed = !!fallbackPair && !NO_FALLBACK_BRIDGE_REASONS.has(orderbookBridgeReason);

      if (fallbackAllowed) {
        let fetchBinanceDepthSummary = deps.fetchBinanceDepthSummary;
        if (!fetchBinanceDepthSummary) {
          try {
            const mod = await (deps.loadBinanceDepthClient || loadBinanceDepthClient)();
            fetchBinanceDepthSummary = mod.fetchBinanceDepthSummary;
          } catch {
            fetchBinanceDepthSummary = null;
          }
        }

        if (!fetchBinanceDepthSummary) {
          orderbookFallbackReason = 'ORDERBOOK_FALLBACK_CLIENT_UNAVAILABLE';
        } else {
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
            orderbookFallbackReason = 'OK';
            orderbookSource = 'binance_direct';
            orderbook = fbResult.orderbook;
          } else {
            orderbookFallbackReason = (fbResult && fbResult.reason) || 'ORDERBOOK_BINANCE_FETCH_FAILED';
          }
        }

        // Both paths failed. Report a generic top-level reason and keep the
        // two specific codes side by side, so "bridge broke AND the direct
        // book also broke" is never mistaken for a single bridge hiccup.
        if (!orderbookUsed) {
          orderbookReason = 'ORDERBOOK_UNAVAILABLE';
          console.warn('[ADMIN_PRICE_HISTORY_SIGNALS] orderbook_fallback_failed', {
            bridge: orderbookBridgeReason,
            fallback: orderbookFallbackReason,
          });
        }
      }
    }
  }

  const reclaim = analyzeReclaimFromPoints({ symbol, points: history.points, options });
  const absorption = analyzeAbsorptionFromPointsAndOrderbook({ symbol, points: history.points, orderbook, options });
  return json(req, {
    ok: true,
    symbol,
    status: 'OK',
    points: history.points.length,
    orderbookUsed,
    orderbookReason,
    orderbookBridgeReason,
    orderbookFallbackReason,
    orderbookSource,
    serverOrderbookAvailable: orderbookUsed,
    orderbookMode: orderbookUsed ? 'server' : 'external_browser_required',
    reclaim,
    absorption,
  });
}

export default async function handler(req) { return await runAdminPriceHistorySignals(req); }

export const config = { path: '/api/admin-price-history-signals' };
