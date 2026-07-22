import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdminPriceHistorySignals } from '../netlify/functions/admin-price-history-signals.mjs';

const URL = 'https://swingterminalx.netlify.app/api/admin-price-history-signals';
const ADMIN = { ok: true, verified: true };
const NON_ADMIN = { ok: true, verified: true };
const UNVERIFIED_ADMIN = { ok: true, verified: false };
const POINTS = [110, 108, 106, 104, 104, 104.2, 104.4, 104.6].map((price_usd, i) => ({ symbol: 'BTC', sampled_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), price_usd, volume_24h_usd: i < 4 ? 100 : 220 }));

function req(method, query = 'symbol=btc', headers = {}) { return new Request(`${URL}?${query}`, { method, headers }); }

// deps.fetchOrderbookSummary and deps.fetchBinanceDepthSummary both default
// to stubs that report unavailable so tests never trigger a real module
// load / network fetch (edge bridge OR the Binance-direct fallback) unless
// a case wants to exercise that path explicitly.
function call(method, {
  identity = ADMIN, isAdmin = (id) => id === ADMIN || id === UNVERIFIED_ADMIN, reads, query, headers,
  fetchOrderbookSummary = async () => ({ ok: false, reason: 'ORDERBOOK_UNAVAILABLE' }),
  fetchBinanceDepthSummary = async () => ({ ok: false, reason: 'ORDERBOOK_BINANCE_FETCH_FAILED' }),
  ...extra
} = {}) {
  return runAdminPriceHistorySignals(req(method, query, headers), {
    getIdentity: async () => identity,
    isAdmin,
    reads: reads || { listRecentPricePoints: async () => ({ ok: true, points: POINTS }) },
    fetchOrderbookSummary,
    fetchBinanceDepthSummary,
    ...extra,
  });
}

test('non-GET returns 405 before auth or database work', async () => {
  let authCalled = false; let dbCalled = false;
  const res = await runAdminPriceHistorySignals(req('POST'), { getIdentity: async () => { authCalled = true; return ADMIN; }, isAdmin: () => true, reads: { listRecentPricePoints: async () => { dbCalled = true; return { ok: true, points: [] }; } } });
  assert.equal(res.status, 405); assert.equal(authCalled, false); assert.equal(dbCalled, false);
});

test('unauthenticated, non-admin, and unverified-admin requests fail closed', async () => {
  assert.equal((await call('GET', { identity: { ok: false } })).status, 401);
  assert.equal((await call('GET', { identity: NON_ADMIN })).status, 403);
  assert.equal((await call('GET', { identity: UNVERIFIED_ADMIN })).status, 403);
});

test('missing symbol returns 400 and database unavailable returns 503', async () => {
  assert.equal((await call('GET', { query: '' })).status, 400);
  const res = await call('GET', { reads: { listRecentPricePoints: async () => ({ ok: false }) } });
  assert.equal(res.status, 503); assert.deepEqual(await res.json(), { ok: false, reason: 'DB_UNAVAILABLE' });
});

test('valid admin request with no stored points returns 200 NO_HISTORY without probing orderbook', async () => {
  let orderbookCalled = false;
  const res = await call('GET', {
    query: 'symbol=home',
    reads: { listRecentPricePoints: async () => ({ ok: true, points: [] }) },
    fetchOrderbookSummary: async () => { orderbookCalled = true; return { ok: true }; },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.symbol, 'HOME');
  assert.equal(body.status, 'NO_HISTORY');
  assert.equal(body.points, 0);
  assert.equal(body.orderbookReason, 'NO_HISTORY');
  assert.equal(body.reclaim.status, 'INSUFFICIENT_HISTORY');
  assert.equal(body.reclaim.reason, 'No scheduled history yet.');
  assert.equal(body.absorption.status, 'INSUFFICIENT_HISTORY');
  assert.equal(body.absorption.reason, 'No scheduled history yet.');
  assert.equal(orderbookCalled, false);
});

test('valid admin request with short history returns 200 INSUFFICIENT_HISTORY without probing orderbook', async () => {
  let orderbookCalled = false;
  const res = await call('GET', {
    query: 'symbol=home',
    reads: { listRecentPricePoints: async () => ({ ok: true, points: POINTS.slice(0, 2) }) },
    fetchOrderbookSummary: async () => { orderbookCalled = true; return { ok: true }; },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, 'INSUFFICIENT_HISTORY');
  assert.equal(body.points, 2);
  assert.equal(body.orderbookReason, 'INSUFFICIENT_HISTORY');
  assert.equal(body.reclaim.status, 'INSUFFICIENT_HISTORY');
  assert.equal(body.absorption.status, 'INSUFFICIENT_HISTORY');
  assert.equal(orderbookCalled, false);
});

test('success without orderbook still works, bounds input, and reports a stable orderbookReason', async () => {
  let captured;
  const res = await call('GET', { query: 'symbol=btc&limit=999999&lookback=999999', reads: { listRecentPricePoints: async (args) => { captured = args; return { ok: true, points: POINTS }; } } });
  assert.equal(res.status, 200); assert.deepEqual(captured, { symbol: 'BTC', limit: 200 });
  const body = await res.json();
  assert.equal(body.symbol, 'BTC'); assert.equal(body.points, POINTS.length);
  assert.equal(body.orderbookUsed, false); assert.equal(body.orderbookReason, 'ORDERBOOK_UNAVAILABLE');
  assert.equal(body.orderbookSource, null);
  assert.equal(body.orderbookBridgeReason, 'ORDERBOOK_UNAVAILABLE');
  // No pair came back from the bridge, so the fallback had nothing sanitized
  // to reuse and was never attempted.
  assert.equal(body.orderbookFallbackReason, null);
  assert.ok(body.reclaim); assert.ok(body.absorption);
});

test('successful orderbook fetch makes orderbookUsed:true, orderbookReason:OK, and orderbookSource:api_orderbook, alongside reclaim/absorption', async () => {
  const summary = { best_bid: 100, best_ask: 100.1, spread_bps: 10, imbalance: 0.35, cumulative_bid_qty: 5, cumulative_ask_qty: 3 };
  let captured;
  let fallbackCalled = false;
  const res = await call('GET', {
    fetchOrderbookSummary: async (args) => { captured = args; return { ok: true, orderbook: summary, pair: 'BTCUSDT', market: 'spot', source: 'api_orderbook' }; },
    fetchBinanceDepthSummary: async () => { fallbackCalled = true; return { ok: false, reason: 'ORDERBOOK_BINANCE_FETCH_FAILED' }; },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.orderbookUsed, true);
  assert.equal(body.orderbookReason, 'OK');
  assert.equal(body.orderbookSource, 'api_orderbook');
  assert.equal(body.orderbookBridgeReason, 'OK');
  assert.equal(body.orderbookFallbackReason, null);
  assert.ok(body.reclaim);
  assert.ok(body.absorption);
  assert.equal(body.absorption.orderbookUsed, true);
  assert.equal(captured.symbol, 'BTC');
  // The bridge already succeeded — the Binance-direct fallback must never
  // be attempted when the primary path already delivered a live book.
  assert.equal(fallbackCalled, false);
});

// A different upstream cannot repair an authorization/origin rejection, so
// the fallback must not run and the specific, safe auth reason must survive
// rather than being flattened into a generic unavailable.
test('an auth/origin bridge failure keeps its specific reason and never attempts the Binance-direct fallback', async () => {
  let fallbackCalled = false;
  const res = await call('GET', {
    fetchOrderbookSummary: async () => ({ ok: false, reason: 'ORDERBOOK_AUTH_REQUIRED', pair: 'BTCUSDT', market: 'spot' }),
    fetchBinanceDepthSummary: async () => { fallbackCalled = true; return { ok: true, orderbook: { best_bid: 1, best_ask: 2, imbalance: 0 } }; },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.orderbookUsed, false);
  assert.equal(body.orderbookReason, 'ORDERBOOK_AUTH_REQUIRED');
  assert.equal(body.orderbookBridgeReason, 'ORDERBOOK_AUTH_REQUIRED');
  assert.equal(body.orderbookFallbackReason, null);
  assert.equal(body.orderbookSource, null);
  assert.equal(fallbackCalled, false, 'an auth failure must never be retried against Binance directly');
  assert.ok(body.reclaim);
  assert.ok(body.absorption);
  assert.equal(body.absorption.orderbookUsed, false);
});

// CASE A — reproduces the production symptom (bridge 502) and asserts the
// fallback actually rescues it, rather than the endpoint reporting the stale
// bridge reason with orderbookSource:null.
test('CASE A: bridge ORDERBOOK_HTTP_502 + fallback success yields orderbookUsed:true, source binance_direct, and no lingering 502 as the final reason', async () => {
  const summary = { best_bid: 200, best_ask: 200.2, spread_bps: 10, imbalance: -0.1, cumulative_bid_qty: 4, cumulative_ask_qty: 5 };
  let fallbackArgs;
  const res = await call('GET', {
    fetchOrderbookSummary: async () => ({ ok: false, reason: 'ORDERBOOK_HTTP_502', pair: 'BTCUSDT', market: 'spot' }),
    fetchBinanceDepthSummary: async (args) => { fallbackArgs = args; return { ok: true, orderbook: summary, pair: 'BTCUSDT', market: 'spot', source: 'binance_direct' }; },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.orderbookUsed, true);
  assert.equal(body.orderbookSource, 'binance_direct');
  assert.equal(body.orderbookReason, 'OK');
  assert.notEqual(body.orderbookReason, 'ORDERBOOK_HTTP_502');
  // The bridge's own failure is still reported for diagnosis, without
  // masking the fact that a live book was ultimately obtained.
  assert.equal(body.orderbookBridgeReason, 'ORDERBOOK_HTTP_502');
  assert.equal(body.orderbookFallbackReason, 'OK');
  assert.equal(body.absorption.orderbookUsed, true);
  assert.deepEqual({ pair: fallbackArgs.pair, market: fallbackArgs.market }, { pair: 'BTCUSDT', market: 'spot' });
});

// CASE B — the exact bug this change fixes: previously the fallback's own
// failure reason was swallowed, so a dead bridge and a dead bridge PLUS a
// dead fallback were indistinguishable in production.
test('CASE B: bridge 502 + fallback failure reports both reasons precisely instead of swallowing the fallback error', async () => {
  const res = await call('GET', {
    fetchOrderbookSummary: async () => ({ ok: false, reason: 'ORDERBOOK_HTTP_502', pair: 'BTCUSDT', market: 'spot' }),
    fetchBinanceDepthSummary: async () => ({ ok: false, reason: 'ORDERBOOK_BINANCE_HTTP_451' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.orderbookUsed, false);
  assert.equal(body.orderbookSource, null);
  assert.equal(body.orderbookReason, 'ORDERBOOK_UNAVAILABLE');
  assert.equal(body.orderbookBridgeReason, 'ORDERBOOK_HTTP_502');
  assert.equal(body.orderbookFallbackReason, 'ORDERBOOK_BINANCE_HTTP_451');
  // History-only signals still come back on a 200 — orderbook failure never
  // fails the endpoint hard.
  assert.ok(body.reclaim);
  assert.ok(body.absorption);
  assert.equal(body.absorption.orderbookUsed, false);
});

test('CASE B: a fallback that throws is reported as a stable fallback reason, never a raw error message', async () => {
  const res = await call('GET', {
    fetchOrderbookSummary: async () => ({ ok: false, reason: 'ORDERBOOK_FETCH_FAILED', pair: 'BTCUSDT', market: 'spot' }),
    fetchBinanceDepthSummary: async () => { throw new Error('simulated Binance fallback failure'); },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.orderbookUsed, false);
  assert.equal(body.orderbookSource, null);
  assert.equal(body.orderbookReason, 'ORDERBOOK_UNAVAILABLE');
  assert.equal(body.orderbookBridgeReason, 'ORDERBOOK_FETCH_FAILED');
  assert.equal(body.orderbookFallbackReason, 'ORDERBOOK_BINANCE_FETCH_FAILED');
  assert.equal(JSON.stringify(body).includes('simulated Binance fallback failure'), false);
});

test('CASE B: an unloadable fallback module is reported rather than silently ignored', async () => {
  const res = await call('GET', {
    fetchOrderbookSummary: async () => ({ ok: false, reason: 'ORDERBOOK_HTTP_502', pair: 'BTCUSDT', market: 'spot' }),
    // null (not undefined) so the helper's default stub does not apply and
    // the real module-load path is exercised.
    fetchBinanceDepthSummary: null,
    loadBinanceDepthClient: async () => { throw new Error('module load failed'); },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.orderbookUsed, false);
  assert.equal(body.orderbookReason, 'ORDERBOOK_UNAVAILABLE');
  assert.equal(body.orderbookBridgeReason, 'ORDERBOOK_HTTP_502');
  assert.equal(body.orderbookFallbackReason, 'ORDERBOOK_FALLBACK_CLIENT_UNAVAILABLE');
  assert.equal(JSON.stringify(body).includes('module load failed'), false);
});

// CASE C — an unusable pair must never be handed to the fallback, so no
// Binance URL can be built from unsanitized input.
test('CASE C: invalid pair keeps its specific reason and never reaches the Binance-direct fallback', async () => {
  let fallbackCalled = false;
  const res = await call('GET', {
    query: 'symbol=btc&pair=not-valid!!',
    fetchOrderbookSummary: async () => ({ ok: false, reason: 'INVALID_ORDERBOOK_PAIR' }),
    fetchBinanceDepthSummary: async () => { fallbackCalled = true; return { ok: false, reason: 'ORDERBOOK_BINANCE_FETCH_FAILED' }; },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.orderbookUsed, false);
  assert.equal(body.orderbookReason, 'INVALID_ORDERBOOK_PAIR');
  assert.equal(body.orderbookBridgeReason, 'INVALID_ORDERBOOK_PAIR');
  assert.equal(body.orderbookFallbackReason, null);
  assert.equal(body.orderbookSource, null);
  // INVALID_ORDERBOOK_PAIR carries no pair/market, and is additionally on the
  // no-fallback list — the fallback must not run under any circumstance.
  assert.equal(fallbackCalled, false);
});

test('orderbook failures are logged with stable codes only — never a token, header, or raw upstream body', async () => {
  const originalWarn = console.warn;
  const logged = [];
  console.warn = (...args) => logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try {
    await call('GET', {
      headers: { authorization: 'Bearer super-secret-admin-token' },
      fetchOrderbookSummary: async () => ({ ok: false, reason: 'ORDERBOOK_HTTP_502', pair: 'BTCUSDT', market: 'spot' }),
      fetchBinanceDepthSummary: async () => ({ ok: false, reason: 'ORDERBOOK_BINANCE_HTTP_451' }),
    });
  } finally {
    console.warn = originalWarn;
  }
  const all = logged.join(' | ');
  assert.ok(all.includes('ORDERBOOK_HTTP_502'), 'the bridge failure must be logged');
  assert.ok(all.includes('ORDERBOOK_BINANCE_HTTP_451'), 'the fallback failure must be logged, not swallowed');
  for (const forbidden of ['super-secret-admin-token', 'authorization', 'bearer', 'cookie']) {
    assert.equal(all.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test('orderbook client throwing still degrades to a safe history-only response', async () => {
  const res = await call('GET', { fetchOrderbookSummary: async () => { throw new Error('simulated orderbook client failure'); } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.orderbookUsed, false);
  assert.equal(body.orderbookReason, 'ORDERBOOK_UNAVAILABLE');
  assert.equal(JSON.stringify(body).includes('simulated orderbook client failure'), false);
});

test('the incoming Authorization header is forwarded to the orderbook client but never echoed back', async () => {
  let capturedHeaders;
  const res = await call('GET', {
    headers: { authorization: 'Bearer super-secret-admin-token' },
    fetchOrderbookSummary: async (args) => { capturedHeaders = args.headers; return { ok: false, reason: 'ORDERBOOK_UNAVAILABLE' }; },
  });
  assert.equal(capturedHeaders.authorization, 'Bearer super-secret-admin-token');
  const raw = await res.text();
  assert.equal(raw.includes('super-secret-admin-token'), false);
});

test('response never contains a raw orderbook dump, raw_meta, or a secret-shaped key', async () => {
  const summary = { best_bid: 100, best_ask: 100.1, spread_bps: 10, imbalance: 0.35, cumulative_bid_qty: 5, cumulative_ask_qty: 3, top5_bids: [[100, 1]], top5_asks: [[100.1, 1]], walls: { bids: [], asks: [] } };
  const res = await call('GET', { fetchOrderbookSummary: async () => ({ ok: true, orderbook: summary, pair: 'BTCUSDT', market: 'spot', source: 'api_orderbook' }) });
  const raw = await res.text();
  for (const forbidden of ['raw_meta', 'token', 'secret', 'password', 'db_url', 'chat_id', 'user_id', 'top5_bids', 'top5_asks', 'walls']) {
    assert.equal(raw.toLowerCase().includes(forbidden), false, forbidden);
  }
});

// Netlify Node cannot reach a Binance book (bridge 502 / direct 451), so the
// endpoint must say so explicitly rather than implying it tried and the data
// simply does not exist — the client uses this to decide whether to fetch
// /api/orderbook itself.
test('a server that cannot obtain a book advertises orderbookMode:external_browser_required', async () => {
  const res = await call('GET', {
    fetchOrderbookSummary: async () => ({ ok: false, reason: 'ORDERBOOK_HTTP_502', pair: 'BTCUSDT', market: 'spot' }),
    fetchBinanceDepthSummary: async () => ({ ok: false, reason: 'ORDERBOOK_BINANCE_HTTP_451' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.serverOrderbookAvailable, false);
  assert.equal(body.orderbookMode, 'external_browser_required');
  assert.equal(body.orderbookBridgeReason, 'ORDERBOOK_HTTP_502');
  assert.equal(body.orderbookFallbackReason, 'ORDERBOOK_BINANCE_HTTP_451');
  // Reclaim is pure history and must remain fully usable server-side.
  assert.ok(body.reclaim);
});

test('a server that did obtain a book advertises orderbookMode:server', async () => {
  const summary = { best_bid: 100, best_ask: 100.1, spread_bps: 10, imbalance: 0.35, cumulative_bid_qty: 5, cumulative_ask_qty: 3 };
  const res = await call('GET', {
    fetchOrderbookSummary: async () => ({ ok: true, orderbook: summary, pair: 'BTCUSDT', market: 'spot', source: 'api_orderbook' }),
  });
  const body = await res.json();
  assert.equal(body.serverOrderbookAvailable, true);
  assert.equal(body.orderbookMode, 'server');
});

test('no write call and no trading/RADAR imports in this endpoint', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new globalThis.URL('../netlify/functions/admin-price-history-signals.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /writeMarketPriceSnapshot|_price-history-writer|bot\.mjs|cron-alerts|radar/i);
});
