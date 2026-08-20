// Tests for netlify/functions/auth-refresh.mjs.
//
// Refresh is the ONLY place the database is consulted about an account, so it is
// the only thing making revocation real. These tests pin that: a disabled
// account, a deleted account, and a bumped token_version must all stop a refresh,
// while a transient DB outage must NOT log a healthy user out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAuthRefresh } from '../netlify/functions/auth-refresh.mjs';
import { createHmac } from 'node:crypto';
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

// A token exactly as this endpoint used to mint them: no `sid`/`sxp`. Built by
// hand because the current minter always opens a session, and the point is to
// prove tokens already in users' browsers keep behaving predictably.
function legacyToken() {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'swing-terminal',
    aud: 'swing-terminal-app',
    sub: USER_ROW.id,
    email: USER_ROW.email,
    role: USER_ROW.role,
    tv: USER_ROW.tokenVersion,
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 3600,
    jti: 'legacy-token',
  })).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
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

// ── device sessions: a reload must not ask for a password ──
// This is the behaviour the whole feature exists for. An access token that
// lapsed while the tab was closed is re-minted WITHOUT a password, but only
// inside the 8h window opened at login, and the window itself never moves.

test('an expired token IS refreshed inside its live device session', async () => {
  // One second past the 60-minute access token, well inside the 8h session.
  const { res, json } = await call({ nowMs: NOW + 3601 * 1000 });
  assert.equal(res.status, 200, 'an ordinary page reload must not require a password');
  assert.equal(json.ok, true);
  assert.ok(json.token);
});

test('a refresh cannot push the 8h deadline out', async () => {
  const first = await call();
  const deadline = first.json.sessionExpiresAt;
  assert.equal(deadline, new Date(NOW + 8 * 3600 * 1000).toISOString());

  // Refresh again, much later, with the token the first refresh issued.
  const second = await call({ token: first.json.token, nowMs: NOW + 7 * 3600 * 1000 });
  assert.equal(second.res.status, 200);
  assert.equal(second.json.sessionExpiresAt, deadline, 'the window must be carried, never extended');
});

test('a token past its 8h deadline is refused — the user logs in again', async () => {
  const { res, json } = await call({ nowMs: NOW + 8 * 3600 * 1000 + 1000 });
  assert.equal(res.status, 401);
  assert.equal(json.reason, 'SESSION_EXPIRED');
  assert.equal(json.token, undefined);
});

test('SESSION_TTL_SECONDS sets the window, and is refused past it', async () => {
  const env = { SESSION_TTL_SECONDS: String(2 * 3600) };
  // The window is stamped into the token AT LOGIN, so the login-time env is what
  // decides it — the token has to be minted with the same setting.
  const token = mintAccessToken(
    { id: USER_ROW.id, email: USER_ROW.email, role: USER_ROW.role, token_version: USER_ROW.tokenVersion },
    { ...ENV, ...env },
    NOW,
  ).token;

  const inside = await call({ env, token, nowMs: NOW + 3601 * 1000 });
  assert.equal(inside.res.status, 200);
  assert.equal(inside.json.sessionExpiresAt, new Date(NOW + 2 * 3600 * 1000).toISOString());

  const outside = await call({ env, token, nowMs: NOW + 2 * 3600 * 1000 + 1000 });
  assert.equal(outside.res.status, 401);
  assert.equal(outside.json.reason, 'SESSION_EXPIRED');
});

test('a legacy token with no session claim gets NO expiry tolerance', async () => {
  // Tokens minted before device sessions existed must behave exactly as before:
  // once expired, the user logs in again.
  const { res, json } = await call({ token: legacyToken(), nowMs: NOW + 3601 * 1000 });
  assert.equal(res.status, 401);
  assert.equal(json.reason, 'TOKEN_EXPIRED');
});

test('a still-valid legacy token is upgraded into a device session', async () => {
  // The fleet migrates itself: no forced logout, and the next reload is covered.
  const { res, json } = await call({ token: legacyToken(), nowMs: NOW + 60 * 1000 });
  assert.equal(res.status, 200);
  assert.equal(json.sessionExpiresAt, new Date(NOW + 60 * 1000 + 8 * 3600 * 1000).toISOString());
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
