// Tests for netlify/functions/price-history-collect-scheduled.mjs — the
// external-scheduler-only price-history collector. Same DI pattern as
// tests/admin-price-history-collect.test.mjs: no real auth beyond the
// scheduler secret comparison, no real fetch, no real DB.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runPriceHistoryCollectScheduled,
  isSchedulerAuthenticated,
  PRICE_HISTORY_SCHEDULER_HEADER,
  PRICE_HISTORY_SOURCE,
} from '../netlify/functions/price-history-collect-scheduled.mjs';

const URL = 'https://swingterminalx.netlify.app/api/price-history-collect-scheduled';
const SECRET = 'test-scheduler-secret-value';
const AUTHED_ENV = { PRICE_HISTORY_SCHEDULER_SECRET: SECRET };
const ROWS = [{ symbol: 'BTC', current_price: 65000 }, { symbol: 'ETH', current_price: 3200 }];

// NOTE: deliberately does NOT use a `{ secret = SECRET } = {}` default
// parameter — that collapses an explicitly-passed `{ secret: undefined }`
// back to SECRET (JS default parameters trigger on `undefined` regardless
// of whether the key was present), which would make it impossible to test
// "header omitted entirely". hasOwnProperty distinguishes the two.
function makeReq(method, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const secret = Object.prototype.hasOwnProperty.call(opts, 'secret') ? opts.secret : SECRET;
  if (secret !== undefined) headers[PRICE_HISTORY_SCHEDULER_HEADER] = secret;
  return new Request(URL, { method, headers });
}

function marketOk(rows = ROWS, extra = {}) {
  return async () => ({ ok: true, rows, pagesOk: 4, pagesAttempted: 4, status: 'ok', reason: null, ...extra });
}

function baseDeps(overrides = {}) {
  return {
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true' },
    getLatestSnapshotAt: async () => ({ ok: true, sampledAt: null }),
    fetchCoinGeckoMarketRows: marketOk(),
    writeMarketPriceSnapshot: async () => ({ ok: true, snapshotId: 1, inserted: 2, dropped: 0, duplicates: 0 }),
    now: () => Date.parse('2026-07-21T12:00:00Z'),
    ...overrides,
  };
}

function call(method, deps) {
  return runPriceHistoryCollectScheduled(makeReq(method, { secret: SECRET }), deps);
}

test('OPTIONS preflight returns 204 with POST-only CORS methods', async () => {
  const res = await runPriceHistoryCollectScheduled(makeReq('OPTIONS'), baseDeps());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
});

test('non-POST returns 405 before auth, DB, fetch, or write', async () => {
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    let authCalled = false; let dbCalled = false; let fetchCalled = false;
    const deps = baseDeps({
      isSchedulerAuthenticated: () => { authCalled = true; return true; },
      getLatestSnapshotAt: async () => { dbCalled = true; return { ok: true, sampledAt: null }; },
      fetchCoinGeckoMarketRows: async () => { fetchCalled = true; return { ok: true, rows: [] }; },
    });
    const res = await call(method, deps);
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { ok: false, reason: 'METHOD_NOT_ALLOWED' });
    assert.equal(authCalled, false);
    assert.equal(dbCalled, false);
    assert.equal(fetchCalled, false);
  }
});

test('missing, wrong, or empty scheduler secret fails closed with 401 before any DB/fetch work', async () => {
  for (const secret of [undefined, '', 'wrong-secret']) {
    let dbCalled = false; let fetchCalled = false;
    const deps = baseDeps({
      getLatestSnapshotAt: async () => { dbCalled = true; return { ok: true, sampledAt: null }; },
      fetchCoinGeckoMarketRows: async () => { fetchCalled = true; return { ok: true, rows: [] }; },
    });
    const req = makeReq('POST', { secret });
    const res = await runPriceHistoryCollectScheduled(req, deps);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, reason: 'SCHEDULER_UNAUTHENTICATED' });
    assert.equal(dbCalled, false);
    assert.equal(fetchCalled, false);
  }
});

test('missing PRICE_HISTORY_SCHEDULER_SECRET server-side also fails closed with 401', async () => {
  const deps = baseDeps({ env: { PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true' } });
  const res = await call('POST', deps);
  assert.equal(res.status, 401);
});

test('a request body field (including next_run) is never trusted as authentication', async () => {
  const req = new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ next_run: '2026-07-21T12:05:00Z' }),
  });
  const deps = baseDeps();
  const res = await runPriceHistoryCollectScheduled(req, deps);
  assert.equal(res.status, 401);
});

test('isSchedulerAuthenticated performs a timing-safe comparison and fails closed on any mismatch', () => {
  const env = { PRICE_HISTORY_SCHEDULER_SECRET: 'correct-secret' };
  assert.equal(isSchedulerAuthenticated(makeReq('POST', { secret: 'correct-secret' }), env), true);
  assert.equal(isSchedulerAuthenticated(makeReq('POST', { secret: 'wrong-secret' }), env), false);
  assert.equal(isSchedulerAuthenticated(makeReq('POST', { secret: undefined }), env), false);
  assert.equal(isSchedulerAuthenticated(makeReq('POST', { secret: '' }), env), false);
  assert.equal(isSchedulerAuthenticated(makeReq('POST', { secret: 'correct-secret' }), {}), false);
});

test('SCHEDULE flag disabled returns 200 SCHEDULE_DISABLED without touching DB or CoinGecko', async () => {
  for (const scheduleFlag of [undefined, 'false', '1', 'TRUE']) {
    let dbCalled = false; let fetchCalled = false;
    const env = { ...AUTHED_ENV, PRICE_HISTORY_COLLECT_ENABLED: 'true' };
    if (scheduleFlag !== undefined) env.PRICE_HISTORY_SCHEDULE_ENABLED = scheduleFlag;
    const deps = baseDeps({
      env,
      getLatestSnapshotAt: async () => { dbCalled = true; return { ok: true, sampledAt: null }; },
      fetchCoinGeckoMarketRows: async () => { fetchCalled = true; return { ok: true, rows: [] }; },
    });
    const res = await call('POST', deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, skipped: true, collected: false, reason: 'SCHEDULE_DISABLED', costGuard: 'PRICE_HISTORY_DISABLED' });
    assert.equal(res.headers.get('X-Cost-Guard'), 'engaged');
    assert.equal(res.headers.get('X-DB-Read-Guard'), 'PRICE_HISTORY_DISABLED');
    assert.equal(dbCalled, false);
    assert.equal(fetchCalled, false);
  }
});

test('COLLECT flag disabled returns 200 COLLECT_DISABLED without touching DB or CoinGecko', async () => {
  let dbCalled = false; let fetchCalled = false;
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true' },
    getLatestSnapshotAt: async () => { dbCalled = true; return { ok: true, sampledAt: null }; },
    fetchCoinGeckoMarketRows: async () => { fetchCalled = true; return { ok: true, rows: [] }; },
  });
  const res = await call('POST', deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, skipped: true, collected: false, reason: 'COLLECT_DISABLED', costGuard: 'PRICE_HISTORY_DISABLED' });
  assert.equal(res.headers.get('X-Cost-Guard'), 'engaged');
  assert.equal(res.headers.get('X-DB-Read-Guard'), 'PRICE_HISTORY_DISABLED');
  assert.equal(dbCalled, false);
  assert.equal(fetchCalled, false);
});

test('getLatestSnapshotAt failure (DB unreachable during spacing check) returns 503 and never fetches CoinGecko', async () => {
  let fetchCalled = false;
  const deps = baseDeps({
    getLatestSnapshotAt: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }),
    fetchCoinGeckoMarketRows: async () => { fetchCalled = true; return { ok: true, rows: [] }; },
  });
  const res = await call('POST', deps);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, collected: false, reason: 'DB_UNAVAILABLE' });
  assert.equal(fetchCalled, false);
});

test('a thrown getLatestSnapshotAt also resolves to 503 DB_UNAVAILABLE, never propagating', async () => {
  const deps = baseDeps({ getLatestSnapshotAt: async () => { throw new Error('simulated: postgres://user:pw@host/db'); } });
  const res = await call('POST', deps);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.reason, 'DB_UNAVAILABLE');
});

test('min spacing: a recent last snapshot skips before any CoinGecko fetch', async () => {
  let fetchCalled = false;
  const now = Date.parse('2026-07-21T12:00:00Z');
  const deps = baseDeps({
    now: () => now,
    getLatestSnapshotAt: async () => ({ ok: true, sampledAt: new Date(now - 60_000) }), // 60s ago < default 540s
    fetchCoinGeckoMarketRows: async () => { fetchCalled = true; return { ok: true, rows: [] }; },
  });
  const res = await call('POST', deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, skipped: true, collected: false, reason: 'MIN_SPACING' });
  assert.equal(fetchCalled, false);
});

test('min spacing: a last snapshot older than the window proceeds to fetch', async () => {
  let fetchCalled = false;
  const now = Date.parse('2026-07-21T12:00:00Z');
  const deps = baseDeps({
    now: () => now,
    getLatestSnapshotAt: async () => ({ ok: true, sampledAt: new Date(now - 1000_000) }), // far beyond 540s
    fetchCoinGeckoMarketRows: async () => { fetchCalled = true; return marketOk()(); },
  });
  const res = await call('POST', deps);
  assert.equal(fetchCalled, true);
  assert.equal(res.status, 200);
});

test('min spacing respects a custom PRICE_HISTORY_MIN_SPACING_SEC', async () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_MIN_SPACING_SEC: '30' },
    now: () => now,
    getLatestSnapshotAt: async () => ({ ok: true, sampledAt: new Date(now - 60_000) }), // 60s ago > custom 30s
  });
  let fetchCalled = false;
  deps.fetchCoinGeckoMarketRows = async () => { fetchCalled = true; return marketOk()(); };
  const res = await call('POST', deps);
  assert.equal(fetchCalled, true);
  assert.equal(res.status, 200);
});

test('an invalid PRICE_HISTORY_MIN_SPACING_SEC (including "0") falls back to the safe default, never to zero spacing', async () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  for (const badSpacing of ['0', '-10', 'not-a-number', '']) {
    let fetchCalled = false;
    const deps = baseDeps({
      env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_MIN_SPACING_SEC: badSpacing },
      now: () => now,
      getLatestSnapshotAt: async () => ({ ok: true, sampledAt: new Date(now - 60_000) }), // 60s ago — under the real 540s default
      fetchCoinGeckoMarketRows: async () => { fetchCalled = true; return marketOk()(); },
    });
    const res = await call('POST', deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, skipped: true, collected: false, reason: 'MIN_SPACING' });
    assert.equal(fetchCalled, false, `spacing="${badSpacing}" must not be treated as zero`);
  }
});

test('CoinGecko total failure (MARKET_FETCH_FAILED) returns 502 and never writes', async () => {
  let writeCalled = false;
  const deps = baseDeps({
    fetchCoinGeckoMarketRows: async () => ({ ok: false, reason: 'MARKET_FETCH_FAILED' }),
    writeMarketPriceSnapshot: async () => { writeCalled = true; return { ok: true }; },
  });
  const res = await call('POST', deps);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { ok: false, collected: false, reason: 'MARKET_FETCH_FAILED' });
  assert.equal(writeCalled, false);
});

test('CoinGecko rate-limited failure returns 429 and never writes', async () => {
  let writeCalled = false;
  const deps = baseDeps({
    fetchCoinGeckoMarketRows: async () => ({ ok: false, reason: 'UPSTREAM_RATE_LIMITED' }),
    writeMarketPriceSnapshot: async () => { writeCalled = true; return { ok: true }; },
  });
  const res = await call('POST', deps);
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { ok: false, collected: false, reason: 'UPSTREAM_RATE_LIMITED' });
  assert.equal(writeCalled, false);
});

// C1/C2 fix (defense in depth on the collector side): zero fetched rows
// must never reach the writer, even if the source module mis-reports
// ok:true with an empty rows array. A zero-row snapshot would satisfy the
// min-spacing guard and silently suppress the next real collection.
test('zero fetched rows returns a non-2xx NO_MARKET_ROWS response and never calls the writer', async () => {
  let writeCalled = false;
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_WRITE_ENABLED: 'true' },
    fetchCoinGeckoMarketRows: async () => ({ ok: true, rows: [], pagesOk: 1, pagesAttempted: 1, status: 'ok' }),
    writeMarketPriceSnapshot: async () => { writeCalled = true; return { ok: true, snapshotId: 1, inserted: 0, dropped: 0, duplicates: 0 }; },
  });
  const res = await call('POST', deps);
  assert.notEqual(res.status, 200);
  assert.ok(res.status >= 400 && res.status < 600, `expected a non-2xx status, got ${res.status}`);
  assert.deepEqual(await res.json(), { ok: false, collected: false, reason: 'NO_MARKET_ROWS' });
  assert.equal(writeCalled, false);
});

test('zero fetched rows refuses to write even when the WRITE flag is disabled (fetch-quality problem, not a write-disabled skip)', async () => {
  let writeCalled = false;
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true' }, // WRITE flag absent
    fetchCoinGeckoMarketRows: async () => ({ ok: true, rows: [], pagesOk: 1, pagesAttempted: 1, status: 'ok' }),
    writeMarketPriceSnapshot: async () => { writeCalled = true; return { ok: true }; },
  });
  const res = await call('POST', deps);
  assert.notEqual(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, collected: false, reason: 'NO_MARKET_ROWS' });
  assert.equal(writeCalled, false);
});

test('a non-array rows field from the source module is treated as zero rows and refused', async () => {
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_WRITE_ENABLED: 'true' },
    fetchCoinGeckoMarketRows: async () => ({ ok: true, rows: 'not-an-array', pagesOk: 1, pagesAttempted: 1, status: 'ok' }),
  });
  const res = await call('POST', deps);
  assert.notEqual(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, collected: false, reason: 'NO_MARKET_ROWS' });
});

test('the zero-rows-refused response contains only counts/codes — no rows, no symbols', async () => {
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_WRITE_ENABLED: 'true' },
    fetchCoinGeckoMarketRows: async () => ({ ok: true, rows: [], pagesOk: 1, pagesAttempted: 1, status: 'ok' }),
  });
  const res = await call('POST', deps);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['collected', 'ok', 'reason']);
});

test('a partial CoinGecko fetch still proceeds to write with dataStatus:"partial" and the true row/page counts', async () => {
  let capturedWriteArgs = null;
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_WRITE_ENABLED: 'true' },
    fetchCoinGeckoMarketRows: async () => ({ ok: true, rows: ROWS, pagesOk: 2, pagesAttempted: 4, status: 'partial', reason: 'MARKET_FETCH_FAILED' }),
    writeMarketPriceSnapshot: async (args) => { capturedWriteArgs = args; return { ok: true, snapshotId: 9, inserted: 2, dropped: 0, duplicates: 0 }; },
  });
  const res = await call('POST', deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dataStatus, 'partial');
  assert.equal(body.pagesOk, 2);
  assert.equal(body.pagesAttempted, 4);
  assert.equal(capturedWriteArgs.status, 'partial');
  assert.equal(capturedWriteArgs.metadata.pagesOk, 2);
  assert.equal(capturedWriteArgs.metadata.pagesAttempted, 4);
});

test('WRITE flag disabled still fetches and reports a clean skip, never calling the writer', async () => {
  let writeCalled = false;
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true' }, // WRITE flag absent
    writeMarketPriceSnapshot: async () => { writeCalled = true; return { ok: true, snapshotId: 1, inserted: 2, dropped: 0, duplicates: 0 }; },
  });
  const res = await call('POST', deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.collected, true);
  assert.deepEqual(body.write, { skipped: true, written: false, reason: 'DISABLED' });
  assert.equal(writeCalled, false);
});

test('WRITE enabled + writer success returns 200 with written:true and the writer counts', async () => {
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_WRITE_ENABLED: 'true' },
    writeMarketPriceSnapshot: async () => ({ ok: true, snapshotId: 42, inserted: 2, dropped: 0, duplicates: 0 }),
  });
  const res = await call('POST', deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.write, { skipped: false, written: true, reason: null, snapshotId: 42, inserted: 2, dropped: 0, duplicates: 0 });
});

test('WRITE enabled + writer DB_UNAVAILABLE returns 503, not 200', async () => {
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_WRITE_ENABLED: 'true' },
    writeMarketPriceSnapshot: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }),
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await call('POST', deps);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.collected, true);
  assert.deepEqual(body.write, { skipped: false, written: false, reason: 'DB_UNAVAILABLE' });
});

test('WRITE enabled + an unexpected writer failure reason returns 502, not 200', async () => {
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_WRITE_ENABLED: 'true' },
    writeMarketPriceSnapshot: async () => ({ ok: false, reason: 'INVALID_ROWS' }),
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await call('POST', deps);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('a thrown writer error never propagates and resolves to a non-2xx WRITE_ERROR', async () => {
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_WRITE_ENABLED: 'true' },
    writeMarketPriceSnapshot: async () => { throw new Error('simulated: postgres://user:pw@host/db'); },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await call('POST', deps);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.write.reason, 'WRITE_ERROR');
});

test('writer is called with source scheduled_price_history and storeRawMeta:false by default', async () => {
  let capturedArgs = null;
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_WRITE_ENABLED: 'true' },
    writeMarketPriceSnapshot: async (args) => { capturedArgs = args; return { ok: true, snapshotId: 1, inserted: 2, dropped: 0, duplicates: 0 }; },
  });
  await call('POST', deps);
  assert.equal(capturedArgs.source, PRICE_HISTORY_SOURCE);
  assert.equal(capturedArgs.source, 'scheduled_price_history');
  assert.equal(capturedArgs.storeRawMeta, false);
});

test('PRICE_HISTORY_STORE_RAW_META=true is forwarded to the writer explicitly', async () => {
  let capturedArgs = null;
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_WRITE_ENABLED: 'true', PRICE_HISTORY_STORE_RAW_META: 'true' },
    writeMarketPriceSnapshot: async (args) => { capturedArgs = args; return { ok: true, snapshotId: 1, inserted: 2, dropped: 0, duplicates: 0 }; },
  });
  await call('POST', deps);
  assert.equal(capturedArgs.storeRawMeta, true);
});

test('PRICE_HISTORY_MAX_COINS is forwarded to the CoinGecko fetcher, invalid falls back to default', async () => {
  let capturedMaxCoins = null;
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_MAX_COINS: '500' },
    fetchCoinGeckoMarketRows: async (args) => { capturedMaxCoins = args.maxCoins; return marketOk()(); },
  });
  await call('POST', deps);
  assert.equal(capturedMaxCoins, 500);

  let capturedMaxCoinsInvalid = null;
  const deps2 = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_MAX_COINS: 'not-a-number' },
    fetchCoinGeckoMarketRows: async (args) => { capturedMaxCoinsInvalid = args.maxCoins; return marketOk()(); },
  });
  await call('POST', deps2);
  assert.equal(capturedMaxCoinsInvalid, 1000);
});

test('response never contains a symbol, a row, a secret, or a raw error message', async () => {
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true', PRICE_HISTORY_WRITE_ENABLED: 'true' },
    fetchCoinGeckoMarketRows: async () => ({ ok: true, rows: [{ symbol: 'SUPERSECRETCOIN', current_price: 1 }], pagesOk: 1, pagesAttempted: 1, status: 'ok' }),
    writeMarketPriceSnapshot: async () => ({ ok: true, snapshotId: 1, inserted: 1, dropped: 0, duplicates: 0 }),
  });
  const res = await call('POST', deps);
  const raw = await res.text();
  for (const dangerous of ['supersecretcoin', SECRET.toLowerCase(), 'authorization', 'bearer', 'token', 'password', 'postgres://']) {
    assert.equal(raw.toLowerCase().includes(dangerous), false, `response must not mention "${dangerous}"`);
  }
});

test('module exports the expected constants', () => {
  assert.equal(PRICE_HISTORY_SCHEDULER_HEADER, 'x-price-history-scheduler-secret');
  assert.equal(PRICE_HISTORY_SOURCE, 'scheduled_price_history');
});
