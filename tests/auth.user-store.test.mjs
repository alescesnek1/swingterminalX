// Tests for netlify/functions/_user-store.mjs.
//
// Uses the repo's `deps.getDbImpl` injection with a fake pg pool, so the
// contract is verified deterministically without a local dev DB. What that
// CANNOT verify is the SQL executing correctly against the real schema — that is
// what applying the migration proves. So the tests here focus on the parts that
// are pure logic and would be silent failures in production:
//
//   • a password hash must never escape through a public shape
//   • Postgres error codes must map to the right discriminated reason
//   • a DB outage must never read as "no such user" (that would fail OPEN)
//   • lockout must fail closed on ambiguous data
//   • audit detail must never carry a secret
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmail,
  validateEmail,
  toPublicUser,
  findByEmailForLogin,
  findById,
  listUsers,
  createUser,
  setPassword,
  setStatus,
  recordLoginSuccess,
  recordLoginFailure,
  isLockedOut,
  writeAudit,
  MAX_FAILED_LOGINS,
} from '../netlify/functions/_user-store.mjs';

const VALID_HASH = 'scrypt$N=32768,r=8,p=1$c2FsdHNhbHQ=$ZGlnZXN0';

// A fake pool. `respond` receives (sql, params) and returns rows or throws.
function fakeDb(respond) {
  const calls = [];
  return {
    getDbImpl: () => ({
      pool: {
        query: async (sql, params) => {
          calls.push({ sql, params });
          const result = await respond(sql, params, calls.length);
          if (result instanceof Error) throw result;
          return { rows: result || [] };
        },
      },
    }),
    calls,
  };
}

function pgError(code) {
  const err = new Error('pg failure');
  err.code = code;
  return err;
}

const ROW = {
  id: '11111111-2222-3333-4444-555555555555',
  email: 'owner@example.com',
  password_hash: VALID_HASH,
  status: 'active',
  role: 'admin',
  must_change_password: false,
  token_version: 2,
  failed_login_count: 0,
  locked_until: null,
  last_login_at: null,
  created_at: new Date('2026-07-27T10:00:00Z'),
  updated_at: new Date('2026-07-27T10:00:00Z'),
};

// ── email handling ──

test('emails are normalized and validated', () => {
  assert.equal(normalizeEmail('  Owner@Example.COM '), 'owner@example.com');
  assert.equal(normalizeEmail(null), '');

  assert.equal(validateEmail('a@b.co').ok, true);
  assert.equal(validateEmail('  A@B.CO ').email, 'a@b.co');
  assert.equal(validateEmail('').reason, 'EMAIL_REQUIRED');
  assert.equal(validateEmail('nope').reason, 'EMAIL_INVALID');
  assert.equal(validateEmail('no@domain').reason, 'EMAIL_INVALID');
  assert.equal(validateEmail('two@@at.co').reason, 'EMAIL_INVALID');
  assert.equal(validateEmail('has space@x.co').reason, 'EMAIL_INVALID');
  assert.equal(validateEmail(`${'x'.repeat(400)}@b.co`).reason, 'EMAIL_TOO_LONG');
});

// ── the hash must not escape ──

test('toPublicUser never exposes the password hash', () => {
  const pub = toPublicUser(ROW);
  assert.equal(pub.password_hash, undefined);
  assert.equal(pub.passwordHash, undefined);
  assert.ok(!JSON.stringify(pub).includes('scrypt'), 'no trace of the hash may survive serialization');
  assert.equal(pub.email, 'owner@example.com');
  assert.equal(pub.tokenVersion, 2);
  assert.equal(toPublicUser(null), null);
});

test('listUsers and findById return public shapes only', async () => {
  const listDb = fakeDb(() => [ROW]);
  const listed = await listUsers({}, listDb);
  assert.equal(listed.ok, true);
  assert.ok(!JSON.stringify(listed.users).includes('scrypt'));

  const byIdDb = fakeDb(() => [ROW]);
  const found = await findById(ROW.id, byIdDb);
  assert.equal(found.found, true);
  assert.ok(!JSON.stringify(found.user).includes('scrypt'));
});

test('the login lookup is the ONLY path that returns a hash', async () => {
  const db = fakeDb(() => [ROW]);
  const result = await findByEmailForLogin('owner@example.com', db);
  assert.equal(result.found, true);
  assert.equal(result.row.password_hash, VALID_HASH);
  // ...and it queries case-insensitively with the normalized value.
  assert.match(db.calls[0].sql, /lower\(email\) = \$1/);
  assert.equal(db.calls[0].params[0], 'owner@example.com');
});

test('every query is parameterized — no email is interpolated into SQL', async () => {
  const hostile = "attacker'; DROP TABLE app_users; --@evil.co";
  const db = fakeDb(() => []);
  await findByEmailForLogin(hostile, db);
  // The address is invalid, so it must not even reach the DB.
  assert.equal(db.calls.length, 0, 'an invalid email is rejected before any query');

  const db2 = fakeDb(() => []);
  await findByEmailForLogin('ok@example.com', db2);
  assert.ok(!db2.calls[0].sql.includes('ok@example.com'), 'the value belongs in params, not the SQL text');
});

// ── "not found" vs "broken" must never be confused ──

test('a missing account is found:false, not an error', async () => {
  const db = fakeDb(() => []);
  const result = await findByEmailForLogin('nobody@example.com', db);
  assert.equal(result.ok, true);
  assert.equal(result.found, false);
});

test('a DB outage is DB_UNAVAILABLE, never a silent "no such user"', async () => {
  // This is the important direction: if an outage read as found:false, the login
  // path would report "invalid credentials" and nobody would know the DB is down.
  const cases = [
    ['findByEmailForLogin', () => findByEmailForLogin('a@b.co', fakeDb(() => pgError('08006')))],
    ['findById', () => findById(ROW.id, fakeDb(() => pgError('08006')))],
    ['listUsers', () => listUsers({}, fakeDb(() => pgError('08006')))],
    ['createUser', () => createUser({ email: 'a@b.co', passwordHash: VALID_HASH }, fakeDb(() => pgError('08006')))],
    ['setPassword', () => setPassword({ id: ROW.id, passwordHash: VALID_HASH }, fakeDb(() => pgError('08006')))],
    ['setStatus', () => setStatus(ROW.id, 'disabled', fakeDb(() => pgError('08006')))],
    ['recordLoginSuccess', () => recordLoginSuccess(ROW.id, fakeDb(() => pgError('08006')))],
    ['recordLoginFailure', () => recordLoginFailure(ROW.id, fakeDb(() => pgError('08006')))],
  ];
  for (const [name, run] of cases) {
    const result = await run();
    assert.equal(result.ok, false, `${name} must report failure`);
    assert.equal(result.reason, 'DB_UNAVAILABLE', `${name} must not disguise an outage`);
    assert.notEqual(result.found, false, `${name} must not report found:false on an outage`);
  }
});

test('a getDb() that throws is DB_UNAVAILABLE, not a crash', async () => {
  const throwingDeps = { getDbImpl: () => { throw new Error('NETLIFY_DB_URL not configured'); } };
  const result = await listUsers({}, throwingDeps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'DB_UNAVAILABLE');
});

test('an invalid uuid reads as not-found, not as an outage', async () => {
  const result = await findById('not-a-uuid', fakeDb(() => pgError('22P02')));
  assert.equal(result.ok, true);
  assert.equal(result.found, false);
});

// ── create ──

test('createUser refuses a plaintext password in the hash slot', async () => {
  const db = fakeDb(() => [ROW]);
  for (const bad of ['hunter2', '', null, undefined, 'bcrypt$2a$10$abc']) {
    const result = await createUser({ email: 'a@b.co', passwordHash: bad }, db);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(result.reason, 'PASSWORD_HASH_REQUIRED');
  }
  assert.equal(db.calls.length, 0, 'nothing may be written without a real hash');
});

test('a duplicate email is a clear reason, not a 500', async () => {
  const result = await createUser({ email: 'a@b.co', passwordHash: VALID_HASH }, fakeDb(() => pgError('23505')));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EMAIL_ALREADY_EXISTS');
});

test('a new account defaults to role user and must-change-password', async () => {
  const db = fakeDb(() => [ROW]);
  await createUser({ email: 'a@b.co', passwordHash: VALID_HASH }, db);
  assert.equal(db.calls[0].params[2], 'user');
  assert.equal(db.calls[0].params[3], true, 'an admin-set password must be changed by the user');
});

test('an unrecognized role never becomes admin', async () => {
  for (const role of ['ADMIN', 'root', '', null]) {
    const db = fakeDb(() => [ROW]);
    await createUser({ email: 'a@b.co', passwordHash: VALID_HASH, role }, db);
    assert.equal(db.calls[0].params[2], 'user', `role=${String(role)} must not become admin`);
  }
  const adminDb = fakeDb(() => [ROW]);
  await createUser({ email: 'a@b.co', passwordHash: VALID_HASH, role: 'admin' }, adminDb);
  assert.equal(adminDb.calls[0].params[2], 'admin');
});

// ── password / status changes bump token_version ──

test('setPassword bumps token_version and clears the lockout', async () => {
  const db = fakeDb(() => [ROW]);
  await setPassword({ id: ROW.id, passwordHash: VALID_HASH }, db);
  const { sql } = db.calls[0];
  assert.match(sql, /token_version = token_version \+ 1/, 'outstanding sessions must be invalidated at next refresh');
  assert.match(sql, /failed_login_count = 0/);
  assert.match(sql, /locked_until = NULL/, 'a reset must let a locked-out user back in');
});

test('setStatus bumps token_version so disabling actually revokes', async () => {
  const db = fakeDb(() => [ROW]);
  await setStatus(ROW.id, 'disabled', db);
  assert.match(db.calls[0].sql, /token_version = token_version \+ 1/);
});

test('setStatus refuses any status outside the schema constraint', async () => {
  const db = fakeDb(() => [ROW]);
  for (const bad of ['deleted', 'ACTIVE', '', null, 'suspended']) {
    const result = await setStatus(ROW.id, bad, db);
    assert.equal(result.reason, 'STATUS_INVALID', `status=${String(bad)} must be refused`);
  }
  assert.equal(db.calls.length, 0);
});

test('setPassword and setStatus require an id', async () => {
  assert.equal((await setPassword({ id: '', passwordHash: VALID_HASH }, fakeDb(() => []))).reason, 'ID_REQUIRED');
  assert.equal((await setStatus('  ', 'active', fakeDb(() => []))).reason, 'ID_REQUIRED');
});

// ── lockout ──

test('recordLoginFailure locks the account at the threshold', async () => {
  const db = fakeDb(() => [{ failed_login_count: MAX_FAILED_LOGINS, locked_until: new Date(Date.now() + 60_000) }]);
  const result = await recordLoginFailure(ROW.id, db);
  assert.equal(result.ok, true);
  assert.equal(result.locked, true);
  assert.equal(db.calls[0].params[1], MAX_FAILED_LOGINS);
});

test('a failure below the threshold does not lock', async () => {
  const db = fakeDb(() => [{ failed_login_count: 2, locked_until: null }]);
  const result = await recordLoginFailure(ROW.id, db);
  assert.equal(result.locked, false);
  assert.equal(result.failedLoginCount, 2);
});

test('isLockedOut fails CLOSED on an unparseable lock timestamp', () => {
  const now = Date.parse('2026-07-27T12:00:00Z');
  assert.equal(isLockedOut({ locked_until: null }, now), false);
  assert.equal(isLockedOut(null, now), false);
  assert.equal(isLockedOut({ locked_until: '2026-07-27T12:00:01Z' }, now), true);
  assert.equal(isLockedOut({ locked_until: '2026-07-27T11:59:59Z' }, now), false);
  // Garbage must keep the door shut, never open it.
  assert.equal(isLockedOut({ locked_until: 'not-a-date' }, now), true);
  assert.equal(isLockedOut({ locked_until: 'NaN' }, now), true);
});

// ── audit ──

test('audit detail can never carry a password, hash, token, or secret', async () => {
  const db = fakeDb(() => []);
  await writeAudit({
    action: 'created',
    actorEmail: 'Admin@Example.com',
    targetEmail: 'New@Example.com',
    targetUserId: ROW.id,
    detail: {
      password: 'hunter2',
      passwordHash: VALID_HASH,
      accessToken: 'abc',
      apiSecret: 'shh',
      note: 'created via admin page',
      count: 1,
      nested: { deep: 'dropped — only primitives survive' },
    },
  }, db);

  const detail = JSON.parse(db.calls[0].params[4]);
  assert.deepEqual(Object.keys(detail).sort(), ['count', 'note']);
  const serialized = JSON.stringify(db.calls[0].params);
  assert.ok(!serialized.includes('hunter2'));
  assert.ok(!serialized.includes('scrypt'));
  assert.ok(!serialized.includes('shh'));
  // Emails are normalized for a consistent audit trail.
  assert.equal(db.calls[0].params[1], 'admin@example.com');
  assert.equal(db.calls[0].params[2], 'new@example.com');
});

test('an audit failure never blocks the action it describes', async () => {
  // writeAudit returns a discriminated failure; callers proceed regardless.
  const result = await writeAudit({ action: 'created' }, fakeDb(() => pgError('08006')));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'DB_UNAVAILABLE');
});

test('writeAudit requires an action', async () => {
  const db = fakeDb(() => []);
  assert.equal((await writeAudit({}, db)).reason, 'ACTION_REQUIRED');
  assert.equal(db.calls.length, 0);
});

test('listUsers clamps the limit', async () => {
  const db = fakeDb(() => []);
  await listUsers({ limit: 99999 }, db);
  assert.equal(db.calls[0].params[0], 500);

  const db2 = fakeDb(() => []);
  await listUsers({ limit: -5 }, db2);
  assert.equal(db2.calls[0].params[0], 1);
});
