// Phase 2B: proves the DB connection helper works against the local Netlify
// dev database. Infrastructure-only — no product function imports this yet.
//
// These tests need NETLIFY_DB_URL, which only exists inside a Netlify dev
// context (e.g. `netlify dev:exec node --test tests/db.connection.test.mjs`,
// or any shell where `netlify dev` has injected it). Under plain `node --test`
// (no Netlify CLI context) the connection attempt below fails and every test
// skips with a clear reason — this file must never fail hard just because the
// Netlify CLI isn't running. Never require or fall back to a production DB.
import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb, closeDbForTests } from '../netlify/functions/_db.mjs';

let db = null;
let unavailableReason = null;
try {
  db = getDb();
  await db.pool.query('SELECT 1');
} catch (err) {
  unavailableReason = `local Netlify dev database unavailable (${err?.name || 'Error'}: ${err?.message || 'no message'}) — run via "netlify dev:exec node --test tests/db.connection.test.mjs" with the local dev DB started`;
}

test.after(async () => {
  await closeDbForTests();
});

test('getDb() loads and returns a usable connection', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  assert.ok(db, 'getDb() returned a connection object');
  assert.ok(typeof db.sql === 'function' || typeof db.sql === 'object', 'connection exposes a sql tag');
  assert.ok(db.pool, 'connection exposes a pool');
  assert.ok(['server', 'serverless'].includes(db.driver), 'driver is one of the expected values');
});

test('getDb() is cached — repeated calls return the same connection object', (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const again = getDb();
  assert.strictEqual(again, db, 'getDb() must not open a new connection on every call');
});

test('a simple read-only query round-trips', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const res = await db.pool.query('SELECT 1 + 1 AS sum');
  assert.equal(res.rows[0].sum, 2);
});
