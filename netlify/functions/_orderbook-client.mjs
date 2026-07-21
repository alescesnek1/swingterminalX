// Pure Node bridge to the existing /api/orderbook Deno Edge Function
// (apps/edge/netlify/edge-functions/orderbook.js) so Node-based admin
// endpoints can reuse its summarized book instead of duplicating the
// Binance depth fetch.
//
// SAFETY MODEL
//   - No import-time fetch, no env requirement of its own.
//   - Only ever calls the trusted origin's static /api/orderbook path with
//     a sanitized pair/market — never forwards req.url or arbitrary query
//     strings.
//   - /api/orderbook is auth-protected, so the caller's Authorization
//     header is the only header ever forwarded, and only when explicitly
//     passed in — cookies and every other header are dropped. The header
//     value is never logged and never appears in any returned object.
//   - Upstream errors collapse to stable reason codes; the raw upstream
//     body/message is never surfaced.

export function normalizeOrderbookPair(input) {
  const pair = typeof input === 'string' ? input.trim().toUpperCase() : '';
  if (!pair || pair.length > 20 || !/^[A-Z0-9]+$/.test(pair)) return null;
  return pair;
}

export function normalizeOrderbookMarket(input) {
  return input === 'futures' ? 'futures' : 'spot';
}

/**
 * Fetches and returns the summarized order book from the same-origin
 * /api/orderbook route. Never throws — every path resolves to
 * { ok:true, orderbook, pair, market, source:'api_orderbook' } or
 * { ok:false, reason, pair?, market? }.
 */
export async function fetchOrderbookSummary({ origin, pair, symbol, market, fetchImpl, headers } = {}) {
  const normalizedMarket = normalizeOrderbookMarket(market);

  let rawPair = pair;
  if ((typeof rawPair !== 'string' || !rawPair.trim()) && typeof symbol === 'string' && symbol.trim()) {
    rawPair = `${symbol.trim().toUpperCase()}USDT`;
  }
  const normalizedPair = normalizeOrderbookPair(rawPair);
  if (!normalizedPair) {
    return { ok: false, reason: 'INVALID_ORDERBOOK_PAIR' };
  }

  if (typeof origin !== 'string' || !origin.trim()) {
    return { ok: false, reason: 'ORDERBOOK_UNAVAILABLE', pair: normalizedPair, market: normalizedMarket };
  }

  let url;
  try {
    url = new URL('/api/orderbook', origin);
  } catch {
    return { ok: false, reason: 'ORDERBOOK_UNAVAILABLE', pair: normalizedPair, market: normalizedMarket };
  }
  url.searchParams.set('pair', normalizedPair);
  url.searchParams.set('market', normalizedMarket);

  // Only the caller-supplied Authorization value is ever forwarded; no
  // cookies, no other headers, never logged.
  const outgoingHeaders = { Accept: 'application/json' };
  const authorization = headers && typeof headers.authorization === 'string' ? headers.authorization : null;
  if (authorization) outgoingHeaders.Authorization = authorization;

  const doFetch = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await doFetch(url.toString(), { headers: outgoingHeaders });
  } catch {
    return { ok: false, reason: 'ORDERBOOK_UNAVAILABLE', pair: normalizedPair, market: normalizedMarket };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'ORDERBOOK_AUTH_REQUIRED', pair: normalizedPair, market: normalizedMarket };
  }
  if (!res.ok) {
    return { ok: false, reason: 'ORDERBOOK_UNAVAILABLE', pair: normalizedPair, market: normalizedMarket };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'ORDERBOOK_UNAVAILABLE', pair: normalizedPair, market: normalizedMarket };
  }

  if (!body || typeof body !== 'object' || !body.orderbook || typeof body.orderbook !== 'object') {
    return { ok: false, reason: 'ORDERBOOK_UNAVAILABLE', pair: normalizedPair, market: normalizedMarket };
  }

  return { ok: true, orderbook: body.orderbook, pair: normalizedPair, market: normalizedMarket, source: 'api_orderbook' };
}
