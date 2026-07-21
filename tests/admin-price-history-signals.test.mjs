import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdminPriceHistorySignals } from '../netlify/functions/admin-price-history-signals.mjs';

const URL = 'https://swingterminalx.netlify.app/api/admin-price-history-signals';
const ADMIN = { ok: true, verified: true };
const NON_ADMIN = { ok: true, verified: true };
const UNVERIFIED_ADMIN = { ok: true, verified: false };
const POINTS = [110, 108, 106, 104, 104, 104.2, 104.4, 104.6].map((price_usd, i) => ({ symbol: 'BTC', sampled_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), price_usd, volume_24h_usd: i < 4 ? 100 : 220 }));

function req(method, query = 'symbol=btc', headers = {}) { return new Request(`${URL}?${query}`, { method, headers }); }

// deps.fetchOrderbookSummary defaults to a stub that reports unavailable so
// tests never trigger a real module load / network fetch unless a case
// wants to exercise that path explicitly.
function call(method, {
  identity = ADMIN, isAdmin = (id) => id === ADMIN || id === UNVERIFIED_ADMIN, reads, query, headers,
  fetchOrderbookSummary = async () => ({ ok: false, reason: 'ORDERBOOK_UNAVAILABLE' }),
  ...extra
} = {}) {
  return runAdminPriceHistorySignals(req(method, query, headers), {
    getIdentity: async () => identity,
    isAdmin,
    reads: reads || { listRecentPricePoints: async () => ({ ok: true, points: POINTS }) },
    fetchOrderbookSummary,
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

test('success without orderbook still works, bounds input, and reports a stable orderbookReason', async () => {
  let captured;
  const res = await call('GET', { query: 'symbol=btc&limit=999999&lookback=999999&confirmations=999', reads: { listRecentPricePoints: async (args) => { captured = args; return { ok: true, points: POINTS }; } } });
  assert.equal(res.status, 200); assert.deepEqual(captured, { symbol: 'BTC', limit: 200 });
  const body = await res.json();
  assert.equal(body.symbol, 'BTC'); assert.equal(body.points, POINTS.length);
  assert.equal(body.orderbookUsed, false); assert.equal(body.orderbookReason, 'ORDERBOOK_UNAVAILABLE');
  assert.ok(body.reclaim); assert.ok(body.absorption);
});

test('successful orderbook fetch makes orderbookUsed:true and orderbookReason:OK, alongside reclaim/absorption', async () => {
  const summary = { best_bid: 100, best_ask: 100.1, spread_bps: 10, imbalance: 0.35, cumulative_bid_qty: 5, cumulative_ask_qty: 3 };
  let captured;
  const res = await call('GET', {
    fetchOrderbookSummary: async (args) => { captured = args; return { ok: true, orderbook: summary, pair: 'BTCUSDT', market: 'spot', source: 'api_orderbook' }; },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.orderbookUsed, true);
  assert.equal(body.orderbookReason, 'OK');
  assert.ok(body.reclaim);
  assert.ok(body.absorption);
  assert.equal(body.absorption.orderbookUsed, true);
  assert.equal(captured.symbol, 'BTC');
});

test('orderbook auth failure still returns endpoint ok:true with orderbookUsed:false, falling back to history-only absorption', async () => {
  const res = await call('GET', { fetchOrderbookSummary: async () => ({ ok: false, reason: 'ORDERBOOK_AUTH_REQUIRED', pair: 'BTCUSDT', market: 'spot' }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.orderbookUsed, false);
  assert.equal(body.orderbookReason, 'ORDERBOOK_AUTH_REQUIRED');
  assert.ok(body.reclaim);
  assert.ok(body.absorption);
  assert.equal(body.absorption.orderbookUsed, false);
});

test('invalid pair returns a stable orderbook reason but does not crash the endpoint', async () => {
  const res = await call('GET', { query: 'symbol=btc&pair=not-valid!!', fetchOrderbookSummary: async () => ({ ok: false, reason: 'INVALID_ORDERBOOK_PAIR' }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.orderbookUsed, false);
  assert.equal(body.orderbookReason, 'INVALID_ORDERBOOK_PAIR');
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

test('no write call and no trading/RADAR imports in this endpoint', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new globalThis.URL('../netlify/functions/admin-price-history-signals.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /writeMarketPriceSnapshot|_price-history-writer|bot\.mjs|cron-alerts|radar/i);
});
