// Tests for netlify/functions/admin-price-history-collect.mjs.
//
// Same DI pattern as tests/admin-price-history.test.mjs — no real auth,
// fetch, or DB. PRICE_HISTORY_COLLECT_ENABLED is passed via deps.env so the
// real process.env is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runAdminPriceHistoryCollect } from '../netlify/functions/admin-price-history-collect.mjs';

const URL = 'https://swingterminalx.netlify.app/api/admin-price-history-collect';

const ADMIN = { ok: true, verified: true, userId: 'admin-uuid-0001', email: 'admin@example.com' };
const ADMIN_UNVERIFIED = { ok: true, verified: false, userId: 'admin-uuid-0001', email: 'admin@example.com' };
const NON_ADMIN = { ok: true, verified: true, userId: 'user-uuid-0002', email: 'user@example.com' };
const ANON = { ok: false, reason: 'No bearer token' };
const ENABLED = { PRICE_HISTORY_COLLECT_ENABLED: 'true' };

const MARKET_ROWS = [{ symbol: 'BTC', price: 65000 }, { symbol: 'ETH', price: 3200 }];

function fakeFetch(rows = MARKET_ROWS, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => rows });
}

function makeReq(method) {
  return new Request(URL, { method });
}

function call(method, {
  identity = ADMIN, env, fetchImpl, writeMarketSnapshotIfEnabled,
  getIdentity, isAdmin, loadAuth, loadWriter, injectAuth = true,
} = {}) {
  const deps = {};
  if (getIdentity) deps.getIdentity = getIdentity;
  else if (injectAuth) deps.getIdentity = async () => identity;
  if (isAdmin) deps.isAdmin = isAdmin;
  else if (injectAuth) deps.isAdmin = (id) => id === ADMIN || id === ADMIN_UNVERIFIED;
  if (loadAuth) deps.loadAuth = loadAuth;
  if (loadWriter) deps.loadWriter = loadWriter;
  if (env) deps.env = env;
  if (fetchImpl) deps.fetchImpl = fetchImpl;
  if (writeMarketSnapshotIfEnabled) deps.writeMarketSnapshotIfEnabled = writeMarketSnapshotIfEnabled;
  return runAdminPriceHistoryCollect(makeReq(method), deps);
}

test('OPTIONS preflight returns 204 with POST-only CORS methods', async () => {
  const res = await call('OPTIONS');
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
});

test('non-POST returns 405 before auth, fetch, or write', async () => {
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    let authCalled = false; let fetchCalled = false; let writeCalled = false;
    const res = await call(method, {
      env: ENABLED,
      getIdentity: async () => { authCalled = true; return ADMIN; },
      fetchImpl: async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => MARKET_ROWS }; },
      writeMarketSnapshotIfEnabled: async () => { writeCalled = true; return { ok: true, skipped: false, written: true }; },
    });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { ok: false, reason: 'METHOD_NOT_ALLOWED' });
    assert.equal(authCalled, false);
    assert.equal(fetchCalled, false);
    assert.equal(writeCalled, false);
  }
});

test('unauthenticated, non-admin, and unverified-admin requests fail closed', async () => {
  assert.equal((await call('POST', { identity: ANON })).status, 401);
  assert.equal((await call('POST', { identity: null })).status, 401);
  assert.equal((await call('POST', { identity: NON_ADMIN })).status, 403);
  assert.equal((await call('POST', { identity: ADMIN_UNVERIFIED })).status, 403);
});

test('collect flag absent or false skips fetch and writer entirely', async () => {
  for (const env of [undefined, {}, { PRICE_HISTORY_COLLECT_ENABLED: 'false' }]) {
    let fetchCalled = false; let writeCalled = false;
    const res = await call('POST', {
      env,
      fetchImpl: async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => MARKET_ROWS }; },
      writeMarketSnapshotIfEnabled: async () => { writeCalled = true; return { ok: true, skipped: false, written: true }; },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, collected: false, skipped: true, reason: 'COLLECT_DISABLED' });
    assert.equal(fetchCalled, false);
    assert.equal(writeCalled, false);
  }
});

test('collect enabled and market fetch fails returns a stable safe error', async () => {
  const res = await call('POST', { env: ENABLED, fetchImpl: async () => { throw new Error('simulated network detail'); } });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, collected: false, reason: 'MARKET_FETCH_FAILED' });
  assert.equal(JSON.stringify(body).includes('simulated network detail'), false);
});

test('collect enabled and non-ok market response returns a stable safe error', async () => {
  const res = await call('POST', { env: ENABLED, fetchImpl: fakeFetch([], { ok: false, status: 500 }) });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { ok: false, collected: false, reason: 'MARKET_FETCH_FAILED' });
});

test('collect enabled and empty rows returns NO_MARKET_ROWS without calling the writer', async () => {
  for (const payload of [[], { rows: [] }, { coins: [] }, {}]) {
    let writeCalled = false;
    const res = await call('POST', {
      env: ENABLED,
      fetchImpl: fakeFetch(payload),
      writeMarketSnapshotIfEnabled: async () => { writeCalled = true; return { ok: true, skipped: false, written: true }; },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, collected: false, reason: 'NO_MARKET_ROWS' });
    assert.equal(writeCalled, false);
  }
});

test('collect enabled accepts array, rows, coins, data, and markets response shapes', async () => {
  for (const payload of [MARKET_ROWS, { rows: MARKET_ROWS }, { coins: MARKET_ROWS }, { data: MARKET_ROWS }, { markets: MARKET_ROWS }]) {
    let capturedRows = null;
    const res = await call('POST', {
      env: ENABLED,
      fetchImpl: fakeFetch(payload),
      writeMarketSnapshotIfEnabled: async (input) => { capturedRows = input.rows; return { ok: true, skipped: false, written: true }; },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(capturedRows, MARKET_ROWS);
    const body = await res.json();
    assert.equal(body.collected, true);
    assert.equal(body.rowsFetched, MARKET_ROWS.length);
  }
});

test('collect enabled with write disabled still fetches rows and returns the writer skip result safely', async () => {
  const res = await call('POST', {
    env: ENABLED,
    fetchImpl: fakeFetch(),
    writeMarketSnapshotIfEnabled: async () => ({ ok: true, skipped: true, reason: 'DISABLED' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    ok: true,
    collected: true,
    rowsFetched: MARKET_ROWS.length,
    write: { skipped: true, written: false, reason: 'DISABLED' },
  });
});

test('collect enabled with a mocked writer success reports collected:true and written:true', async () => {
  const res = await call('POST', {
    env: ENABLED,
    fetchImpl: fakeFetch(),
    writeMarketSnapshotIfEnabled: async () => ({ ok: true, skipped: false, written: true, snapshotId: 7, inserted: 2, dropped: 0, duplicates: 0 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.collected, true);
  assert.deepEqual(body.write, { skipped: false, written: true, reason: null });
});

test('response never contains the raw market payload or a secret-shaped key', async () => {
  const res = await call('POST', {
    env: ENABLED,
    fetchImpl: fakeFetch([{ symbol: 'BTC', price: 65000, apiKey: 'super-secret-value', authorization: 'Bearer abc' }]),
    writeMarketSnapshotIfEnabled: async () => ({ ok: true, skipped: false, written: true }),
  });
  const raw = await res.text();
  for (const dangerous of ['super-secret-value', 'apikey', 'authorization', 'bearer', 'token', 'password', 'db_url']) {
    assert.equal(raw.toLowerCase().includes(dangerous), false, `response must not mention "${dangerous}"`);
  }
});

test('collect enabled builds the markets URL from trusted origin only, forwarding no query string', async () => {
  let capturedUrl = null;
  const req = new Request(`${URL}?foo=bar&token=leak`, { method: 'POST' });
  const res = await runAdminPriceHistoryCollect(req, {
    getIdentity: async () => ADMIN,
    isAdmin: () => true,
    env: ENABLED,
    fetchImpl: async (u) => { capturedUrl = u; return { ok: true, status: 200, json: async () => MARKET_ROWS }; },
    writeMarketSnapshotIfEnabled: async () => ({ ok: true, skipped: false, written: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(capturedUrl, 'https://swingterminalx.netlify.app/api/markets');
});

// /api/markets enforces checkOrigin() then verifyAuth() (Deno Edge Function,
// apps/edge/netlify/edge-functions/lib/security.js) — the same-origin bridge
// must forward Origin or every call is rejected before auth is even checked.
// It must also forward the incoming admin Authorization so verifyAuth can
// succeed, while never forwarding cookies or any other incoming header.
test('collect forwards only Authorization, Origin, and Accept to /api/markets — no cookies or arbitrary headers', async () => {
  let capturedHeaders = null;
  const req = new Request(URL, {
    method: 'POST',
    headers: {
      authorization: 'Bearer super-secret-admin-token',
      cookie: 'session=abc',
      'x-forwarded-for': '1.2.3.4',
    },
  });
  const res = await runAdminPriceHistoryCollect(req, {
    getIdentity: async () => ADMIN,
    isAdmin: () => true,
    env: ENABLED,
    fetchImpl: async (u, init) => { capturedHeaders = init && init.headers; return { ok: true, status: 200, json: async () => MARKET_ROWS }; },
    writeMarketSnapshotIfEnabled: async () => ({ ok: true, skipped: false, written: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(capturedHeaders.Authorization, 'Bearer super-secret-admin-token');
  assert.equal(capturedHeaders.Origin, 'https://swingterminalx.netlify.app');
  assert.equal(capturedHeaders.Accept, 'application/json');
  assert.equal(capturedHeaders.cookie, undefined);
  assert.equal(capturedHeaders.Cookie, undefined);
  assert.equal(capturedHeaders['x-forwarded-for'], undefined);
  assert.equal(Object.keys(capturedHeaders).length, 3);
});

test('collect without an incoming Authorization header still fetches with Origin and Accept only', async () => {
  let capturedHeaders = null;
  const req = new Request(URL, { method: 'POST' });
  const res = await runAdminPriceHistoryCollect(req, {
    getIdentity: async () => ADMIN,
    isAdmin: () => true,
    env: ENABLED,
    fetchImpl: async (u, init) => { capturedHeaders = init && init.headers; return { ok: true, status: 200, json: async () => MARKET_ROWS }; },
    writeMarketSnapshotIfEnabled: async () => ({ ok: true, skipped: false, written: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(capturedHeaders.Authorization, undefined);
  assert.equal(capturedHeaders.Origin, 'https://swingterminalx.netlify.app');
  assert.equal(capturedHeaders.Accept, 'application/json');
});

test('response never echoes the incoming Authorization header value', async () => {
  const req = new Request(URL, {
    method: 'POST',
    headers: { authorization: 'Bearer super-secret-admin-token' },
  });
  const res = await runAdminPriceHistoryCollect(req, {
    getIdentity: async () => ADMIN,
    isAdmin: () => true,
    env: ENABLED,
    fetchImpl: fakeFetch(),
    writeMarketSnapshotIfEnabled: async () => ({ ok: true, skipped: false, written: true }),
  });
  const raw = await res.text();
  assert.equal(raw.includes('super-secret-admin-token'), false);
});
