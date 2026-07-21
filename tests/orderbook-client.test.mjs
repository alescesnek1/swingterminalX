// Tests for netlify/functions/_orderbook-client.mjs — a pure Node bridge
// to the existing /api/orderbook Deno Edge Function. All fetches are
// dependency-injected; no real network call is ever made.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeOrderbookPair,
  normalizeOrderbookMarket,
  fetchOrderbookSummary,
} from '../netlify/functions/_orderbook-client.mjs';

const ORIGIN = 'https://swingterminalx.netlify.app';
const SUMMARY = {
  best_bid: 100, best_ask: 100.1, spread_bps: 10, imbalance: 0.2,
  top5_bids: [], top5_asks: [], cumulative_bid_qty: 5, cumulative_ask_qty: 4,
  walls: { bids: [], asks: [] },
};

function okFetch(body = { pair: 'BTCUSDT', market: 'spot', orderbook: SUMMARY }) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

test('normalizeOrderbookPair uppercases, bounds length, and rejects non-alphanumeric', () => {
  assert.equal(normalizeOrderbookPair('btcusdt'), 'BTCUSDT');
  assert.equal(normalizeOrderbookPair('BTC-USDT'), null);
  assert.equal(normalizeOrderbookPair(''), null);
  assert.equal(normalizeOrderbookPair('A'.repeat(21)), null);
  assert.equal(normalizeOrderbookPair(null), null);
});

test('normalizeOrderbookMarket only allows spot or futures, defaulting to spot', () => {
  assert.equal(normalizeOrderbookMarket('futures'), 'futures');
  assert.equal(normalizeOrderbookMarket('spot'), 'spot');
  assert.equal(normalizeOrderbookMarket('margin'), 'spot');
  assert.equal(normalizeOrderbookMarket(undefined), 'spot');
});

test('builds a static /api/orderbook URL with only pair and market', async () => {
  let capturedUrl = null;
  await fetchOrderbookSummary({
    origin: ORIGIN, pair: 'btcusdt', market: 'spot',
    fetchImpl: async (u) => { capturedUrl = u; return { ok: true, status: 200, json: async () => ({ orderbook: SUMMARY }) }; },
  });
  assert.equal(capturedUrl, `${ORIGIN}/api/orderbook?pair=BTCUSDT&market=spot`);
});

test('derives pair from symbol when pair is absent', async () => {
  let capturedUrl = null;
  await fetchOrderbookSummary({
    origin: ORIGIN, symbol: 'btc',
    fetchImpl: async (u) => { capturedUrl = u; return { ok: true, status: 200, json: async () => ({ orderbook: SUMMARY }) }; },
  });
  assert.equal(capturedUrl, `${ORIGIN}/api/orderbook?pair=BTCUSDT&market=spot`);
});

test('rejects an invalid pair without calling fetch', async () => {
  let called = false;
  const res = await fetchOrderbookSummary({ origin: ORIGIN, pair: 'not-a-valid-pair!!', fetchImpl: async () => { called = true; } });
  assert.deepEqual(res, { ok: false, reason: 'INVALID_ORDERBOOK_PAIR' });
  assert.equal(called, false);
});

test('rejects when neither pair nor symbol is usable', async () => {
  const res = await fetchOrderbookSummary({ origin: ORIGIN, fetchImpl: async () => ({}) });
  assert.deepEqual(res, { ok: false, reason: 'INVALID_ORDERBOOK_PAIR' });
});

test('market is bounded to spot/futures regardless of input', async () => {
  let capturedUrl = null;
  await fetchOrderbookSummary({
    origin: ORIGIN, pair: 'BTCUSDT', market: 'nonsense',
    fetchImpl: async (u) => { capturedUrl = u; return { ok: true, status: 200, json: async () => ({ orderbook: SUMMARY }) }; },
  });
  assert.match(capturedUrl, /market=spot$/);
});

test('upstream 401/403 map to ORDERBOOK_AUTH_REQUIRED', async () => {
  for (const status of [401, 403]) {
    const res = await fetchOrderbookSummary({
      origin: ORIGIN, pair: 'BTCUSDT',
      fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: 'Unauthorized' }) }),
    });
    assert.deepEqual(res, { ok: false, reason: 'ORDERBOOK_AUTH_REQUIRED', pair: 'BTCUSDT', market: 'spot' });
  }
});

test('upstream non-2xx HTTP status maps to a granular ORDERBOOK_HTTP_<status> reason, never the raw body', async () => {
  for (const status of [500, 502, 503]) {
    const res = await fetchOrderbookSummary({
      origin: ORIGIN, pair: 'BTCUSDT',
      fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: 'Order book upstream failed', detail: 'connect ECONNREFUSED 1.2.3.4' }) }),
    });
    assert.deepEqual(res, { ok: false, reason: `ORDERBOOK_HTTP_${status}`, pair: 'BTCUSDT', market: 'spot' });
    assert.equal(JSON.stringify(res).includes('ECONNREFUSED'), false);
  }
});

test('a thrown fetch error maps to ORDERBOOK_FETCH_FAILED, never the raw error message', async () => {
  const res = await fetchOrderbookSummary({
    origin: ORIGIN, pair: 'BTCUSDT',
    fetchImpl: async () => { throw new Error('simulated network detail'); },
  });
  assert.deepEqual(res, { ok: false, reason: 'ORDERBOOK_FETCH_FAILED', pair: 'BTCUSDT', market: 'spot' });
});

test('a 2xx response with unusable JSON/shape maps to ORDERBOOK_INVALID_RESPONSE', async () => {
  const badJson = await fetchOrderbookSummary({
    origin: ORIGIN, pair: 'BTCUSDT',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
  });
  assert.deepEqual(badJson, { ok: false, reason: 'ORDERBOOK_INVALID_RESPONSE', pair: 'BTCUSDT', market: 'spot' });

  const missingOrderbook = await fetchOrderbookSummary({
    origin: ORIGIN, pair: 'BTCUSDT',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ pair: 'BTCUSDT' }) }),
  });
  assert.deepEqual(missingOrderbook, { ok: false, reason: 'ORDERBOOK_INVALID_RESPONSE', pair: 'BTCUSDT', market: 'spot' });
});

test('a slow upstream is aborted after the timeout and mapped to ORDERBOOK_FETCH_FAILED instead of hanging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchPromise = fetchOrderbookSummary({
    origin: ORIGIN, pair: 'BTCUSDT',
    fetchImpl: (u, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  t.mock.timers.tick(5000);
  const res = await fetchPromise;
  assert.deepEqual(res, { ok: false, reason: 'ORDERBOOK_FETCH_FAILED', pair: 'BTCUSDT', market: 'spot' });
});

test('success returns the summarized orderbook and source tag', async () => {
  const res = await fetchOrderbookSummary({ origin: ORIGIN, pair: 'BTCUSDT', fetchImpl: okFetch() });
  assert.deepEqual(res, { ok: true, orderbook: SUMMARY, pair: 'BTCUSDT', market: 'spot', source: 'api_orderbook' });
});

// /api/orderbook enforces checkOrigin() before verifyAuth() (Deno Edge
// Function, apps/edge/netlify/edge-functions/lib/security.js) — without an
// Origin header every same-origin call is rejected before auth is even
// checked, regardless of Authorization.
test('Origin header is always forwarded so /api/orderbook origin-lockdown passes', async () => {
  let capturedHeaders = null;
  await fetchOrderbookSummary({
    origin: ORIGIN, pair: 'BTCUSDT',
    fetchImpl: async (u, init) => { capturedHeaders = init.headers; return { ok: true, status: 200, json: async () => ({ orderbook: SUMMARY }) }; },
  });
  assert.equal(capturedHeaders.Origin, ORIGIN);
  assert.equal(capturedHeaders.Accept, 'application/json');
  assert.equal(capturedHeaders.Authorization, undefined);
});

test('Authorization header is forwarded but never logged or echoed back', async () => {
  const originalWarn = console.warn;
  const originalError = console.error;
  const logged = [];
  console.warn = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));
  try {
    let capturedHeaders = null;
    const res = await fetchOrderbookSummary({
      origin: ORIGIN, pair: 'BTCUSDT',
      headers: { authorization: 'Bearer super-secret-admin-token', cookie: 'session=abc' },
      fetchImpl: async (u, init) => { capturedHeaders = init.headers; return { ok: true, status: 200, json: async () => ({ orderbook: SUMMARY }) }; },
    });
    assert.equal(capturedHeaders.Authorization, 'Bearer super-secret-admin-token');
    assert.equal(capturedHeaders.cookie, undefined);
    assert.equal(capturedHeaders.Cookie, undefined);
    const raw = JSON.stringify(res);
    assert.equal(raw.includes('super-secret-admin-token'), false);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
  assert.equal(logged.some((l) => l.includes('super-secret-admin-token')), false);
});
