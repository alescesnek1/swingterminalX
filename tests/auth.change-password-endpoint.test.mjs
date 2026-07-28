// Tests for netlify/functions/auth-change-password.mjs.
//
// Two properties carry the weight:
//   1. The CURRENT password is required even though the caller already holds a
//      valid token — a stolen token must not be enough to take an account over.
//   2. The change bumps token_version, which invalidates the caller's own token,
//      so a replacement must be minted. Forgetting that would log the user out
//      by their own successful action.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAuthChangePassword } from '../netlify/functions/auth-change-password.mjs';
import { hashPassword } from '../netlify/functions/_password.mjs';
import { verifyAccessToken } from '../netlify/functions/_native-jwt.mjs';

const SECRET = 'c'.repeat(48);
const ENV = { NATIVE_AUTH_ENABLED: 'true', AUTH_JWT_SECRET: SECRET };
const NOW = 1_800_000_000_000;
const CURRENT = 'the-current-password';
const NEXT = 'a-brand-new-password';

const ID = '11111111-2222-3333-4444-555555555555';
const NATIVE_IDENTITY = {
  ok: true, verified: true, authMode: 'verified_native_hs256',
  userId: ID, email: 'owner@example.com', orgId: 'default',
};

let HASH;

function req(body, method = 'POST') {
  const init = { method, headers: { Origin: 'https://app.example', Authorization: 'Bearer t' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request('https://app.example/api/auth-change-password', init);
}

function row(over = {}) {
  return {
    id: ID, email: 'owner@example.com', password_hash: HASH, status: 'active', role: 'user',
    must_change_password: true, token_version: 3, failed_login_count: 0, locked_until: null,
    ...over,
  };
}

async function call(body, over = {}, env = {}) {
  const calls = [];
  const res = await runAuthChangePassword(req(body), {
    env: { ...ENV, ...env },
    nowMs: NOW,
    getIdentity: async () => over.identity || NATIVE_IDENTITY,
    store: {
      findByEmailForLogin: async () => over.lookup || { ok: true, found: true, row: row() },
      setPassword: async (input) => {
        calls.push({ name: 'setPassword', input });
        return over.setPasswordResult || {
          ok: true, found: true,
          user: { id: ID, email: 'owner@example.com', role: 'user', tokenVersion: 4, mustChangePassword: false },
        };
      },
      writeAudit: async (input) => { calls.push({ name: 'writeAudit', input }); return { ok: true }; },
    },
  });
  return { res, json: await res.json(), calls };
}

test('setup: hash the fixture password', async () => {
  const result = await hashPassword(CURRENT);
  assert.equal(result.ok, true);
  HASH = result.hash;
});

// ── happy path ──

test('a correct current password changes it and returns a usable new token', async () => {
  const { res, json, calls } = await call({ currentPassword: CURRENT, newPassword: NEXT });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.mustChangePassword, false, 'the obligation is discharged');

  const stored = calls.find((c) => c.name === 'setPassword');
  assert.match(stored.input.passwordHash, /^scrypt\$/);
  assert.equal(stored.input.mustChangePassword, false);

  // Without a replacement token the user would be signed out by their own change.
  const verified = verifyAccessToken(json.token, ENV, NOW);
  assert.equal(verified.ok, true);
  assert.equal(verified.tokenVersion, 4, 'the new token must carry the BUMPED version');
});

test('the response never echoes either password', async () => {
  const { json } = await call({ currentPassword: CURRENT, newPassword: NEXT });
  const serialized = JSON.stringify(json);
  assert.ok(!serialized.includes(CURRENT));
  assert.ok(!serialized.includes(NEXT));
  assert.ok(!serialized.includes('scrypt'));
  assert.ok(!serialized.includes(SECRET));
});

test('no audit entry carries a password', async () => {
  const { calls } = await call({ currentPassword: CURRENT, newPassword: NEXT });
  const audits = JSON.stringify(calls.filter((c) => c.name === 'writeAudit'));
  assert.ok(!audits.includes(CURRENT));
  assert.ok(!audits.includes(NEXT));
});

// ── re-authentication is mandatory ──

test('a wrong current password is refused even with a valid token', async () => {
  const { res, json, calls } = await call({ currentPassword: 'not-the-password', newPassword: NEXT });
  assert.equal(res.status, 401);
  assert.equal(json.reason, 'CURRENT_PASSWORD_INCORRECT');
  assert.ok(!calls.some((c) => c.name === 'setPassword'), 'nothing may be written');
});

test('a missing current password is refused', async () => {
  const { res, json } = await call({ newPassword: NEXT });
  assert.equal(res.status, 400);
  assert.equal(json.reason, 'CURRENT_PASSWORD_REQUIRED');
});

// ── policy ──

test('the new password must pass policy', async () => {
  const { res, json, calls } = await call({ currentPassword: CURRENT, newPassword: 'short' });
  assert.equal(res.status, 400);
  assert.equal(json.reason, 'PASSWORD_TOO_SHORT');
  assert.equal(calls.length, 0, 'policy is checked before the account is even loaded');
});

test('the new password must differ from the current one', async () => {
  const { res, json } = await call({ currentPassword: CURRENT, newPassword: CURRENT });
  assert.equal(res.status, 400);
  assert.equal(json.reason, 'PASSWORD_UNCHANGED');
});

// ── identity requirements ──

test('an anonymous caller is refused', async () => {
  const { res } = await call({ currentPassword: CURRENT, newPassword: NEXT }, {
    identity: { ok: false, reason: 'No bearer token' },
  });
  assert.equal(res.status, 401);
});

test('a decode-only token cannot change a credential', async () => {
  const { res, json } = await call({ currentPassword: CURRENT, newPassword: NEXT }, {
    identity: { ...NATIVE_IDENTITY, verified: false },
  });
  assert.equal(res.status, 403);
  assert.equal(json.reason, 'IDENTITY_NOT_VERIFIED');
});

test('a Supabase session is told plainly that it has no native password', async () => {
  const { res, json } = await call({ currentPassword: CURRENT, newPassword: NEXT }, {
    identity: { ...NATIVE_IDENTITY, authMode: 'verified_hs256' },
  });
  assert.equal(res.status, 400);
  assert.equal(json.reason, 'NOT_A_NATIVE_SESSION');
});

test('a token subject that disagrees with the row is refused', async () => {
  // Defense in depth: the row is loaded by email, the token asserts an id. If
  // they disagree, something is wrong and we do not guess which to trust.
  const { res, json } = await call({ currentPassword: CURRENT, newPassword: NEXT }, {
    lookup: { ok: true, found: true, row: row({ id: 'a-different-id' }) },
  });
  assert.equal(res.status, 401);
  assert.equal(json.reason, 'IDENTITY_ROW_MISMATCH');
});

test('a disabled account cannot change its password', async () => {
  const { res, json } = await call({ currentPassword: CURRENT, newPassword: NEXT }, {
    lookup: { ok: true, found: true, row: row({ status: 'disabled' }) },
  });
  assert.equal(res.status, 401);
  assert.equal(json.reason, 'ACCOUNT_DISABLED');
});

// ── failure modes ──

test('a DB outage on lookup is a 503, not a credential error', async () => {
  const { res, json } = await call({ currentPassword: CURRENT, newPassword: NEXT }, {
    lookup: { ok: false, reason: 'DB_UNAVAILABLE' },
  });
  assert.equal(res.status, 503);
  assert.equal(json.reason, 'DB_UNAVAILABLE');
});

test('a failure to STORE the new password is a 503 and does not claim success', async () => {
  const { res, json } = await call({ currentPassword: CURRENT, newPassword: NEXT }, {
    setPasswordResult: { ok: false, reason: 'DB_UNAVAILABLE' },
  });
  assert.equal(res.status, 503);
  assert.notEqual(json.ok, true);
});

test('a corrupt stored hash is an operator error, not a wrong password', async () => {
  const { res, json } = await call({ currentPassword: CURRENT, newPassword: NEXT }, {
    lookup: { ok: true, found: true, row: row({ password_hash: 'corrupted' }) },
  });
  assert.equal(res.status, 500);
  assert.equal(json.reason, 'ACCOUNT_HASH_UNREADABLE');
});

test('a password change that succeeds but cannot mint a token says so precisely', async () => {
  // The password DID change. Reporting a plain failure would make the user retry
  // with the old password forever.
  const res = await runAuthChangePassword(req({ currentPassword: CURRENT, newPassword: NEXT }), {
    env: ENV,
    nowMs: NOW,
    getIdentity: async () => NATIVE_IDENTITY,
    mintAccessToken: () => ({ ok: false, reason: 'USER_ID_REQUIRED' }),
    store: {
      findByEmailForLogin: async () => ({ ok: true, found: true, row: row() }),
      setPassword: async () => ({ ok: true, found: true, user: { id: ID, email: 'owner@example.com', role: 'user', tokenVersion: 4 } }),
      writeAudit: async () => ({ ok: true }),
    },
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.passwordChanged, true, 'the change must be reported as done');
  assert.equal(json.token, null);
  assert.match(json.error, /sign in again/i);
});

// ── gates and method handling ──

test('the endpoint is refused unless NATIVE_AUTH_ENABLED is exactly "true"', async () => {
  for (const flag of [undefined, 'false', 'TRUE']) {
    const { res, json } = await call({ currentPassword: CURRENT, newPassword: NEXT }, {}, { NATIVE_AUTH_ENABLED: flag });
    assert.equal(res.status, 503);
    assert.equal(json.reason, 'NATIVE_AUTH_DISABLED');
  }
});

test('only POST is allowed; OPTIONS preflights; responses are not cacheable', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await runAuthChangePassword(req(undefined, method), { env: ENV });
    assert.equal(res.status, 405, `${method} must be rejected`);
  }
  const preflight = await runAuthChangePassword(req(undefined, 'OPTIONS'), { env: ENV });
  assert.equal(preflight.status, 204);

  const { res } = await call({ currentPassword: CURRENT, newPassword: NEXT });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('an oversized or malformed body is a clean 400', async () => {
  assert.equal((await call('x'.repeat(5000))).res.status, 400);
  assert.equal((await call('{nope')).res.status, 400);
  assert.equal((await call('')).res.status, 400);
});
