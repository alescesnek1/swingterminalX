// Phase 2C: tests for netlify/functions/_observability.mjs.
//
// Split into two groups:
//   1. Pure validation / sanitization tests — these never call getDb() (the
//      helper validates input before touching the DB), so they always run,
//      no local Netlify dev DB required.
//   2. DB-backed tests — same skip-gracefully pattern as tests/db.schema.
//      test.mjs: skip with a clear reason if no local dev DB is reachable,
//      never fail hard, never touch production. Any row inserted here is
//      deleted by id in a cleanup step (writeSystemEvent/writeIngestRun each
//      do a single INSERT via the shared pool, not a transaction-scoped
//      client, so explicit cleanup-by-id is used instead of BEGIN/ROLLBACK).
import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb, closeDbForTests } from '../netlify/functions/_db.mjs';
import {
  writeSystemEvent,
  writeIngestRun,
  listRecentSystemEvents,
  listRecentIngestRuns,
  countSystemEventsSince,
  sanitizePayload,
  ALLOWED_LEVELS,
  ALLOWED_RUN_STATUSES,
} from '../netlify/functions/_observability.mjs';

// ── Group 1: pure validation / sanitization — always run ────────────────

test('ALLOWED_LEVELS / ALLOWED_RUN_STATUSES match the DB check constraints', () => {
  assert.deepEqual([...ALLOWED_LEVELS].sort(), ['critical', 'debug', 'error', 'info', 'warn']);
  assert.deepEqual([...ALLOWED_RUN_STATUSES].sort(), ['failed', 'ok', 'partial', 'running']);
});

test('sanitizePayload strips every dangerous key name', () => {
  const dirty = {
    token: 'x', secret: 'x', password: 'x', authorization: 'x', cookie: 'x',
    jwt: 'x', chat_id: 'x', chatId: 'x', user_id: 'x', userId: 'x',
    db_url: 'x', dbUrl: 'x', databaseUrl: 'x', database_url: 'x',
    connection_string: 'x', connectionString: 'x', connection: 'x',
    accessToken: 'x', refreshToken: 'x', idToken: 'x', apiKey: 'x',
    Authorization: 'Bearer x', ACCESS_TOKEN: 'x', refresh_token: 'x',
    DatabaseURL: 'x', connectionSTRING: 'x', api_token: 'x', my_secret_value: 'x',
    safeField: 'kept', count: 3,
  };
  const clean = sanitizePayload(dirty);
  for (const dangerousKey of [
    'token', 'secret', 'password', 'authorization', 'cookie', 'jwt',
    'chat_id', 'chatId', 'user_id', 'userId', 'db_url', 'dbUrl',
    'databaseUrl', 'database_url', 'connection_string', 'connectionString', 'connection',
    'accessToken', 'refreshToken', 'idToken', 'apiKey', 'Authorization',
    'ACCESS_TOKEN', 'refresh_token', 'DatabaseURL', 'connectionSTRING',
    'api_token', 'my_secret_value',
  ]) {
    assert.equal(dangerousKey in clean, false, `${dangerousKey} must be stripped`);
  }
  assert.equal(clean.safeField, 'kept');
  assert.equal(clean.count, 3);
});

test('sanitizePayload strips dangerous keys inside nested objects/arrays', () => {
  const dirty = {
    nested: { accessToken: 'x', databaseUrl: 'x', connectionString: 'x', ok: 1 },
    list: [{ refreshToken: 'x', Authorization: 'Bearer x', ok: 2 }],
  };
  const clean = sanitizePayload(dirty);
  assert.equal('accessToken' in clean.nested, false);
  assert.equal('databaseUrl' in clean.nested, false);
  assert.equal('connectionString' in clean.nested, false);
  assert.equal(clean.nested.ok, 1);
  assert.equal('refreshToken' in clean.list[0], false);
  assert.equal('Authorization' in clean.list[0], false);
  assert.equal(clean.list[0].ok, 2);
});

test('sanitizePayload rejects a non-object payload safely', () => {
  const clean = sanitizePayload('just a string');
  assert.equal(typeof clean, 'object');
  assert.ok(clean._rejected);
});

test('sanitizePayload treats null/undefined as an empty object', () => {
  assert.deepEqual(sanitizePayload(null), {});
  assert.deepEqual(sanitizePayload(undefined), {});
});

test('sanitizePayload drops non-JSON-safe values (functions) instead of trusting them', () => {
  const clean = sanitizePayload({ fn: () => 'x', ok: 'kept' });
  assert.equal(clean.fn, undefined);
  assert.equal(clean.ok, 'kept');
});

test('sanitizePayload fails closed for hostile proxy values without losing safe siblings', () => {
  const hostile = new Proxy({}, {
    getPrototypeOf() {
      throw new Error('proxy trap should not escape');
    },
  });

  assert.doesNotThrow(() => sanitizePayload({ safe: 'ok', hostile }));
  const topLevel = sanitizePayload({ safe: 'ok', hostile });
  assert.equal(topLevel.safe, 'ok');
  assert.equal(topLevel.hostile, undefined);

  const nested = sanitizePayload({ nested: { safe: 'ok', hostile } });
  assert.equal(nested.nested.safe, 'ok');
  assert.equal(nested.nested.hostile, undefined);

  const array = sanitizePayload({ arr: [hostile, { safe: 'ok' }] });
  assert.equal(array.arr[0], undefined);
  assert.deepEqual(array.arr[1], { safe: 'ok' });
});

test('sanitizePayload rejects an oversized payload', () => {
  const clean = sanitizePayload({ big: 'x'.repeat(20_000) });
  assert.ok(clean._rejected);
});

test('writeSystemEvent rejects an invalid level without touching the DB', async () => {
  const res = await writeSystemEvent({ level: 'not-a-level', event: 'X', source: 'test' });
  assert.deepEqual(res, { ok: false, reason: 'INVALID_LEVEL' });
});

test('writeSystemEvent rejects a missing event code', async () => {
  const res = await writeSystemEvent({ level: 'info', source: 'test' });
  assert.deepEqual(res, { ok: false, reason: 'MISSING_EVENT' });
});

test('writeSystemEvent rejects a missing source', async () => {
  const res = await writeSystemEvent({ level: 'info', event: 'X' });
  assert.deepEqual(res, { ok: false, reason: 'MISSING_SOURCE' });
});

test('writeIngestRun rejects an invalid status', async () => {
  const res = await writeIngestRun({ job: 'test-job', status: 'not-a-status' });
  assert.deepEqual(res, { ok: false, reason: 'INVALID_STATUS' });
});

test('writeIngestRun rejects a missing job name', async () => {
  const res = await writeIngestRun({ status: 'ok' });
  assert.deepEqual(res, { ok: false, reason: 'MISSING_JOB' });
});

test('writeSystemEvent returns a stable DB_UNAVAILABLE reason when the DB cannot be reached — never throws, never pretends success', async () => {
  const fakeGetDb = () => { throw new Error('simulated: no DB configured'); };
  const res = await writeSystemEvent(
    { level: 'error', event: 'TEST_EVENT', source: 'tests/observability' },
    { getDbImpl: fakeGetDb },
  );
  assert.deepEqual(res, { ok: false, reason: 'DB_UNAVAILABLE' });
});

test('writeSystemEvent DB_UNAVAILABLE failure log never includes a secret-shaped value', async () => {
  const originalWarn = console.warn;
  const calls = [];
  console.warn = (...args) => { calls.push(args); };
  try {
    const fakeGetDb = () => { throw new Error('simulated: postgres://user:pw@host:5432/db'); };
    await writeSystemEvent({ level: 'error', event: 'TEST_EVENT', source: 'tests/observability' }, { getDbImpl: fakeGetDb });
  } finally {
    console.warn = originalWarn;
  }
  // DB_UNAVAILABLE from a thrown getDb() is returned before any logging call
  // in this helper (only query-time failures are logged) — assert nothing
  // was logged at all for this path, which is the strictest possible check.
  assert.equal(calls.length, 0);
});

// ── Group 2: DB-backed — skip gracefully without a local dev DB ─────────

let db = null;
let unavailableReason = null;
function safeSkipReason(err) {
  const name = typeof err?.name === 'string' && err.name ? err.name : 'UnknownError';
  const code = typeof err?.code === 'string' || typeof err?.code === 'number' ? String(err.code) : 'NO_CODE';
  return `DB_UNAVAILABLE:${name}:${code}`;
}
try {
  db = getDb();
  await db.pool.query('SELECT 1');
} catch (err) {
  unavailableReason = safeSkipReason(err);
}

test.after(async () => {
  await closeDbForTests();
});

// Cleanup-by-id (not a transaction) because writeSystemEvent/writeIngestRun
// use the shared pool directly, not a dedicated transactional client.
async function deleteSystemEvent(id) {
  if (id == null) return;
  await db.pool.query('DELETE FROM system_events WHERE id = $1', [id]);
}
async function deleteIngestRun(id) {
  if (id == null) return;
  await db.pool.query('DELETE FROM ingest_runs WHERE id = $1', [id]);
}

test('writeSystemEvent inserts a valid row and returns its id', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const res = await writeSystemEvent({ level: 'info', event: 'TEST_EVENT', source: 'tests/observability' });
  try {
    assert.equal(res.ok, true);
    assert.ok(res.id, 'insert returned a generated id');
  } finally {
    await deleteSystemEvent(res.id);
  }
});

test('writeSystemEvent strips dangerous payload keys before they ever reach the DB', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const res = await writeSystemEvent({
    level: 'warn',
    event: 'TEST_EVENT_PAYLOAD',
    source: 'tests/observability',
    payload: { token: 'should-not-be-stored', chat_id: 'should-not-be-stored', ok: 'kept' },
  });
  try {
    assert.equal(res.ok, true);
    const row = await db.pool.query('SELECT payload FROM system_events WHERE id = $1', [res.id]);
    const stored = row.rows[0].payload;
    assert.equal('token' in stored, false);
    assert.equal('chat_id' in stored, false);
    assert.equal(stored.ok, 'kept');
  } finally {
    await deleteSystemEvent(res.id);
  }
});

test('writeIngestRun inserts a valid row and returns its id', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const res = await writeIngestRun({ job: 'tests-observability-job', status: 'ok', symbolsRequested: 5, symbolsWritten: 5 });
  try {
    assert.equal(res.ok, true);
    assert.ok(res.id, 'insert returned a generated id');
  } finally {
    await deleteIngestRun(res.id);
  }
});

test('listRecentSystemEvents returns only the expected safe fields', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const written = await writeSystemEvent({ level: 'debug', event: 'TEST_LIST_EVENT', source: 'tests/observability' });
  try {
    const res = await listRecentSystemEvents({ limit: 5, source: 'tests/observability' });
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.events));
    const row = res.events.find((e) => e.id === written.id);
    assert.ok(row, 'the row we just wrote is present');
    assert.deepEqual(
      Object.keys(row).sort(),
      ['corr_id', 'error_code', 'error_name', 'event', 'id', 'level', 'payload', 'source', 'ts'].sort(),
    );
  } finally {
    await deleteSystemEvent(written.id);
  }
});

test('listRecentIngestRuns returns only the expected safe fields', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const written = await writeIngestRun({ job: 'tests-observability-list-job', status: 'running' });
  try {
    const res = await listRecentIngestRuns({ limit: 5 });
    assert.equal(res.ok, true);
    const row = res.runs.find((r) => r.id === written.id);
    assert.ok(row, 'the row we just wrote is present');
    assert.deepEqual(
      Object.keys(row).sort(),
      [
        'detail', 'error_code', 'finished_at', 'id', 'job', 'rows_written',
        'source', 'started_at', 'status', 'symbols_requested', 'symbols_written',
      ].sort(),
    );
  } finally {
    await deleteIngestRun(written.id);
  }
});

test('countSystemEventsSince counts the row we just wrote', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const written = await writeSystemEvent({ level: 'critical', event: 'TEST_COUNT_EVENT', source: 'tests/observability-count' });
  try {
    const res = await countSystemEventsSince({ sinceMs: 60_000 });
    assert.equal(res.ok, true);
    assert.ok(res.byLevel.critical >= 1);
    assert.ok(res.bySource['tests/observability-count'] >= 1);
  } finally {
    await deleteSystemEvent(written.id);
  }
});

test('tables are left clean after this file runs', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const events = await db.pool.query(`SELECT count(*)::int AS n FROM system_events WHERE source LIKE 'tests/observability%'`);
  const runs = await db.pool.query(`SELECT count(*)::int AS n FROM ingest_runs WHERE job LIKE 'tests-observability%'`);
  assert.equal(events.rows[0].n, 0);
  assert.equal(runs.rows[0].n, 0);
});
