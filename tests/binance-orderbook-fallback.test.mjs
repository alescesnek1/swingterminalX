// Tests for netlify/functions/_binance-orderbook-fallback.mjs — a best-effort
// Node-side fallback that hits Binance's PUBLIC depth endpoints directly when
// the same-origin /api/orderbook bridge is unavailable. All fetches are
// dependency-injected; no real network call is ever made.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchBinanceDepthSummary } from '../netlify/functions/_binance-orderbook-fallback.mjs';

function depthPayload() {
  return {
    lastUpdateId: 1,
    bids: [['100.00', '2.0'], ['99.90', '1.0']],
    asks: [['100.10', '1.5'], ['100.20', '0.5']],
  };
}

function okFetch(payload = depthPayload()) {
  return async () => ({ ok: true, status: 200, json: async () => payload });
}

test('rejects an invalid pair without calling fetch', async () => {
  let called = false;
  const res = await fetchBinanceDepthSummary({ pair: 'not-valid!!', fetchImpl: async () => { called = true; } });
  assert.deepEqual(res, { ok: false, reason: 'INVALID_ORDERBOOK_PAIR' });
  assert.equal(called, false);
});

test('builds the spot public depth URL with no signature/API key and calls only /api/v3/depth', async () => {
  let capturedUrl = null;
  await fetchBinanceDepthSummary({
    pair: 'btcusdt', market: 'spot',
    fetchImpl: async (u) => { capturedUrl = u; return { ok: true, status: 200, json: async () => depthPayload() }; },
  });
  assert.equal(capturedUrl, 'https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=50');
});

test('builds the futures public depth URL for market:futures and calls only /fapi/v1/depth', async () => {
  let capturedUrl = null;
  await fetchBinanceDepthSummary({
    pair: 'BTCUSDT', market: 'futures',
    fetchImpl: async (u) => { capturedUrl = u; return { ok: true, status: 200, json: async () => depthPayload() }; },
  });
  assert.equal(capturedUrl, 'https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=50');
});

test('unknown market values default to spot', async () => {
  let capturedUrl = null;
  await fetchBinanceDepthSummary({
    pair: 'BTCUSDT', market: 'margin',
    fetchImpl: async (u) => { capturedUrl = u; return { ok: true, status: 200, json: async () => depthPayload() }; },
  });
  assert.match(capturedUrl, /^https:\/\/api\.binance\.com\/api\/v3\/depth/);
});

test('never sends Authorization, API key, or signature headers/params', async () => {
  let capturedUrl = null;
  let capturedInit = null;
  await fetchBinanceDepthSummary({
    pair: 'BTCUSDT',
    fetchImpl: async (u, init) => { capturedUrl = u; capturedInit = init; return { ok: true, status: 200, json: async () => depthPayload() }; },
  });
  assert.equal(capturedUrl.includes('signature'), false);
  assert.equal(capturedUrl.includes('apikey'), false);
  assert.equal(capturedInit.headers.Authorization, undefined);
  assert.equal(capturedInit.headers['X-MBX-APIKEY'], undefined);
});

test('success returns the summarized book shape expected by absorption analysis, tagged source:binance_direct', async () => {
  const res = await fetchBinanceDepthSummary({ pair: 'BTCUSDT', market: 'spot', fetchImpl: okFetch() });
  assert.equal(res.ok, true);
  assert.equal(res.pair, 'BTCUSDT');
  assert.equal(res.market, 'spot');
  assert.equal(res.source, 'binance_direct');
  assert.deepEqual(Object.keys(res.orderbook).sort(), [
    'best_ask', 'best_bid', 'cumulative_ask_qty', 'cumulative_bid_qty', 'imbalance', 'spread_bps',
  ]);
  assert.equal(res.orderbook.best_bid, 100);
  assert.equal(res.orderbook.best_ask, 100.1);
  assert.ok(res.orderbook.imbalance > 0);
  // No raw depth levels or wall detection — intentionally smaller than the
  // edge summarizer's shape (never top5_bids/top5_asks/walls).
  assert.equal('top5_bids' in res.orderbook, false);
  assert.equal('walls' in res.orderbook, false);
});

test('upstream non-2xx maps to a granular ORDERBOOK_BINANCE_HTTP_<status> reason, never the raw body', async () => {
  const res = await fetchBinanceDepthSummary({
    pair: 'BTCUSDT',
    fetchImpl: async () => ({ ok: false, status: 418, json: async () => ({ code: -1003, msg: 'Too many requests; IP banned until 1700000000000.' }) }),
  });
  assert.deepEqual(res, { ok: false, reason: 'ORDERBOOK_BINANCE_HTTP_418', pair: 'BTCUSDT', market: 'spot' });
  assert.equal(JSON.stringify(res).includes('banned'), false);
});

test('a thrown fetch error maps to ORDERBOOK_BINANCE_FETCH_FAILED, never the raw error message', async () => {
  const res = await fetchBinanceDepthSummary({
    pair: 'BTCUSDT',
    fetchImpl: async () => { throw new Error('simulated network detail'); },
  });
  assert.deepEqual(res, { ok: false, reason: 'ORDERBOOK_BINANCE_FETCH_FAILED', pair: 'BTCUSDT', market: 'spot' });
});

// A parse failure and a structurally unusable book are different upstream
// problems and must not collapse into one code.
test('a 2xx body that is not valid JSON maps to ORDERBOOK_BINANCE_PARSE_FAILED', async () => {
  const res = await fetchBinanceDepthSummary({
    pair: 'BTCUSDT',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
  });
  assert.deepEqual(res, { ok: false, reason: 'ORDERBOOK_BINANCE_PARSE_FAILED', pair: 'BTCUSDT', market: 'spot' });
});

test('valid JSON with an empty or malformed book maps to ORDERBOOK_BINANCE_INVALID_PAYLOAD', async () => {
  for (const payload of [{ bids: [], asks: [] }, { bids: 'nope', asks: 'nope' }, {}, { bids: [['1', '1']] }]) {
    const res = await fetchBinanceDepthSummary({
      pair: 'BTCUSDT',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }),
    });
    assert.deepEqual(res, { ok: false, reason: 'ORDERBOOK_BINANCE_INVALID_PAYLOAD', pair: 'BTCUSDT', market: 'spot' });
  }
});

// A timeout (upstream slow) and a transport failure (egress blocked) are
// separately actionable, so they carry separate codes.
test('a slow upstream is aborted after the timeout and reported as ORDERBOOK_BINANCE_TIMEOUT', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const resultPromise = fetchBinanceDepthSummary({
    pair: 'BTCUSDT',
    fetchImpl: (u, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  t.mock.timers.tick(4500);
  const res = await resultPromise;
  assert.deepEqual(res, { ok: false, reason: 'ORDERBOOK_BINANCE_TIMEOUT', pair: 'BTCUSDT', market: 'spot' });
});

// Binance commonly answers a blocked cloud/datacenter egress with a plain
// status rather than a network error — the status must survive, the body
// must not.
test('a geo/rate block status (451/403/418/429) is reported as a status-specific reason with no body', async () => {
  for (const status of [451, 403, 418, 429]) {
    const res = await fetchBinanceDepthSummary({
      pair: 'BTCUSDT',
      fetchImpl: async () => ({ ok: false, status, json: async () => ({ code: -1, msg: 'Service unavailable from a restricted location.' }) }),
    });
    assert.deepEqual(res, { ok: false, reason: `ORDERBOOK_BINANCE_HTTP_${status}`, pair: 'BTCUSDT', market: 'spot' });
    assert.equal(JSON.stringify(res).includes('restricted location'), false);
  }
});
