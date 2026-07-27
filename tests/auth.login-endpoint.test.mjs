// Tests for netlify/functions/auth-login.mjs.
//
// The properties that matter are the ones an attacker probes and the ones that
// would hide an outage:
//   • every failure looks identical (no email enumeration)
//   • an unknown email still spends the scrypt work (no timing oracle)
//   • a DB outage is a 503, never "invalid credentials"
//   • disabled / locked accounts are refused without saying so
//   • no password, hash, or secret appears in any response
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAuthLogin } from '../netlify/functions/auth-login.mjs';
import { hashPassword } from '../netlify/functions/_password.mjs';
import { verifyAccessToken } from '../netlify/functions/_native-jwt.mjs';

const SECRET = 'k'.repeat(48);
const ENV = { NATIVE_AUTH_ENABLED: 'true', AUTH_JWT_SECRET: SECRET };
const PASSWORD = 'a-good-long-password';
const NOW = 1_800_000_000_000;

let HASH;
const row = (over = {}) => ({
  id: '11111111-2222-3333-4444-555555555555',
  email: 'owner@example.com',
  password_hash: HASH,
  status: 'active',
  role: 'admin',
  must_change_password: false,
  token_version: 1,
  failed_login_count: 0,
  locked_until: null,
  last_login_at: null,
  created_at: new Date(NOW),
  updated_at: new Date(NOW),
  ...over,
});

function req(body, method = 'POST') {
  const init = { method, headers: { 'Content-Type': 'application/json', Origin: 'https://app.example' } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://app.example/api/auth-login', init);
}

// A store stub that records what was called.
function makeStore(over = {}) {
  const calls = [];
  const record = (name) => (...args) => { calls.push({ name, args }); return { ok: true }; };
  return {
    calls,
    store: {
      findByEmailForLogin: async (email) => { calls.push({ name: 'findByEmailForLogin', args: [email] }); return { ok: true, found: true, row: row() }; },
      recordLoginFailure: async (id) => { calls.push({ name: 'recordLoginFailure', args: [id] }); return { ok: true, found: true, failedLoginCount: 1, locked: false }; },
      recordLoginSuccess: async (id) => { calls.push({ name: 'recordLoginSuccess', args: [id] }); return { ok: true }; },
      setPassword: async (input) => { calls.push({ name: 'setPassword', args: [input] }); return { ok: true, found: true, user: {} }; },
      writeAudit: async (input) => { calls.push({ name: 'writeAudit', args: [input] }); return { ok: true }; },
      ...over,
    },
  };
}

async function call(body, over = {}, envOver = {}) {
  const { store, calls } = makeStore(over.storeOver || {});
  const res = await runAuthLogin(req(body), {
    env: { ...ENV, ...envOver },
    store,
    nowMs: NOW,
    ...over.deps,
  });
  return { res, json: await res.json(), calls };
}

test('setup: hash the fixture password once', async () => {
  const result = await hashPassword(PASSWORD);
  assert.equal(result.ok, true);
  HASH = result.hash;
});

// ── happy path ──

test('a correct password returns a verifiable token', async () => {
  const { res, json } = await call({ email: 'Owner@Example.com', password: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);

  const verified = verifyAccessToken(json.token, ENV, NOW);
  assert.equal(verified.ok, true);
  assert.equal(verified.email, 'owner@example.com');
  assert.equal(json.expiresInSeconds, 3600);
});

test('the successful response carries no hash, password, or secret', async () => {
  const { json } = await call({ email: 'owner@example.com', password: PASSWORD });
  const serialized = JSON.stringify(json);
  assert.ok(!serialized.includes('scrypt'), 'the stored hash must not be echoed back');
  assert.ok(!serialized.includes(PASSWORD));
  assert.ok(!serialized.includes(SECRET));
  assert.equal(json.user.password_hash, undefined);
});

test('a successful login clears the failure counter and is audited', async () => {
  const { calls } = await call({ email: 'owner@example.com', password: PASSWORD });
  assert.ok(calls.some((c) => c.name === 'recordLoginSuccess'));
  assert.ok(calls.some((c) => c.name === 'writeAudit' && c.args[0].action === 'login_ok'));
});

test('mustChangePassword is passed through for a freshly created account', async () => {
  const { json } = await call({ email: 'owner@example.com', password: PASSWORD }, {
    storeOver: { findByEmailForLogin: async () => ({ ok: true, found: true, row: row({ must_change_password: true }) }) },
  });
  assert.equal(json.mustChangePassword, true);
});

// ── non-enumerability ──

test('unknown email, wrong password, disabled, and locked all return the SAME response', async () => {
  const scenarios = {
    unknownEmail: { storeOver: { findByEmailForLogin: async () => ({ ok: true, found: false }) } },
    wrongPassword: {},
    disabled: { storeOver: { findByEmailForLogin: async () => ({ ok: true, found: true, row: row({ status: 'disabled' }) }) } },
    lockedOut: { storeOver: { findByEmailForLogin: async () => ({ ok: true, found: true, row: row({ locked_until: new Date(NOW + 60_000) }) }) } },
  };

  const seen = [];
  for (const [name, over] of Object.entries(scenarios)) {
    const password = name === 'wrongPassword' ? 'definitely-not-the-password' : PASSWORD;
    const { res, json } = await call({ email: 'owner@example.com', password }, over);
    assert.equal(res.status, 401, `${name} must be 401`);
    seen.push(JSON.stringify(json));
  }

  const unique = new Set(seen);
  assert.equal(
    unique.size, 1,
    `all four failures must be byte-identical or the endpoint leaks account state: ${[...unique].join(' | ')}`,
  );
  assert.match(seen[0], /INVALID_CREDENTIALS/);
});

test('an unknown email still performs a password verification (no timing oracle)', async () => {
  let verifyCalls = 0;
  await call({ email: 'nobody@example.com', password: PASSWORD }, {
    storeOver: { findByEmailForLogin: async () => ({ ok: true, found: false }) },
    deps: {
      passwords: {
        verifyPassword: async () => { verifyCalls += 1; return { ok: true, matches: false, needsRehash: false }; },
        getDummyHash: async () => 'scrypt$N=32768,r=8,p=1$c2FsdA==$ZA==',
        hashPassword,
      },
    },
  });
  assert.equal(verifyCalls, 1, 'the unknown-email branch must spend the same scrypt work as a real one');
});

test('a malformed email gets the generic failure, not a validation hint', async () => {
  for (const email of ['not-an-email', '', null, 'a@b']) {
    const { res, json } = await call({ email, password: PASSWORD });
    assert.equal(res.status, 401);
    assert.equal(json.reason, 'INVALID_CREDENTIALS');
  }
});

test('a missing password is refused without touching the store', async () => {
  const { res, json, calls } = await call({ email: 'owner@example.com' });
  assert.equal(res.status, 401);
  assert.equal(json.reason, 'INVALID_CREDENTIALS');
  assert.equal(calls.length, 0);
});

// ── failures are counted, and lockouts audited ──

test('a wrong password increments the failure counter and audits it', async () => {
  const { calls } = await call({ email: 'owner@example.com', password: 'wrong-password-here' });
  assert.ok(calls.some((c) => c.name === 'recordLoginFailure'));
  assert.ok(calls.some((c) => c.name === 'writeAudit' && c.args[0].action === 'login_failed'));
});

test('crossing the lockout threshold is audited as login_locked', async () => {
  const { calls } = await call({ email: 'owner@example.com', password: 'wrong-password-here' }, {
    storeOver: { recordLoginFailure: async () => ({ ok: true, found: true, failedLoginCount: 8, locked: true }) },
  });
  assert.ok(calls.some((c) => c.name === 'writeAudit' && c.args[0].action === 'login_locked'));
});

test('no audit entry ever carries the attempted password', async () => {
  const { calls } = await call({ email: 'owner@example.com', password: 'my-secret-attempt' });
  const audits = JSON.stringify(calls.filter((c) => c.name === 'writeAudit'));
  assert.ok(!audits.includes('my-secret-attempt'));
});

// ── outages must not masquerade as bad credentials ──

test('a database outage is a 503 with its reason, never INVALID_CREDENTIALS', async () => {
  const { res, json } = await call({ email: 'owner@example.com', password: PASSWORD }, {
    storeOver: { findByEmailForLogin: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }) },
  });
  assert.equal(res.status, 503);
  assert.equal(json.reason, 'DB_UNAVAILABLE');
  assert.notEqual(json.reason, 'INVALID_CREDENTIALS');
});

test('an unreadable stored hash is a 500 an operator can act on, and is NOT counted as a failed login', async () => {
  // Counting it would lock the user out of an account they have no way to fix.
  const { res, json, calls } = await call({ email: 'owner@example.com', password: PASSWORD }, {
    storeOver: { findByEmailForLogin: async () => ({ ok: true, found: true, row: row({ password_hash: 'corrupted' }) }) },
  });
  assert.equal(res.status, 500);
  assert.equal(json.reason, 'ACCOUNT_HASH_UNREADABLE');
  assert.ok(!calls.some((c) => c.name === 'recordLoginFailure'));
});

// ── configuration gates ──

test('login is refused unless NATIVE_AUTH_ENABLED is exactly "true"', async () => {
  for (const flag of [undefined, 'false', 'TRUE', '1']) {
    const { res, json } = await call({ email: 'owner@example.com', password: PASSWORD }, {}, { NATIVE_AUTH_ENABLED: flag });
    assert.equal(res.status, 503, `flag=${String(flag)} must not enable login`);
    assert.equal(json.reason, 'NATIVE_AUTH_DISABLED');
    assert.equal(json.token, undefined);
  }
});

test('a missing or weak signing secret refuses login and is not echoed', async () => {
  const weak = 'short';
  const { res, json } = await call({ email: 'owner@example.com', password: PASSWORD }, {}, { AUTH_JWT_SECRET: weak });
  assert.equal(res.status, 503);
  assert.equal(json.reason, 'AUTH_JWT_SECRET_TOO_SHORT');
  assert.ok(!JSON.stringify(json).includes(weak));

  const missing = await call({ email: 'owner@example.com', password: PASSWORD }, {}, { AUTH_JWT_SECRET: undefined });
  assert.equal(missing.res.status, 503);
  assert.equal(missing.json.reason, 'AUTH_JWT_SECRET_MISSING');
});

// ── method / body handling ──

test('only POST is allowed; OPTIONS preflights', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const res = await runAuthLogin(req(undefined, method), { env: ENV, store: makeStore().store });
    assert.equal(res.status, 405, `${method} must be rejected`);
  }
  const preflight = await runAuthLogin(req(undefined, 'OPTIONS'), { env: ENV, store: makeStore().store });
  assert.equal(preflight.status, 204);
});

test('an oversized or malformed body is a clean 400', async () => {
  const huge = await call('x'.repeat(5000));
  assert.equal(huge.res.status, 400);

  const bad = await call('{not json');
  assert.equal(bad.res.status, 400);

  const empty = await call('');
  assert.equal(empty.res.status, 400);
});

test('the response is never cacheable', async () => {
  const { res } = await call({ email: 'owner@example.com', password: PASSWORD });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

// ── opportunistic rehash ──

test('a login with a weaker-than-policy hash is upgraded, preserving the change flag', async () => {
  const crypto = await import('node:crypto');
  const salt = crypto.default.randomBytes(16);
  const digest = crypto.default.scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
  const weakHash = `scrypt$N=16384,r=8,p=1$${salt.toString('base64')}$${digest.toString('base64')}`;

  const { res, calls } = await call({ email: 'owner@example.com', password: PASSWORD }, {
    storeOver: {
      findByEmailForLogin: async () => ({ ok: true, found: true, row: row({ password_hash: weakHash, must_change_password: true }) }),
    },
  });

  assert.equal(res.status, 200, 'the upgrade must not break the login');
  const stored = calls.find((c) => c.name === 'setPassword');
  assert.ok(stored, 'the stronger hash must be persisted');
  assert.match(stored.args[0].passwordHash, /^scrypt\$N=32768/);
  assert.equal(stored.args[0].mustChangePassword, true, 'a cost upgrade must not change the user-facing flag');
});

test('a failed rehash still lets the user in', async () => {
  const crypto = await import('node:crypto');
  const salt = crypto.default.randomBytes(16);
  const digest = crypto.default.scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
  const weakHash = `scrypt$N=16384,r=8,p=1$${salt.toString('base64')}$${digest.toString('base64')}`;

  const { res, json } = await call({ email: 'owner@example.com', password: PASSWORD }, {
    storeOver: {
      findByEmailForLogin: async () => ({ ok: true, found: true, row: row({ password_hash: weakHash }) }),
      setPassword: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }),
    },
  });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
});

test('a failure to record a successful login does not fail the login', async () => {
  const { res, json } = await call({ email: 'owner@example.com', password: PASSWORD }, {
    storeOver: { recordLoginSuccess: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }) },
  });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
});
