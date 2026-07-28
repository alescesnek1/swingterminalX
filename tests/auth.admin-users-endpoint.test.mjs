// Tests for netlify/functions/admin-users.mjs.
//
// This endpoint can create accounts and reset passwords, so the authorization
// gate gets the most attention: a non-admin, an unverified (decode-only) token,
// and an anonymous caller must all be refused, and the DB `role` column must
// never be able to substitute for the BOT_ADMIN_EMAILS allowlist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdminUsers, generatePassword } from '../netlify/functions/admin-users.mjs';
import { verifyPassword, MIN_PASSWORD_LENGTH } from '../netlify/functions/_password.mjs';

const ADMIN = { ok: true, verified: true, userId: 'u-admin', email: 'admin@example.com', orgId: 'default' };
const NON_ADMIN = { ok: true, verified: true, userId: 'u-user', email: 'user@example.com', orgId: 'default' };
const UNVERIFIED_ADMIN = { ok: true, verified: false, userId: 'u-admin', email: 'admin@example.com', orgId: 'default' };

const USER = {
  id: '11111111-2222-3333-4444-555555555555',
  email: 'target@example.com',
  status: 'active',
  role: 'user',
  mustChangePassword: false,
  tokenVersion: 1,
};

function req(method, body) {
  const init = { method, headers: { Origin: 'https://app.example', Authorization: 'Bearer t' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request('https://app.example/api/admin-users', init);
}

function makeDeps(over = {}) {
  const calls = [];
  const store = {
    listUsers: async () => { calls.push({ name: 'listUsers' }); return { ok: true, users: [USER] }; },
    listAudit: async () => ({ ok: true, entries: [] }),
    findById: async (id) => { calls.push({ name: 'findById', id }); return { ok: true, found: true, user: USER }; },
    createUser: async (input) => { calls.push({ name: 'createUser', input }); return { ok: true, user: { ...USER, email: input.email, role: input.role } }; },
    setPassword: async (input) => { calls.push({ name: 'setPassword', input }); return { ok: true, found: true, user: USER }; },
    setStatus: async (id, status) => { calls.push({ name: 'setStatus', id, status }); return { ok: true, found: true, user: { ...USER, status } }; },
    writeAudit: async (input) => { calls.push({ name: 'writeAudit', input }); return { ok: true }; },
    ...(over.store || {}),
  };
  return {
    calls,
    deps: {
      getIdentity: async () => over.identity || ADMIN,
      // Mirrors the real isAdmin(): an env allowlist, nothing else.
      isAdmin: (identity) => identity.email === 'admin@example.com',
      store,
      ...over.deps,
    },
  };
}

async function call(method, body, over = {}) {
  const { deps, calls } = makeDeps(over);
  const res = await runAdminUsers(req(method, body), deps);
  return { res, json: await res.json(), calls };
}

// ── authorization ──

test('an anonymous caller is refused', async () => {
  const { res, json } = await call('GET', undefined, { identity: { ok: false, reason: 'No bearer token' } });
  assert.equal(res.status, 401);
  assert.equal(json.ok, false);
});

test('a non-admin is refused', async () => {
  const { res, json, calls } = await call('GET', undefined, { identity: NON_ADMIN });
  assert.equal(res.status, 403);
  assert.equal(json.reason, 'NOT_ADMIN');
  assert.equal(calls.length, 0, 'nothing may be read before the admin check passes');
});

test('a decode-only (unverified) token is refused even for an admin email', async () => {
  // AUTH_DECODE_ONLY exists for local dev. It must never be a path to account
  // management in a deployed environment.
  const { res, json, calls } = await call('GET', undefined, { identity: UNVERIFIED_ADMIN });
  assert.equal(res.status, 403);
  assert.equal(json.reason, 'IDENTITY_NOT_VERIFIED');
  assert.equal(calls.length, 0);
});

test('a DB role of admin does NOT grant access — only the env allowlist does', async () => {
  const dbAdminButNotAllowlisted = { ...NON_ADMIN, role: 'admin' };
  const { res, json } = await call('GET', undefined, { identity: dbAdminButNotAllowlisted });
  assert.equal(res.status, 403);
  assert.equal(json.reason, 'NOT_ADMIN');
});

// ── list ──

test('GET lists accounts and never leaks a hash', async () => {
  const { res, json } = await call('GET');
  assert.equal(res.status, 200);
  assert.equal(json.users.length, 1);
  assert.ok(!JSON.stringify(json).includes('scrypt'));
  assert.equal(json.passwordPolicy.minLength, MIN_PASSWORD_LENGTH);
});

test('an audit read failure is surfaced, never rendered as empty history', async () => {
  const { json } = await call('GET', undefined, {
    store: { listAudit: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }) },
  });
  assert.deepEqual(json.audit, []);
  assert.equal(json.auditError, 'DB_UNAVAILABLE', 'the UI must be able to tell "failed" from "none"');
});

test('a user-list outage is a 503, not an empty list', async () => {
  const { res, json } = await call('GET', undefined, {
    store: { listUsers: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }) },
  });
  assert.equal(res.status, 503);
  assert.equal(json.reason, 'DB_UNAVAILABLE');
  assert.equal(json.users, undefined);
});

// ── create ──

test('create generates a strong password, returns it once, and stores only a hash', async () => {
  const { res, json, calls } = await call('POST', { action: 'create', email: 'New@Example.com' });
  assert.equal(res.status, 201);
  assert.ok(json.generatedPassword, 'the admin must be shown the password exactly once');
  assert.ok(json.generatedPassword.length >= MIN_PASSWORD_LENGTH);

  const created = calls.find((c) => c.name === 'createUser');
  assert.equal(created.input.email, 'new@example.com', 'the email must be normalized');
  assert.match(created.input.passwordHash, /^scrypt\$/, 'only a hash may be persisted');
  assert.ok(!created.input.passwordHash.includes(json.generatedPassword));
  assert.equal(created.input.mustChangePassword, true);

  // The generated password verifies against the stored hash.
  const verdict = await verifyPassword(json.generatedPassword, created.input.passwordHash);
  assert.equal(verdict.matches, true);
});

test('the generated password is never written to the audit trail', async () => {
  const { json, calls } = await call('POST', { action: 'create', email: 'new@example.com' });
  const audits = JSON.stringify(calls.filter((c) => c.name === 'writeAudit'));
  assert.ok(!audits.includes(json.generatedPassword));
  assert.match(audits, /"action":"created"/);
});

test('an admin-supplied password must still pass policy', async () => {
  const { res, json, calls } = await call('POST', { action: 'create', email: 'new@example.com', password: 'short' });
  assert.equal(res.status, 400);
  assert.equal(json.reason, 'PASSWORD_TOO_SHORT');
  assert.ok(!calls.some((c) => c.name === 'createUser'), 'nothing may be created with a weak password');
});

test('an admin-supplied password is accepted and NOT echoed back', async () => {
  const supplied = 'an-admin-chosen-long-password';
  const { res, json } = await call('POST', { action: 'create', email: 'new@example.com', password: supplied });
  assert.equal(res.status, 201);
  assert.equal(json.generatedPassword, null, 'we did not generate it, so we do not show it');
  assert.ok(!JSON.stringify(json).includes(supplied));
});

test('an invalid email is rejected before anything is written', async () => {
  const { res, json, calls } = await call('POST', { action: 'create', email: 'not-an-email' });
  assert.equal(res.status, 400);
  assert.equal(json.reason, 'EMAIL_INVALID');
  assert.equal(calls.filter((c) => c.name === 'createUser').length, 0);
});

test('a duplicate email is a 409, not a 500', async () => {
  const { res, json } = await call('POST', { action: 'create', email: 'dupe@example.com' }, {
    store: { createUser: async () => ({ ok: false, reason: 'EMAIL_ALREADY_EXISTS' }) },
  });
  assert.equal(res.status, 409);
  assert.equal(json.reason, 'EMAIL_ALREADY_EXISTS');
});

// ── reset password ──

test('reset-password issues a new password and forces a change', async () => {
  const { res, json, calls } = await call('POST', { action: 'reset-password', userId: USER.id });
  assert.equal(res.status, 200);
  assert.ok(json.generatedPassword);

  const stored = calls.find((c) => c.name === 'setPassword');
  assert.equal(stored.input.id, USER.id);
  assert.equal(stored.input.mustChangePassword, true);
  assert.match(stored.input.passwordHash, /^scrypt\$/);
  assert.equal((await verifyPassword(json.generatedPassword, stored.input.passwordHash)).matches, true);
});

test('reset-password on an unknown account is a 404', async () => {
  const { res, json } = await call('POST', { action: 'reset-password', userId: 'missing' }, {
    store: { findById: async () => ({ ok: true, found: false }) },
  });
  assert.equal(res.status, 404);
  assert.equal(json.reason, 'ACCOUNT_NOT_FOUND');
});

// ── disable / enable ──

test('disable and enable change status and are audited', async () => {
  const disabled = await call('POST', { action: 'disable', userId: USER.id });
  assert.equal(disabled.res.status, 200);
  assert.equal(disabled.calls.find((c) => c.name === 'setStatus').status, 'disabled');
  assert.ok(disabled.calls.some((c) => c.name === 'writeAudit' && c.input.action === 'disabled'));

  const enabled = await call('POST', { action: 'enable', userId: USER.id });
  assert.equal(enabled.calls.find((c) => c.name === 'setStatus').status, 'active');
  assert.ok(enabled.calls.some((c) => c.name === 'writeAudit' && c.input.action === 'enabled'));
});

test('an admin cannot disable their own account', async () => {
  // There is no in-app recovery from this, so it is refused outright.
  const { res, json, calls } = await call('POST', { action: 'disable', userId: USER.id }, {
    store: { findById: async () => ({ ok: true, found: true, user: { ...USER, email: ADMIN.email } }) },
  });
  assert.equal(res.status, 400);
  assert.equal(json.reason, 'CANNOT_DISABLE_SELF');
  assert.ok(!calls.some((c) => c.name === 'setStatus'));
});

test('self-disable is refused regardless of email casing', async () => {
  const { res } = await call('POST', { action: 'disable', userId: USER.id }, {
    store: { findById: async () => ({ ok: true, found: true, user: { ...USER, email: 'ADMIN@Example.COM' } }) },
  });
  assert.equal(res.status, 400);
});

// ── input handling ──

test('an unknown or missing action is a 400', async () => {
  for (const action of [undefined, '', 'delete', 'DROP TABLE', 'promote']) {
    const { res, json } = await call('POST', { action, userId: USER.id });
    assert.equal(res.status, 400, `action=${String(action)} must be rejected`);
    assert.equal(json.reason, 'UNKNOWN_ACTION');
  }
});

test('actions other than create require a userId', async () => {
  for (const action of ['reset-password', 'disable', 'enable']) {
    const { res, json } = await call('POST', { action });
    assert.equal(res.status, 400);
    assert.equal(json.reason, 'USER_ID_REQUIRED');
  }
});

test('an oversized or malformed body is a clean 400', async () => {
  assert.equal((await call('POST', 'x'.repeat(9000))).res.status, 400);
  assert.equal((await call('POST', '{nope')).res.status, 400);
});

test('unsupported methods are rejected; OPTIONS preflights', async () => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const { res } = await call(method, {});
    assert.equal(res.status, 405, `${method} must be rejected`);
  }
  const { deps } = makeDeps();
  const preflight = await runAdminUsers(req('OPTIONS'), deps);
  assert.equal(preflight.status, 204);
});

test('no admin response is cacheable', async () => {
  const { res } = await call('GET');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

// ── generated password quality ──

test('generatePassword returns distinct, policy-passing values', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const password = generatePassword();
    assert.ok(password.length >= MIN_PASSWORD_LENGTH, `too short: ${password.length}`);
    // base64url only, so it survives copy/paste and shell quoting.
    assert.match(password, /^[A-Za-z0-9_-]+$/);
    seen.add(password);
  }
  assert.equal(seen.size, 200, 'generated passwords must never repeat');
});
