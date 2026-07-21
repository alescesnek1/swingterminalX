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

test('upstream 502 or thrown fetch error maps to ORDERBOOK_UNAVAILABLE', async () => {
  const res502 = await fetchOrderbookSummary({
    origin: ORIGIN, pair: 'BTCUSDT',
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ error: 'Order book upstream failed', detail: 'connect ECONNREFUSED 1.2.3.4' }) }),
  });
  assert.deepEqual(res502, { ok: false, reason: 'ORDERBOOK_UNAVAILABLE', pair: 'BTCUSDT', market: 'spot' });

  const resThrow = await fetchOrderbookSummary({
    origin: ORIGIN, pair: 'BTCUSDT',
    fetchImpl: async () => { throw new Error('simulated network detail'); },
  });
  assert.deepEqual(resThrow, { ok: false, reason: 'ORDERBOOK_UNAVAILABLE', pair: 'BTCUSDT', market: 'spot' });
});

test('success returns the summarized orderbook and source tag', async () => {
  const res = await fetchOrderbookSummary({ origin: ORIGIN, pair: 'BTCUSDT', fetchImpl: okFetch() });
  assert.deepEqual(res, { ok: true, orderbook: SUMMARY, pair: 'BTCUSDT', market: 'spot', source: 'api_orderbook' });
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
