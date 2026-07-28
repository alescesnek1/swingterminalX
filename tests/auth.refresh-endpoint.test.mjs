// Tests for netlify/functions/auth-refresh.mjs.
//
// Refresh is the ONLY place the database is consulted about an account, so it is
// the only thing making revocation real. These tests pin that: a disabled
// account, a deleted account, and a bumped token_version must all stop a refresh,
// while a transient DB outage must NOT log a healthy user out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAuthRefresh } from '../netlify/functions/auth-refresh.mjs';
import { mintAccessToken, verifyAccessToken } from '../netlify/functions/_native-jwt.mjs';

const SECRET = 'r'.repeat(48);
const ENV = { NATIVE_AUTH_ENABLED: 'true', AUTH_JWT_SECRET: SECRET };
const NOW = 1_800_000_000_000;

const USER_ROW = {
  id: '11111111-2222-3333-4444-555555555555',
  email: 'owner@example.com',
  status: 'active',
  role: 'admin',
  mustChangePassword: false,
  tokenVersion: 4,
};

function tokenFor(over = {}) {
  const minted = mintAccessToken(
    { id: USER_ROW.id, email: USER_ROW.email, role: USER_ROW.role, token_version: USER_ROW.tokenVersion, ...over },
    ENV,
    NOW,
  );
  assert.equal(minted.ok, true);
  return minted.token;
}

function req(token, method = 'POST') {
  const headers = { Origin: 'https://app.example' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request('https://app.example/api/auth-refresh', { method, headers });
}

async function call({ token = tokenFor(), user = USER_ROW, findResult, env = {}, nowMs = NOW } = {}) {
  const audits = [];
  const res = await runAuthRefresh(req(token), {
    env: { ...ENV, ...env },
    nowMs,
    store: {
      findById: async () => findResult || { ok: true, found: true, user },
      writeAudit: async (input) => { audits.push(input); return { ok: true }; },
    },
  });
  return { res, json: await res.json(), audits };
}

// ── happy path ──

test('a valid token is exchanged for a fresh one', async () => {
  const { res, json } = await call();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);

  const verified = verifyAccessToken(json.token, ENV, NOW);
  assert.equal(verified.ok, true);
  assert.equal(verified.email, 'owner@example.com');
  assert.equal(verified.tokenVersion, 4);
});

test('the new token is minted from the CURRENT row, not the old claims', async () => {
  // The stale token says role=admin and an old email; the row is the truth.
  const stale = tokenFor({ role: 'admin', email: 'old-address@example.com' });
  const { json } = await call({
    token: stale,
    user: { ...USER_ROW, email: 'new-address@example.com', role: 'user' },
  });

  const verified = verifyAccessToken(json.token, ENV, NOW);
  assert.equal(verified.email, 'new-address@example.com', 'a changed email must propagate');
  assert.equal(verified.role, 'user', 'a demoted role must not be carried forward forever');
});

// ── revocation ──

test('a disabled account cannot refresh', async () => {
  const { res, json, audits } = await call({ user: { ...USER_ROW, status: 'disabled' } });
  assert.equal(res.status, 401);
  assert.equal(json.reason, 'ACCOUNT_DISABLED');
  assert.equal(json.token, undefined);
  assert.ok(audits.some((a) => a.detail?.outcome === 'refresh_disabled'));
});

test('a deleted account cannot refresh', async () => {
  const { res, json } = await call({ findResult: { ok: true, found: false } });
  assert.equal(res.status, 401);
  assert.equal(json.reason, 'ACCOUNT_NOT_FOUND');
});

test('a bumped token_version invalidates the session', async () => {
  // This is what setPassword()/setStatus() do, so it is how a password reset
  // kicks existing sessions out.
  const { res, json } = await call({ user: { ...USER_ROW, tokenVersion: USER_ROW.tokenVersion + 1 } });
  assert.equal(res.status, 401);
  assert.equal(json.reason, 'TOKEN_VERSION_STALE');
  assert.equal(json.token, undefined);
});

test('an expired token cannot be refreshed — the user logs in again', async () => {
  const { res, json } = await call({ nowMs: NOW + 3601 * 1000 });
  assert.equal(res.status, 401);
  assert.equal(json.reason, 'TOKEN_EXPIRED');
});

test('a forged token cannot be refreshed', async () => {
  const foreign = mintAccessToken(
    { id: USER_ROW.id, email: USER_ROW.email, token_version: 4 },
    { ...ENV, AUTH_JWT_SECRET: 'x'.repeat(48) },
    NOW,
  );
  const { res, json } = await call({ token: foreign.token });
  assert.equal(res.status, 401);
  assert.equal(json.reason, 'TOKEN_SIGNATURE_INVALID');
});

// ── an outage must not log a healthy user out ──

test('a DB outage returns 503, NOT 401, so the browser keeps its current token', async () => {
  // A 401 here would sign the user out over a transient blip; 503 lets the
  // existing token keep working until it genuinely expires.
  const { res, json } = await call({ findResult: { ok: false, reason: 'DB_UNAVAILABLE' } });
  assert.equal(res.status, 503);
  assert.equal(json.reason, 'DB_UNAVAILABLE');
  assert.equal(json.token, undefined, 'but it must still not hand out a new token');
});

// ── gates and method handling ──

test('refresh is refused unless NATIVE_AUTH_ENABLED is exactly "true"', async () => {
  for (const flag of [undefined, 'false', 'TRUE']) {
    const { res, json } = await call({ env: { NATIVE_AUTH_ENABLED: flag } });
    assert.equal(res.status, 503);
    assert.equal(json.reason, 'NATIVE_AUTH_DISABLED');
  }
});

test('a missing bearer token is a 401', async () => {
  const { res, json } = await call({ token: null });
  assert.equal(res.status, 401);
  assert.equal(json.reason, 'NO_BEARER_TOKEN');
});

test('only POST is allowed; OPTIONS preflights', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await runAuthRefresh(req(tokenFor(), method), { env: ENV });
    assert.equal(res.status, 405, `${method} must be rejected`);
  }
  const preflight = await runAuthRefresh(req(null, 'OPTIONS'), { env: ENV });
  assert.equal(preflight.status, 204);
});

test('no response ever echoes the signing secret, and none is cacheable', async () => {
  const { res, json } = await call();
  assert.ok(!JSON.stringify(json).includes(SECRET));
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
