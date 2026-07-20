// Tests for netlify/functions/admin-price-history.mjs.
//
// The handler supports dependency injection (getIdentity / isAdmin /
// reads), same pattern as tests/admin-observability.test.mjs — these tests
// never touch a real DB or real auth, injecting a fake verified-admin
// identity and fake read functions with canned, already-safe data.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runAdminPriceHistory } from '../netlify/functions/admin-price-history.mjs';

const URL = 'https://swingterminalx.netlify.app/api/admin-price-history';

const ADMIN = { ok: true, verified: true, userId: 'admin-uuid-0001', email: 'admin@example.com' };
const ADMIN_UNVERIFIED = { ok: true, verified: false, userId: 'admin-uuid-0001', email: 'admin@example.com' };
const NON_ADMIN = { ok: true, verified: true, userId: 'user-uuid-0002', email: 'user@example.com' };
const ANON = { ok: false, reason: 'No bearer token' };

const FAKE_SNAPSHOTS = { ok: true, snapshots: [{ id: 1, source: 'test', sampled_at: '2026-07-20T00:00:00.000Z', coin_count: 2, status: 'ok', metadata: {}, created_at: '2026-07-20T00:00:00.000Z' }] };
const FAKE_POINTS = { ok: true, points: [{ id: 1, snapshot_id: 1, symbol: 'BTC', name: 'Bitcoin', price_usd: 65000, change_1h_pct: null, change_24h_pct: 1.1, change_7d_pct: null, volume_24h_usd: null, market_cap_usd: null, rank: 1, source: 'test', sampled_at: '2026-07-20T00:00:00.000Z' }] };

function fakeReads(overrides = {}) {
  return {
    listRecentSnapshots: async () => FAKE_SNAPSHOTS,
    listRecentPricePoints: async () => FAKE_POINTS,
    ...overrides,
  };
}

function makeReq(method, { origin, query } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  const url = query ? `${URL}?${query}` : URL;
  return new Request(url, { method, headers });
}

function call(method, {
  identity = ADMIN, origin, query, reads, getIdentity, isAdmin, loadAuth, loadPriceHistory,
  injectAuth = true, injectReads = true,
} = {}) {
  const deps = {};
  if (getIdentity) deps.getIdentity = getIdentity;
  else if (injectAuth) deps.getIdentity = async () => identity;
  if (isAdmin) deps.isAdmin = isAdmin;
  else if (injectAuth) deps.isAdmin = (id) => id === ADMIN || id === ADMIN_UNVERIFIED;
  if (reads) deps.reads = reads;
  else if (injectReads) deps.reads = fakeReads();
  if (loadAuth) deps.loadAuth = loadAuth;
  if (loadPriceHistory) deps.loadPriceHistory = loadPriceHistory;
  return runAdminPriceHistory(makeReq(method, { origin, query }), deps);
}

test('handler module imports without Netlify auth or database context', () => {
  assert.equal(typeof runAdminPriceHistory, 'function');
});

test('OPTIONS preflight returns 204 with GET-only CORS methods', async () => {
  const res = await call('OPTIONS', { origin: 'https://swingterminalx.netlify.app' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
});

test('unauthenticated GET is rejected with 401', async () => {
  const res = await call('GET', { identity: ANON });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('null identity is rejected with 401', async () => {
  const res = await call('GET', { identity: null });
  assert.equal(res.status, 401);
});

test('thrown identity parsing error returns a safe 401 without leaking the error', async () => {
  const res = await call('GET', {
    getIdentity: async () => { throw new Error('simulated auth parser failure with sensitive-looking text'); },
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, reason: 'UNAUTHENTICATED' });
  assert.equal(JSON.stringify(body).includes('simulated auth parser failure'), false);
});

test('authenticated non-admin GET is rejected with 403', async () => {
  const res = await call('GET', { identity: NON_ADMIN });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('admin identity that is not cryptographically verified is rejected with 403', async () => {
  const res = await call('GET', { identity: ADMIN_UNVERIFIED });
  assert.equal(res.status, 403);
});

test('POST/PUT/PATCH/DELETE return 405 without calling auth or DB — no production POST path exists', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    let authCalled = false;
    let dbCalled = false;
    const res = await call(method, {
      getIdentity: async () => { authCalled = true; throw new Error('must not run'); },
      reads: fakeReads({ listRecentSnapshots: async () => { dbCalled = true; return FAKE_SNAPSHOTS; } }),
    });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { ok: false, reason: 'METHOD_NOT_ALLOWED' });
    assert.equal(authCalled, false);
    assert.equal(dbCalled, false);
  }
});

test('unsupported methods do not load auth or price-history modules', async () => {
  let authLoaded = false;
  let priceHistoryLoaded = false;
  const res = await call('POST', {
    injectAuth: false,
    injectReads: false,
    loadAuth: async () => { authLoaded = true; throw new Error('must not load'); },
    loadPriceHistory: async () => { priceHistoryLoaded = true; throw new Error('must not load'); },
  });
  assert.equal(res.status, 405);
  assert.equal(authLoaded, false);
  assert.equal(priceHistoryLoaded, false);
});

test('auth module load failure returns a safe 401 without leaking the error', async () => {
  const res = await call('GET', {
    injectAuth: false,
    injectReads: false,
    loadAuth: async () => { throw new Error('simulated auth module failure'); },
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, reason: 'UNAUTHENTICATED' });
});

test('price-history module load failure after verified admin returns a safe 503', async () => {
  const res = await call('GET', {
    identity: ADMIN,
    injectReads: false,
    loadPriceHistory: async () => { throw new Error('simulated price-history module failure'); },
  });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, reason: 'DB_UNAVAILABLE' });
});

test('verified admin GET without a symbol returns snapshots and an empty points array', async () => {
  const res = await call('GET', { identity: ADMIN });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'points', 'snapshots', 'symbolFilter'].sort());
  assert.deepEqual(body.snapshots, FAKE_SNAPSHOTS.snapshots);
  assert.deepEqual(body.points, []);
  assert.equal(body.symbolFilter, null);
});

test('verified admin GET with a symbol query param returns bounded points, uppercased', async () => {
  let capturedSymbol = null;
  const res = await call('GET', {
    identity: ADMIN,
    query: 'symbol=btc&limit=10',
    reads: fakeReads({
      listRecentPricePoints: async ({ symbol, limit }) => { capturedSymbol = symbol; assert.equal(limit, 10); return FAKE_POINTS; },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.symbolFilter, 'BTC');
  assert.equal(capturedSymbol, 'BTC');
  assert.deepEqual(body.points, FAKE_POINTS.points);
});

test('limit query param is bounded to the max, and a bad limit falls back to the default', async () => {
  let capturedLimit = null;
  await call('GET', {
    identity: ADMIN,
    query: 'limit=999999',
    reads: fakeReads({ listRecentSnapshots: async ({ limit }) => { capturedLimit = limit; return FAKE_SNAPSHOTS; } }),
  });
  assert.equal(capturedLimit, 200);

  let capturedLimit2 = null;
  await call('GET', {
    identity: ADMIN,
    query: 'limit=not-a-number',
    reads: fakeReads({ listRecentSnapshots: async ({ limit }) => { capturedLimit2 = limit; return FAKE_SNAPSHOTS; } }),
  });
  assert.equal(capturedLimit2, 50);
});

test('response never contains raw_meta, a secret, or a db/chat/user-id-shaped key', async () => {
  const res = await call('GET', { identity: ADMIN, query: 'symbol=btc' });
  const raw = await res.text();
  assert.equal(raw.toLowerCase().includes('raw_meta'), false);
  for (const dangerous of ['token', 'secret', 'password', 'db_url', 'connection_string', 'chat_id']) {
    assert.equal(raw.toLowerCase().includes(dangerous), false, `response must not mention "${dangerous}"`);
  }
});

test('DB_UNAVAILABLE from listRecentSnapshots surfaces as a stable 503, not a crash or fake success', async () => {
  const res = await call('GET', {
    identity: ADMIN,
    reads: fakeReads({ listRecentSnapshots: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }) }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, reason: 'DB_UNAVAILABLE' });
});

test('DB_UNAVAILABLE from listRecentPricePoints (with a symbol filter) surfaces as a stable 503', async () => {
  const res = await call('GET', {
    identity: ADMIN,
    query: 'symbol=btc',
    reads: fakeReads({ listRecentPricePoints: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }) }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, reason: 'DB_UNAVAILABLE' });
});

test('thrown DB read returns a safe 503 without leaking the error', async () => {
  const res = await call('GET', {
    identity: ADMIN,
    reads: fakeReads({ listRecentSnapshots: async () => { throw new Error('simulated database detail'); } }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, reason: 'DB_UNAVAILABLE' });
  assert.equal(JSON.stringify(body).includes('simulated database detail'), false);
});
