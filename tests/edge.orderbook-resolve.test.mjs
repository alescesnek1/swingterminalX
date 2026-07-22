// Tests for the /api/orderbook Edge function's Binance depth layer:
// classifyDepthFailure, fetchOrderbook (typed errors), and resolveOrderbook
// (bounded spot<->futures fallback + honest not-listed vs upstream-failure).
//
// Root cause these lock in (proven in production 2026-07-22): BTCUSDT/ETHUSDT
// return real books from the Edge function on BOTH markets (so it is NOT an
// egress/infra failure), while:
//   • LITUSDT spot -> empty book, LITUSDT futures -> real book  (market pick)
//   • ANSEMUSDT spot AND futures -> HTTP 400 -1121 Invalid symbol (not listed)
// The single-market path reported both as a generic 502 "Order book upstream
// failed", hiding a usable futures book and mislabeling a not-listed coin as
// an outage.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDepthFailure,
  fetchOrderbook,
  resolveOrderbook,
} from '../apps/edge/netlify/edge-functions/lib/binance.js';

const VALID_DEPTH = { bids: [['100.0', '2.0'], ['99.5', '1.0']], asks: [['100.5', '2.0'], ['101.0', '1.0']] };
const EMPTY_DEPTH = { bids: [], asks: [] };
const INVALID_SYMBOL_BODY = '{"code":-1121,"msg":"Invalid symbol."}';

// Build a fake fetch that answers per-market. `spot` / `futures` each:
//   { ok, status, json }  -> a 2xx depth payload, or
//   { status, text }      -> a non-2xx that fetchJson turns into a thrown Error
function fakeFetch({ spot, futures }) {
  return async (url) => {
    const u = String(url);
    const which = u.includes('fapi.binance.com') ? futures : spot;
    if (!which) throw new Error('unexpected fetch: ' + u);
    const ok = which.status >= 200 && which.status < 300;
    return {
      ok,
      status: which.status,
      json: async () => which.json,
      text: async () => (which.text != null ? which.text : JSON.stringify(which.json ?? {})),
    };
  };
}

async function withFetch(routes, fn) {
  const original = global.fetch;
  global.fetch = fakeFetch(routes);
  try { return await fn(); } finally { global.fetch = original; }
}

// ── classifyDepthFailure ─────────────────────────────────────
test('classifyDepthFailure: 400 -1121 invalid symbol => INVALID_SYMBOL', () => {
  assert.equal(classifyDepthFailure('spot-depth/ANSEMUSDT HTTP 400: ' + INVALID_SYMBOL_BODY), 'INVALID_SYMBOL');
  assert.equal(classifyDepthFailure('futures-depth/ANSEMUSDT HTTP 400: {"msg":"Invalid symbol."}'), 'INVALID_SYMBOL');
});

test('classifyDepthFailure: 451/5xx/timeout/rate-limit => UPSTREAM_ERROR', () => {
  assert.equal(classifyDepthFailure('spot-depth/X HTTP 451: blocked'), 'UPSTREAM_ERROR');
  assert.equal(classifyDepthFailure('spot-depth/X HTTP 500: err'), 'UPSTREAM_ERROR');
  assert.equal(classifyDepthFailure('spot-depth/X HTTP 418: rate'), 'UPSTREAM_ERROR');
  assert.equal(classifyDepthFailure('The operation was aborted'), 'UPSTREAM_ERROR');
  // A 400 that is NOT an invalid-symbol code must not be mistaken for "not listed".
  assert.equal(classifyDepthFailure('spot-depth/X HTTP 400: {"code":-1100,"msg":"Illegal chars"}'), 'UPSTREAM_ERROR');
});

// ── fetchOrderbook typed errors ──────────────────────────────
test('fetchOrderbook: success returns a summarized book', async () => {
  await withFetch({ spot: { status: 200, json: VALID_DEPTH } }, async () => {
    const book = await fetchOrderbook({ pair: 'BTCUSDT', market: 'spot' });
    assert.equal(book.best_bid, 100);
    assert.equal(book.best_ask, 100.5);
  });
});

test('fetchOrderbook: invalid symbol throws kind INVALID_SYMBOL', async () => {
  await withFetch({ spot: { status: 400, text: INVALID_SYMBOL_BODY } }, async () => {
    await assert.rejects(() => fetchOrderbook({ pair: 'ANSEMUSDT', market: 'spot' }), (e) => e.kind === 'INVALID_SYMBOL');
  });
});

test('fetchOrderbook: empty book throws kind EMPTY_BOOK', async () => {
  await withFetch({ spot: { status: 200, json: EMPTY_DEPTH } }, async () => {
    await assert.rejects(() => fetchOrderbook({ pair: 'LITUSDT', market: 'spot' }), (e) => e.kind === 'EMPTY_BOOK');
  });
});

test('fetchOrderbook: 451 geo-block throws kind UPSTREAM_ERROR', async () => {
  await withFetch({ spot: { status: 451, text: 'Unavailable For Legal Reasons' } }, async () => {
    await assert.rejects(() => fetchOrderbook({ pair: 'BTCUSDT', market: 'spot' }), (e) => e.kind === 'UPSTREAM_ERROR');
  });
});

// ── resolveOrderbook: fallback + honesty ─────────────────────
test('resolveOrderbook: spot works => no fallback', async () => {
  await withFetch({ spot: { status: 200, json: VALID_DEPTH } }, async () => {
    const r = await resolveOrderbook({ pair: 'BTCUSDT', market: 'spot' });
    assert.equal(r.market, 'spot');
    assert.equal(r.fallback, false);
    assert.equal(r.book.best_bid, 100);
  });
});

test('resolveOrderbook: empty spot book falls back to futures (the LITUSDT case)', async () => {
  await withFetch({ spot: { status: 200, json: EMPTY_DEPTH }, futures: { status: 200, json: VALID_DEPTH } }, async () => {
    const r = await resolveOrderbook({ pair: 'LITUSDT', market: 'spot' });
    assert.equal(r.market, 'futures');
    assert.equal(r.fallback, true);
    assert.equal(r.book.best_bid, 100);
  });
});

test('resolveOrderbook: invalid spot symbol falls back to futures', async () => {
  await withFetch({ spot: { status: 400, text: INVALID_SYMBOL_BODY }, futures: { status: 200, json: VALID_DEPTH } }, async () => {
    const r = await resolveOrderbook({ pair: 'SOMEPERP', market: 'spot' });
    assert.equal(r.market, 'futures');
    assert.equal(r.fallback, true);
  });
});

test('resolveOrderbook: not on either market => SYMBOL_NOT_ON_BINANCE (the ANSEMUSDT case)', async () => {
  await withFetch({ spot: { status: 400, text: INVALID_SYMBOL_BODY }, futures: { status: 400, text: INVALID_SYMBOL_BODY } }, async () => {
    await assert.rejects(() => resolveOrderbook({ pair: 'ANSEMUSDT', market: 'spot' }), (e) => e.kind === 'SYMBOL_NOT_ON_BINANCE');
  });
});

test('resolveOrderbook: real upstream failure is NOT masked by a fallback', async () => {
  // Spot 451: a genuine infra/geo failure must surface as-is and must NOT
  // trigger a futures hammer that could hide the outage as a missing symbol.
  const original = global.fetch;
  let futuresCalled = false;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('fapi.binance.com')) { futuresCalled = true; return { ok: true, status: 200, json: async () => VALID_DEPTH, text: async () => JSON.stringify(VALID_DEPTH) }; }
    return { ok: false, status: 451, json: async () => ({}), text: async () => 'Unavailable For Legal Reasons' };
  };
  try {
    await assert.rejects(() => resolveOrderbook({ pair: 'BTCUSDT', market: 'spot' }), (e) => e.kind === 'UPSTREAM_ERROR');
  } finally {
    global.fetch = original;
  }
  assert.equal(futuresCalled, false, 'must not fall back on a real upstream failure');
});

test('resolveOrderbook: fallback venue upstream error surfaces honestly (not "not listed")', async () => {
  await withFetch({ spot: { status: 200, json: EMPTY_DEPTH }, futures: { status: 500, text: 'boom' } }, async () => {
    await assert.rejects(() => resolveOrderbook({ pair: 'LITUSDT', market: 'spot' }), (e) => e.kind === 'UPSTREAM_ERROR');
  });
});

test('resolveOrderbook: requested futures works with no fallback', async () => {
  await withFetch({ futures: { status: 200, json: VALID_DEPTH } }, async () => {
    const r = await resolveOrderbook({ pair: 'BTCUSDT', market: 'futures' });
    assert.equal(r.market, 'futures');
    assert.equal(r.fallback, false);
  });
});

test('resolveOrderbook: futures-only request missing there falls back to spot', async () => {
  await withFetch({ futures: { status: 400, text: INVALID_SYMBOL_BODY }, spot: { status: 200, json: VALID_DEPTH } }, async () => {
    const r = await resolveOrderbook({ pair: 'BTCUSDT', market: 'futures' });
    assert.equal(r.market, 'spot');
    assert.equal(r.fallback, true);
  });
});
