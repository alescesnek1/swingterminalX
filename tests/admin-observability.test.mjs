// Phase 2C: tests for netlify/functions/admin-observability.mjs.
//
// The handler supports dependency injection (getIdentity / isAdmin / reads),
// so these tests never touch a real DB or real auth — they inject a fake
// verified-admin identity and fake read functions with canned, already-safe
// data. This proves the auth gate and response shape without depending on
// local Netlify dev DB state.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runAdminObservability } from '../netlify/functions/admin-observability.mjs';

const URL = 'https://swingterminalx.netlify.app/api/admin-observability';

const ADMIN = { ok: true, verified: true, userId: 'admin-uuid-0001', email: 'admin@example.com' };
const ADMIN_UNVERIFIED = { ok: true, verified: false, userId: 'admin-uuid-0001', email: 'admin@example.com' };
const NON_ADMIN = { ok: true, verified: true, userId: 'user-uuid-0002', email: 'user@example.com' };
const ANON = { ok: false, reason: 'No bearer token' };

const FAKE_EVENTS = { ok: true, events: [{ id: 1, ts: '2026-07-20T00:00:00.000Z', level: 'info', event: 'X', source: 'test', corr_id: null, payload: {}, error_name: null, error_code: null }] };
const FAKE_RUNS = { ok: true, runs: [{ id: 1, job: 'x', started_at: '2026-07-20T00:00:00.000Z', finished_at: null, status: 'ok', symbols_requested: 0, symbols_written: 0, rows_written: 0, source: null, error_code: null, detail: {} }] };
const FAKE_COUNTS = { ok: true, byLevel: { info: 1 }, bySource: { test: 1 } };

function fakeReads(overrides = {}) {
  return {
    listRecentSystemEvents: async () => FAKE_EVENTS,
    listRecentIngestRuns: async () => FAKE_RUNS,
    countSystemEventsSince: async () => FAKE_COUNTS,
    ...overrides,
  };
}

function makeReq(method, { origin } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  return new Request(URL, { method, headers });
}

function call(method, { identity = ADMIN, origin, reads, getIdentity, isAdmin } = {}) {
  return runAdminObservability(makeReq(method, { origin }), {
    getIdentity: getIdentity || (async () => identity),
    isAdmin: isAdmin || ((id) => id === ADMIN || id === ADMIN_UNVERIFIED),
    reads: reads || fakeReads(),
  });
}

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

test('POST/PUT/PATCH/DELETE return 405 without calling auth or DB', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    let authCalled = false;
    let dbCalled = false;
    const res = await call(method, {
      getIdentity: async () => { authCalled = true; throw new Error('must not run'); },
      reads: fakeReads({ listRecentSystemEvents: async () => { dbCalled = true; return FAKE_EVENTS; } }),
    });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { ok: false, reason: 'METHOD_NOT_ALLOWED' });
    assert.equal(authCalled, false);
    assert.equal(dbCalled, false);
  }
});

test('verified admin GET returns the expected safe aggregate shape', async () => {
  const res = await call('GET', { identity: ADMIN });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body).sort(), ['ingestRuns', 'last24h', 'ok', 'systemEvents']);
  assert.deepEqual(body.systemEvents, FAKE_EVENTS.events);
  assert.deepEqual(body.ingestRuns, FAKE_RUNS.runs);
  assert.deepEqual(body.last24h, { byLevel: FAKE_COUNTS.byLevel, bySource: FAKE_COUNTS.bySource });
});

test('response never contains a secret/db/chat/user-id-shaped key at the top level', async () => {
  const res = await call('GET', { identity: ADMIN });
  const raw = await res.text();
  for (const dangerous of ['token', 'secret', 'password', 'db_url', 'connection_string', 'chat_id']) {
    assert.equal(raw.toLowerCase().includes(dangerous), false, `response must not mention "${dangerous}"`);
  }
});

test('DB_UNAVAILABLE from any read function surfaces as a stable 503, not a crash or fake success', async () => {
  const res = await call('GET', {
    identity: ADMIN,
    reads: fakeReads({ listRecentSystemEvents: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }) }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, reason: 'DB_UNAVAILABLE' });
});

test('thrown DB read returns a safe 503 without leaking the error', async () => {
  const res = await call('GET', {
    identity: ADMIN,
    reads: fakeReads({ listRecentSystemEvents: async () => { throw new Error('simulated database detail'); } }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, reason: 'DB_UNAVAILABLE' });
  assert.equal(JSON.stringify(body).includes('simulated database detail'), false);
});
