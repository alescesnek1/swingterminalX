// Tests for netlify/functions/price-history-prune-scheduled.mjs (the
// scheduled retention pruner) AND the pruneSnapshotsOlderThan /
// getLatestSnapshotAt helpers it and the collector depend on
// (netlify/functions/_price-history.mjs). Same DI pattern as the other
// price-history tests: no real DB, no real network.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runPriceHistoryPruneScheduled,
} from '../netlify/functions/price-history-prune-scheduled.mjs';
import { PRICE_HISTORY_SCHEDULER_HEADER } from '../netlify/functions/price-history-collect-scheduled.mjs';
import { pruneSnapshotsOlderThan, getLatestSnapshotAt } from '../netlify/functions/_price-history.mjs';

const URL = 'https://swingterminalx.netlify.app/api/price-history-prune-scheduled';
const SECRET = 'test-scheduler-secret-value';
const AUTHED_ENV = { PRICE_HISTORY_SCHEDULER_SECRET: SECRET };

function makeReq(method, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const secret = Object.prototype.hasOwnProperty.call(opts, 'secret') ? opts.secret : SECRET;
  if (secret !== undefined) headers[PRICE_HISTORY_SCHEDULER_HEADER] = secret;
  return new Request(URL, { method, headers });
}

function baseDeps(overrides = {}) {
  return {
    env: { ...AUTHED_ENV, PRICE_HISTORY_PRUNE_ENABLED: 'true', PRICE_HISTORY_RETENTION_DAYS: '14' },
    pruneSnapshotsOlderThan: async () => ({ ok: true, prunedSnapshots: 3, reason: null }),
    ...overrides,
  };
}

function call(method, deps) {
  return runPriceHistoryPruneScheduled(makeReq(method, { secret: SECRET }), deps);
}

// ── price-history-prune-scheduled.mjs (the endpoint) ────────────────────

test('OPTIONS preflight returns 204 with POST-only CORS methods', async () => {
  const res = await runPriceHistoryPruneScheduled(makeReq('OPTIONS'), baseDeps());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
});

test('non-POST returns 405 before auth or any DB work', async () => {
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    let pruneCalled = false;
    const deps = baseDeps({ pruneSnapshotsOlderThan: async () => { pruneCalled = true; return { ok: true, prunedSnapshots: 0 }; } });
    const res = await call(method, deps);
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { ok: false, reason: 'METHOD_NOT_ALLOWED' });
    assert.equal(pruneCalled, false);
  }
});

test('missing, wrong, or empty scheduler secret fails closed with 401 before any DB work', async () => {
  const cases = [
    makeReq('POST', { secret: undefined }),
    makeReq('POST', { secret: '' }),
    makeReq('POST', { secret: 'wrong-secret' }),
  ];
  for (const req of cases) {
    let pruneCalled = false;
    const deps = baseDeps({ pruneSnapshotsOlderThan: async () => { pruneCalled = true; return { ok: true, prunedSnapshots: 0 }; } });
    const res = await runPriceHistoryPruneScheduled(req, deps);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, reason: 'SCHEDULER_UNAUTHENTICATED' });
    assert.equal(pruneCalled, false);
  }
});

test('PRUNE_ENABLED flag disabled deletes nothing and returns 200 PRUNE_DISABLED', async () => {
  for (const flag of [undefined, 'false', '1']) {
    let pruneCalled = false;
    const env = { ...AUTHED_ENV, PRICE_HISTORY_RETENTION_DAYS: '14' };
    if (flag !== undefined) env.PRICE_HISTORY_PRUNE_ENABLED = flag;
    const deps = baseDeps({ env, pruneSnapshotsOlderThan: async () => { pruneCalled = true; return { ok: true, prunedSnapshots: 5 }; } });
    const res = await call('POST', deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, skipped: true, pruned: false, prunedSnapshots: 0, reason: 'PRUNE_DISABLED' });
    assert.equal(pruneCalled, false);
  }
});

// C3 fix: prune enabled + unusable retention must be a non-2xx status, not
// 200 — a 200 here would let a misconfigured PRICE_HISTORY_RETENTION_DAYS
// leave the scheduler's CI job green while pruning silently never ran.
test('missing, zero, negative, or non-numeric retention returns a non-2xx PRUNE_INVALID_RETENTION and deletes nothing', async () => {
  for (const days of [undefined, '0', '-5', 'not-a-number', '']) {
    let pruneCalled = false;
    const env = { ...AUTHED_ENV, PRICE_HISTORY_PRUNE_ENABLED: 'true' };
    if (days !== undefined) env.PRICE_HISTORY_RETENTION_DAYS = days;
    const deps = baseDeps({ env, pruneSnapshotsOlderThan: async () => { pruneCalled = true; return { ok: true, prunedSnapshots: 5 }; } });
    const res = await call('POST', deps);
    assert.notEqual(res.status, 200, `days="${days}" must not report a green (200) status`);
    assert.ok(res.status >= 400 && res.status < 600, `expected a non-2xx status for days="${days}", got ${res.status}`);
    assert.deepEqual(await res.json(), { ok: false, pruned: false, prunedSnapshots: 0, reason: 'PRUNE_INVALID_RETENTION' });
    assert.equal(pruneCalled, false, `days="${days}" must not trigger a delete`);
  }
});

test('valid retention calls pruneSnapshotsOlderThan with the parsed day count and returns its result', async () => {
  let capturedArgs = null;
  const deps = baseDeps({
    env: { ...AUTHED_ENV, PRICE_HISTORY_PRUNE_ENABLED: 'true', PRICE_HISTORY_RETENTION_DAYS: '14' },
    pruneSnapshotsOlderThan: async (args) => { capturedArgs = args; return { ok: true, prunedSnapshots: 42, reason: null }; },
  });
  const res = await call('POST', deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, pruned: true, prunedSnapshots: 42, reason: null });
  assert.equal(capturedArgs.days, 14);
});

test('a prune failure (DB_UNAVAILABLE) returns 503, not 200', async () => {
  const deps = baseDeps({ pruneSnapshotsOlderThan: async () => ({ ok: false, reason: 'DB_UNAVAILABLE', prunedSnapshots: 0 }) });
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await call('POST', deps);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, pruned: false, prunedSnapshots: 0, reason: 'DB_UNAVAILABLE' });
});

test('a prune failure (generic PRUNE_FAILED) returns 502, not 200', async () => {
  const deps = baseDeps({ pruneSnapshotsOlderThan: async () => ({ ok: false, reason: 'PRUNE_FAILED', prunedSnapshots: 2 }) });
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await call('POST', deps);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { ok: false, pruned: false, prunedSnapshots: 2, reason: 'PRUNE_FAILED' });
});

test('a thrown pruneSnapshotsOlderThan never propagates and resolves to a non-2xx response', async () => {
  const deps = baseDeps({ pruneSnapshotsOlderThan: async () => { throw new Error('simulated: postgres://user:pw@host/db'); } });
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
  assert.equal(body.reason, 'PRUNE_FAILED');
});

test('response never contains a secret or a raw error message', async () => {
  const deps = baseDeps({ pruneSnapshotsOlderThan: async () => { throw new Error('simulated: postgres://user:pw@host/db'); } });
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await call('POST', deps);
  } finally {
    console.warn = originalWarn;
  }
  const raw = await res.text();
  for (const dangerous of [SECRET.toLowerCase(), 'postgres://', 'user:pw', 'authorization', 'bearer']) {
    assert.equal(raw.toLowerCase().includes(dangerous), false, `response must not mention "${dangerous}"`);
  }
});

// ── _price-history.mjs helpers used by both scheduled functions ─────────

test('pruneSnapshotsOlderThan rejects missing/invalid/<=0 days without touching the DB', async () => {
  const fakeGetDb = () => { throw new Error('unreachable — must not be called'); };
  for (const days of [undefined, null, 0, -1, 'nope', NaN]) {
    const res = await pruneSnapshotsOlderThan({ days }, { getDbImpl: fakeGetDb });
    assert.deepEqual(res, { ok: false, reason: 'PRUNE_INVALID_RETENTION', prunedSnapshots: 0 });
  }
});

test('pruneSnapshotsOlderThan returns DB_UNAVAILABLE without throwing when the DB cannot be reached', async () => {
  const fakeGetDb = () => { throw new Error('simulated'); };
  const res = await pruneSnapshotsOlderThan({ days: 14 }, { getDbImpl: fakeGetDb });
  assert.deepEqual(res, { ok: false, reason: 'DB_UNAVAILABLE', prunedSnapshots: 0 });
});

test('pruneSnapshotsOlderThan batches deletes and stops once a partial batch is returned', async () => {
  const calls = [];
  const fakeDb = {
    pool: {
      query: async (sql, params) => {
        calls.push(params);
        // First batch full (10), second batch partial (4) -> must stop after 2 calls.
        const rowCount = calls.length === 1 ? 10 : 4;
        return { rowCount };
      },
    },
  };
  const res = await pruneSnapshotsOlderThan({ days: 14, batchSize: 10 }, { getDbImpl: () => fakeDb });
  assert.equal(res.ok, true);
  assert.equal(res.prunedSnapshots, 14);
  assert.equal(calls.length, 2, 'must stop once a batch returns fewer rows than batchSize');
});

test('pruneSnapshotsOlderThan respects maxBatches as a hard ceiling even if every batch stays full', async () => {
  let calls = 0;
  const fakeDb = { pool: { query: async () => { calls += 1; return { rowCount: 5 }; } } };
  const res = await pruneSnapshotsOlderThan({ days: 14, batchSize: 5, maxBatches: 3 }, { getDbImpl: () => fakeDb });
  assert.equal(res.ok, true);
  assert.equal(calls, 3);
  assert.equal(res.prunedSnapshots, 15);
});

test('pruneSnapshotsOlderThan returns PRUNE_FAILED (keeping partial progress) when a later batch throws', async () => {
  let calls = 0;
  const fakeDb = {
    pool: {
      query: async () => {
        calls += 1;
        if (calls === 2) throw new Error('simulated: postgres://user:pw@host/db');
        return { rowCount: 5 };
      },
    },
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await pruneSnapshotsOlderThan({ days: 14, batchSize: 5 }, { getDbImpl: () => fakeDb });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'PRUNE_FAILED');
  assert.equal(res.prunedSnapshots, 5, 'progress from the first successful batch is preserved');
});

test('pruneSnapshotsOlderThan never logs a secret-shaped or DB-URL-shaped value', async () => {
  const fakeDb = { pool: { query: async () => { throw new Error('simulated: postgres://user:pw@host:5432/db'); } } };
  const calls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { calls.push(args); };
  try {
    await pruneSnapshotsOlderThan({ days: 14 }, { getDbImpl: () => fakeDb });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls.length, 1);
  const serialized = JSON.stringify(calls[0]);
  assert.equal(serialized.includes('postgres://'), false);
  assert.equal(serialized.includes('user:pw'), false);
});

test('getLatestSnapshotAt rejects a missing source without touching the DB', async () => {
  const res = await getLatestSnapshotAt({});
  assert.deepEqual(res, { ok: false, reason: 'MISSING_SOURCE' });
});

test('getLatestSnapshotAt returns sampledAt:null when no snapshot exists for that source', async () => {
  const fakeDb = { pool: { query: async () => ({ rows: [] }) } };
  const res = await getLatestSnapshotAt({ source: 'scheduled_price_history' }, { getDbImpl: () => fakeDb });
  assert.deepEqual(res, { ok: true, sampledAt: null });
});

test('getLatestSnapshotAt returns the most recent sampled_at when a row exists', async () => {
  const when = new Date('2026-07-21T11:00:00Z');
  const fakeDb = { pool: { query: async () => ({ rows: [{ sampled_at: when }] }) } };
  const res = await getLatestSnapshotAt({ source: 'scheduled_price_history' }, { getDbImpl: () => fakeDb });
  assert.equal(res.ok, true);
  assert.equal(res.sampledAt.getTime(), when.getTime());
});

test('getLatestSnapshotAt returns a stable DB_UNAVAILABLE reason when the DB cannot be reached', async () => {
  const fakeGetDb = () => { throw new Error('simulated'); };
  const res = await getLatestSnapshotAt({ source: 'x' }, { getDbImpl: fakeGetDb });
  assert.deepEqual(res, { ok: false, reason: 'DB_UNAVAILABLE' });
});
