// Phase 2B: proves the observability migration
// (netlify/database/migrations/20260720081238_init-observability-tables)
// produced the expected schema — tables, columns, and check constraints.
// Infrastructure-only, same skip behavior as tests/db.connection.test.mjs:
// no local Netlify dev DB means every test here skips with a clear reason
// instead of failing.
//
// Any row this file writes is inserted inside a transaction that is always
// rolled back in a `finally` block, so the database is left exactly as it
// was found regardless of pass/fail/skip.
import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb, closeDbForTests } from '../netlify/functions/_db.mjs';

let db = null;
let unavailableReason = null;
try {
  db = getDb();
  await db.pool.query('SELECT 1');
} catch (err) {
  unavailableReason = `local Netlify dev database unavailable (${err?.name || 'Error'}: ${err?.message || 'no message'}) — run via "netlify dev:exec node --test tests/db.schema.test.mjs" with the local dev DB started`;
}

test.after(async () => {
  await closeDbForTests();
});

const EXPECTED_TABLES = ['system_events', 'ingest_runs'];

const EXPECTED_COLUMNS = {
  system_events: ['id', 'ts', 'level', 'event', 'source', 'corr_id', 'payload', 'error_name', 'error_code'],
  ingest_runs: [
    'id', 'job', 'started_at', 'finished_at', 'status',
    'symbols_requested', 'symbols_written', 'rows_written', 'source', 'error_code', 'detail',
  ],
};

// Runs `fn(client)` inside BEGIN/ROLLBACK so any INSERT the test performs is
// always undone, even if an assertion throws.
async function withRollback(fn) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('both observability tables exist', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const res = await db.pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [EXPECTED_TABLES],
  );
  const found = res.rows.map((r) => r.tablename).sort();
  assert.deepEqual(found, [...EXPECTED_TABLES].sort());
});

for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
  test(`${table} has the expected columns`, async (t) => {
    if (!db) { t.skip(unavailableReason); return; }
    const res = await db.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    const found = res.rows.map((r) => r.column_name).sort();
    assert.deepEqual(found, [...columns].sort());
  });
}

test('system_events.level rejects a value outside the allowed set', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  await withRollback(async (client) => {
    await assert.rejects(
      () => client.query(
        `INSERT INTO system_events (level, event, source) VALUES ($1, $2, $3)`,
        ['not-a-real-level', 'TEST_EVENT', 'tests/db.schema'],
      ),
      /violates check constraint/i,
    );
  });
});

test('system_events.level accepts a value from the allowed set', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  await withRollback(async (client) => {
    const res = await client.query(
      `INSERT INTO system_events (level, event, source) VALUES ($1, $2, $3) RETURNING id`,
      ['info', 'TEST_EVENT', 'tests/db.schema'],
    );
    assert.ok(res.rows[0].id, 'insert returned a generated id');
  });
});

test('ingest_runs.status rejects a value outside the allowed set', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  await withRollback(async (client) => {
    await assert.rejects(
      () => client.query(
        `INSERT INTO ingest_runs (job, started_at, status) VALUES ($1, now(), $2)`,
        ['test-job', 'not-a-real-status'],
      ),
      /violates check constraint/i,
    );
  });
});

test('ingest_runs.status accepts a value from the allowed set', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  await withRollback(async (client) => {
    const res = await client.query(
      `INSERT INTO ingest_runs (job, started_at, status) VALUES ($1, now(), $2) RETURNING id`,
      ['test-job', 'running'],
    );
    assert.ok(res.rows[0].id, 'insert returned a generated id');
  });
});
