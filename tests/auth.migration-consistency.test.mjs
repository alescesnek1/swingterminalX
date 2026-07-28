// Consistency between the app_users migration and the code that writes to it.
//
// WHY: `app_user_audit.action` has a CHECK constraint listing the allowed
// values. If code ever writes an action the constraint does not allow, the INSERT
// fails with SQLSTATE 23514 — and because auditing is deliberately best-effort
// (it must never block the action it records), that failure would show up only as
// a console warning in the Netlify logs while every audit row silently vanished.
//
// A unit test cannot catch that: the fake pool in auth.user-store.test.mjs
// accepts anything. So this file reads the migration SQL and the source files
// together and asserts they agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../netlify/database/migrations/20260727160000_add_app_users/migration.sql', import.meta.url),
  'utf8',
);

const SOURCES = [
  'auth-login.mjs',
  'auth-refresh.mjs',
  'auth-change-password.mjs',
  'admin-users.mjs',
].map((name) => ({
  name,
  code: fs.readFileSync(new URL(`../netlify/functions/${name}`, import.meta.url), 'utf8'),
}));

/** Pull the allowed values out of a `CHECK (col IN ('a','b'))` clause. */
function allowedValues(sql, column) {
  const match = new RegExp(`${column}\\s+text\\s+NOT NULL[^,]*?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'is').exec(sql);
  assert.ok(match, `could not find a CHECK constraint for ${column}`);
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

test('the migration declares both tables and a case-insensitive unique email', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS app_users/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS app_user_audit/);
  // Without lower(), Alice@x.com and alice@x.com would be two accounts.
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS \w+ ON app_users \(lower\(email\)\)/);
});

test('every audit action written by code is allowed by the CHECK constraint', () => {
  const allowed = allowedValues(migration, 'action');

  const used = new Set();
  for (const { name, code } of SOURCES) {
    // Stop at the first comma: the rest of the line carries unrelated fields
    // (`detail: { outcome: '…' }`) whose values are NOT audit actions. Both
    // `action: 'login_ok'` and `action: cond ? 'a' : 'b'` are covered.
    for (const match of code.matchAll(/action:\s*([^,\n]+)/g)) {
      for (const literal of match[1].matchAll(/'([a-z_-]+)'/g)) {
        used.add(`${literal[1]}|${name}`);
      }
    }
  }

  assert.ok(used.size > 0, 'the scan found no audit actions at all — the regex is wrong, not the code');

  for (const entry of used) {
    const [action, file] = entry.split('|');
    // `create`, `disable`, `enable`, `reset-password` are admin-users REQUEST
    // actions, not audit actions — they are never written to the audit column.
    if (['create', 'disable', 'enable', 'reset-password'].includes(action)) continue;
    assert.ok(
      allowed.has(action),
      `${file} writes audit action '${action}' but the CHECK constraint only allows: ${[...allowed].sort().join(', ')}`,
    );
  }
});

test('the status and role CHECK constraints match what the store can write', () => {
  const statuses = allowedValues(migration, 'status');
  assert.deepEqual([...statuses].sort(), ['active', 'disabled']);

  const roles = allowedValues(migration, 'role');
  assert.deepEqual([...roles].sort(), ['admin', 'user']);

  // _user-store.mjs refuses anything else before it reaches the DB, so these two
  // lists must agree or a legitimate value would be rejected by the constraint.
  const store = fs.readFileSync(new URL('../netlify/functions/_user-store.mjs', import.meta.url), 'utf8');
  assert.match(store, /status !== 'active' && status !== 'disabled'/);
  assert.match(store, /role === 'admin' \? 'admin' : 'user'/);
});

test('the audit table stores no password, hash, token, or IP column', () => {
  // The columns are the last line of defence: even a buggy caller cannot persist
  // a secret into a column that does not exist.
  const auditBlock = /CREATE TABLE IF NOT EXISTS app_user_audit\s*\(([\s\S]*?)\n\);/.exec(migration);
  assert.ok(auditBlock, 'could not isolate the app_user_audit definition');

  // Only COLUMN NAMES — the first identifier on each definition line. A naive
  // substring scan of the whole block matches 'password' inside the allowed
  // action value 'password_reset', which is a value, not a column.
  const columnNames = auditBlock[1]
    .split('\n')
    .map((line) => /^\s{2,}([a-z_]+)\s+[a-z]/i.exec(line))
    .filter(Boolean)
    .map((m) => m[1].toLowerCase());

  assert.ok(columnNames.includes('action'), 'the column scan found nothing — the regex is wrong, not the schema');
  for (const forbidden of ['password', 'password_hash', 'hash', 'token', 'secret', 'ip', 'ip_address']) {
    assert.ok(
      !columnNames.includes(forbidden),
      `app_user_audit must not have a '${forbidden}' column (found: ${columnNames.join(', ')})`,
    );
  }
});

test('app_users carries the columns the store reads back', () => {
  // toPublicUser() maps these by name; a rename in one place only would surface
  // as `undefined` fields in the admin panel rather than an error.
  for (const column of [
    'email', 'password_hash', 'status', 'role', 'must_change_password',
    'token_version', 'failed_login_count', 'locked_until', 'last_login_at',
    'created_at', 'updated_at',
  ]) {
    assert.match(migration, new RegExp(`\\n\\s+${column}\\s`), `app_users is missing the ${column} column`);
  }
});
