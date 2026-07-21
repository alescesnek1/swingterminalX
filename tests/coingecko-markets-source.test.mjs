// Tests for netlify/functions/_coingecko-markets-source.mjs — the public,
// unauthenticated CoinGecko /coins/markets fetcher used by the scheduled
// price-history collector. Every test injects fetchImpl; no real network
// call is ever made.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchCoinGeckoMarketRows,
  DEFAULT_MAX_COINS,
  ABSOLUTE_MAX_COINS,
} from '../netlify/functions/_coingecko-markets-source.mjs';

function pageOf(url) {
  const match = /[?&]page=(\d+)/.exec(url);
  return match ? Number(match[1]) : null;
}

function makeRows(count, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `coin-${offset + i}`,
    symbol: `sym${offset + i}`,
    name: `Coin ${offset + i}`,
    current_price: 1 + i,
    price_change_percentage_24h: 0.1,
    total_volume: 1000,
    market_cap: 10000,
    market_cap_rank: offset + i + 1,
  }));
}

// pageSpec: { [pageNumber]: { rows } | { status } | { throws } | { badJson } }
function fakeFetch(pageSpec) {
  return async (url) => {
    const page = pageOf(url);
    const spec = pageSpec[page];
    if (!spec) return { ok: true, status: 200, json: async () => [] };
    if (spec.throws) throw new Error('simulated network failure');
    if (spec.status) return { ok: false, status: spec.status, json: async () => ({}) };
    if (spec.badJson) return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } };
    return { ok: true, status: 200, json: async () => spec.rows };
  };
}

test('module exports the expected function and constants', () => {
  assert.equal(typeof fetchCoinGeckoMarketRows, 'function');
  assert.equal(DEFAULT_MAX_COINS, 1000);
  assert.equal(ABSOLUTE_MAX_COINS, 2000);
});

test('falls back to globalThis.fetch when fetchImpl is not provided', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => [] }; };
  try {
    const res = await fetchCoinGeckoMarketRows({ maxCoins: 10 });
    assert.equal(called, true);
    assert.equal(res.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('never throws when fetchImpl is not a function and there is no usable global fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = 'not-a-function';
  try {
    const res = await fetchCoinGeckoMarketRows({ maxCoins: 10, fetchImpl: 'also-not-a-function' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'MARKET_FETCH_FAILED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('default maxCoins fetches across 4 pages of 250 to reach 1000 rows', async () => {
  const spec = {
    1: { rows: makeRows(250, 0) },
    2: { rows: makeRows(250, 250) },
    3: { rows: makeRows(250, 500) },
    4: { rows: makeRows(250, 750) },
  };
  const res = await fetchCoinGeckoMarketRows({ fetchImpl: fakeFetch(spec) });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'ok');
  assert.equal(res.pagesOk, 4);
  assert.equal(res.pagesAttempted, 4);
  assert.equal(res.rows.length, 1000);
  assert.equal(res.reason, null);
});

test('a short page (fewer than 250 rows) stops further page fetches — natural end of data', async () => {
  let page3Called = false;
  const spec = {
    1: { rows: makeRows(250, 0) },
    2: { rows: makeRows(100, 250) },
  };
  const fetchImpl = async (url) => {
    if (pageOf(url) === 3) page3Called = true;
    return fakeFetch(spec)(url);
  };
  const res = await fetchCoinGeckoMarketRows({ maxCoins: 1000, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 350);
  assert.equal(res.pagesAttempted, 2);
  assert.equal(page3Called, false);
});

test('an empty-but-ok page counts as a successful fetch and stops pagination', async () => {
  const spec = { 1: { rows: [] } };
  const res = await fetchCoinGeckoMarketRows({ maxCoins: 1000, fetchImpl: fakeFetch(spec) });
  assert.equal(res.ok, true);
  assert.equal(res.pagesOk, 1);
  assert.equal(res.rows.length, 0);
});

test('maxCoins caps the row count and the number of pages fetched', async () => {
  let maxPageSeen = 0;
  const spec = {
    1: { rows: makeRows(250, 0) },
    2: { rows: makeRows(250, 250) },
  };
  const fetchImpl = async (url) => {
    const p = pageOf(url);
    if (p > maxPageSeen) maxPageSeen = p;
    return fakeFetch(spec)(url);
  };
  const res = await fetchCoinGeckoMarketRows({ maxCoins: 300, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 300);
  assert.equal(maxPageSeen, 2);
});

test('invalid/missing maxCoins falls back to DEFAULT_MAX_COINS worth of pages', async () => {
  const spec = {
    1: { rows: makeRows(250, 0) },
    2: { rows: makeRows(250, 250) },
    3: { rows: makeRows(250, 500) },
    4: { rows: makeRows(250, 750) },
    5: { rows: makeRows(250, 1000) },
  };
  for (const bad of [undefined, null, 0, -5, 'not-a-number', NaN]) {
    let page5Called = false;
    const fetchImpl = async (url) => {
      if (pageOf(url) === 5) page5Called = true;
      return fakeFetch(spec)(url);
    };
    const res = await fetchCoinGeckoMarketRows({ maxCoins: bad, fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(res.rows.length, 1000, `maxCoins=${bad} should fall back to 1000`);
    assert.equal(page5Called, false);
  }
});

test('maxCoins is clamped to ABSOLUTE_MAX_COINS even when explicitly larger', async () => {
  let pagesAttempted = 0;
  const fetchImpl = async (url) => {
    pagesAttempted += 1;
    return { ok: true, status: 200, json: async () => makeRows(250, (pageOf(url) - 1) * 250) };
  };
  const res = await fetchCoinGeckoMarketRows({ maxCoins: 999999, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, ABSOLUTE_MAX_COINS);
  assert.ok(pagesAttempted <= Math.ceil(ABSOLUTE_MAX_COINS / 250));
});

test('all pages failing (non-429) returns ok:false MARKET_FETCH_FAILED with zero rows', async () => {
  const spec = {
    1: { status: 500 },
    2: { status: 500 },
    3: { status: 500 },
    4: { status: 500 },
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await fetchCoinGeckoMarketRows({ fetchImpl: fakeFetch(spec) });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(res, {
    ok: false, rows: [], pagesOk: 0, pagesAttempted: 4, status: 'failed', reason: 'MARKET_FETCH_FAILED',
  });
});

test('a 429 on the first page returns ok:false UPSTREAM_RATE_LIMITED and attempts no further pages', async () => {
  let attempts = 0;
  const fetchImpl = async () => { attempts += 1; return { ok: false, status: 429, json: async () => ({}) }; };
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await fetchCoinGeckoMarketRows({ fetchImpl });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'UPSTREAM_RATE_LIMITED');
  assert.equal(res.pagesOk, 0);
  assert.equal(attempts, 1);
});

test('a 429 after some successful pages returns ok:true, status partial, reason UPSTREAM_RATE_LIMITED, and stops', async () => {
  let page3Attempted = false;
  const spec = {
    1: { rows: makeRows(250, 0) },
    2: { rows: makeRows(250, 250) },
  };
  const fetchImpl = async (url) => {
    const p = pageOf(url);
    if (p === 3) { page3Attempted = true; return { ok: false, status: 429, json: async () => ({}) }; }
    return fakeFetch(spec)(url);
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await fetchCoinGeckoMarketRows({ maxCoins: 1000, fetchImpl });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.ok, true);
  assert.equal(res.status, 'partial');
  assert.equal(res.reason, 'UPSTREAM_RATE_LIMITED');
  assert.equal(res.rows.length, 500);
  assert.equal(res.pagesOk, 2);
  assert.equal(res.pagesAttempted, 3);
  assert.equal(page3Attempted, true);
});

test('1-3 failing pages amid otherwise-ok pages yields ok:true, partial rows, accurate pagesOk/pagesAttempted', async () => {
  const spec = {
    1: { rows: makeRows(250, 0) },
    2: { status: 500 },
    3: { rows: makeRows(250, 250) },
    4: { status: 500 },
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await fetchCoinGeckoMarketRows({ maxCoins: 1000, fetchImpl: fakeFetch(spec) });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.ok, true);
  assert.equal(res.status, 'partial');
  assert.equal(res.pagesOk, 2);
  assert.equal(res.pagesAttempted, 4);
  assert.equal(res.rows.length, 500);
});

test('a thrown fetch error on one page does not abort the whole fetch — later pages still counted', async () => {
  const spec = {
    1: { throws: true },
    2: { rows: makeRows(250, 250) },
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await fetchCoinGeckoMarketRows({ maxCoins: 500, fetchImpl: fakeFetch(spec) });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.ok, true);
  assert.equal(res.status, 'partial');
  assert.equal(res.pagesOk, 1);
  assert.equal(res.rows.length, 250);
});

test('a response.json() parse failure is treated as a page failure, not a thrown exception', async () => {
  const spec = { 1: { badJson: true }, 2: { rows: makeRows(10, 0) } };
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await fetchCoinGeckoMarketRows({ maxCoins: 500, fetchImpl: fakeFetch(spec) });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.ok, true);
  assert.equal(res.status, 'partial');
  assert.equal(res.rows.length, 10);
});

test('a non-array JSON body is treated as an empty page, never throws', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ not: 'an array' }) });
  const res = await fetchCoinGeckoMarketRows({ maxCoins: 500, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 0);
});

test('failure logs never include the raw upstream response body', async () => {
  const calls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { calls.push(args); };
  try {
    await fetchCoinGeckoMarketRows({ fetchImpl: fakeFetch({ 1: { status: 500 }, 2: { status: 500 }, 3: { status: 500 }, 4: { status: 500 } }) });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(calls.length > 0);
  const serialized = JSON.stringify(calls);
  assert.equal(serialized.includes('coin-'), false);
  assert.equal(serialized.toLowerCase().includes('token'), false);
  assert.equal(serialized.toLowerCase().includes('authorization'), false);
});

test('rows returned are exactly what CoinGecko sent — no reshaping of field names here', async () => {
  const spec = { 1: { rows: [{ symbol: 'btc', current_price: 65000.5, price_change_percentage_24h: 1.2, total_volume: 111, market_cap: 222, market_cap_rank: 1, name: 'Bitcoin' }] } };
  const res = await fetchCoinGeckoMarketRows({ maxCoins: 10, fetchImpl: fakeFetch(spec) });
  assert.equal(res.ok, true);
  assert.deepEqual(res.rows[0], {
    symbol: 'btc', current_price: 65000.5, price_change_percentage_24h: 1.2,
    total_volume: 111, market_cap: 222, market_cap_rank: 1, name: 'Bitcoin',
  });
});

test('fetchImpl is called with a public GET-shaped request — no auth/cookie headers', async () => {
  let capturedInit = null;
  const fetchImpl = async (url, init) => { capturedInit = init; return { ok: true, status: 200, json: async () => [] }; };
  await fetchCoinGeckoMarketRows({ maxCoins: 10, fetchImpl });
  assert.ok(capturedInit);
  assert.equal('authorization' in (capturedInit.headers || {}), false);
  assert.equal('Authorization' in (capturedInit.headers || {}), false);
  assert.equal('cookie' in (capturedInit.headers || {}), false);
});
