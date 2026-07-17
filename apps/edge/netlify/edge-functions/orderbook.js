// ─────────────────────────────────────────────────────────────
// Swing Terminal — /api/orderbook Edge Function (Deno)
//
// Server-side order-book proxy. The detail-panel book used to fetch
// api.binance.com/api/v3/depth DIRECTLY from the browser, which:
//   • gets blocked by adblockers / Brave Shields / corporate proxies
//     (api.binance.com is on crypto blocklists) → the book silently
//     never loads for a chunk of users, even though Binance is up;
//   • was Spot-only, so ALPHA (perp-only) coins never got a book.
//
// Routing the depth call through OUR origin fixes both: the browser
// only ever talks to <site>/api/orderbook (never blocked — it's the
// site the user is already on), and this function talks to Binance
// server-to-server, where no adblocker/CORS applies. Same pattern the
// ticker already uses via /api/markets.
//
// Per the repo's error-observability rule: any upstream failure is
// (a) returned to the client with a clear reason so the UI can show it,
// and (b) logged via logWarn so it lands in Netlify function logs —
// never a silent empty book.
//
// GET /api/orderbook?pair=BTCUSDC&market=spot
// GET /api/orderbook?pair=BTCUSDT&market=futures
// ─────────────────────────────────────────────────────────────

import { checkOrigin, pickAllowOrigin, verifyAuth } from './lib/security.js';
import { normalizeBinanceSymbol, fetchOrderbook } from './lib/binance.js';
import { logWarn } from './lib/log.js';

// Tiny per-isolate cache so clicking around the same coin (or several
// users landing on the same hot isolate) doesn't hammer /depth. The
// book moves fast, so keep it short.
const CACHE_TTL_MS = 5_000;
const _cache = new Map(); // key `${market}:${pair}` -> { at, body }

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': pickAllowOrigin(request),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    'Vary': 'Origin',
  };
}

function json(request, body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

export default async function handler(request) {
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== 'GET') {
      return json(request, { error: 'Method Not Allowed' }, 405);
    }

    // 1. Origin lockdown (localhost + APP_ORIGIN + *.netlify.app).
    const originCheck = checkOrigin(request);
    if (!originCheck.ok) {
      return json(request, { error: 'Forbidden origin', detail: originCheck.reason }, 403);
    }

    // 2. JWT verify (Supabase signature + claim checks).
    const auth = await verifyAuth(request);
    if (!auth.ok) {
      return json(request, { error: 'Unauthorized', detail: auth.reason }, auth.status);
    }

    // 3. Params. `pair` is the exact Binance symbol the frontend already
    //    resolved (spot_pair for BIN, futures_pair for ALPHA); we still
    //    run it through normalizeBinanceSymbol to sanitize casing/quote.
    const url = new URL(request.url);
    const rawPair = url.searchParams.get('pair') || url.searchParams.get('symbol') || '';
    if (!rawPair || rawPair.length > 20) {
      return json(request, { error: 'Missing or invalid "pair"' }, 400);
    }
    const norm = normalizeBinanceSymbol(rawPair);
    if (!norm) return json(request, { error: 'Invalid pair format' }, 400);
    const market = url.searchParams.get('market') === 'futures' ? 'futures' : 'spot';

    // 4. Serve from the short per-isolate cache if fresh.
    const cacheKey = `${market}:${norm.pair}`;
    const now = Date.now();
    const cached = _cache.get(cacheKey);
    if (cached && now - cached.at < CACHE_TTL_MS) {
      return new Response(cached.body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Cache-Layer': 'memory', ...corsHeaders(request) },
      });
    }

    // 5. Fetch the book server-side. On failure: log + return a clear,
    //    visible error (502) — never a silent empty book.
    try {
      const orderbook = await fetchOrderbook({ pair: norm.pair, market });
      const body = JSON.stringify({
        pair: norm.pair,
        market,
        exchange: market === 'futures' ? 'ALPHA' : 'BIN',
        source: 'binance',
        fetched_at: new Date().toISOString(),
        orderbook,
      });
      _cache.set(cacheKey, { at: now, body });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Cache-Layer': 'miss', ...corsHeaders(request) },
      });
    } catch (e) {
      logWarn?.({
        location: 'orderbook/fetch',
        message: String(e?.message || e),
        payload: { pair: norm.pair, market },
      });
      return json(request, {
        error: 'Order book upstream failed',
        detail: String(e?.message || e),
        pair: norm.pair,
        market,
      }, 502);
    }
  } catch (err) {
    // Unexpected fault (not an upstream data issue). Still log it.
    logWarn?.({ location: 'orderbook/handler', message: String(err?.message || err) });
    return json(request, { error: 'Internal error', detail: String(err?.message || err) }, 500);
  }
}
