// Tests for the native/Supabase dispatch added to netlify/functions/_auth.mjs.
//
// The single most important property of this phase is that it is ADDITIVE: with
// NATIVE_AUTH_ENABLED unset, every existing code path must behave exactly as it
// did before, and a native token must be REFUSED rather than quietly accepted.
// The flag-off cases below are therefore the point of this file, not an
// afterthought.
//
// Native tokens are HS256, the same algorithm Supabase's legacy symmetric tokens
// use, so "it happens to fall through harmlessly" is not good enough to assume —
// it is asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const AUTH_SECRET = 'n'.repeat(48);
const SUPABASE_SECRET = 'supabase-unit-test-secret';

process.env.AUTH_JWT_SECRET = AUTH_SECRET;
process.env.SUPABASE_JWT_SECRET = SUPABASE_SECRET;
process.env.BOT_ADMIN_EMAILS = 'admin@example.com';
delete process.env.NATIVE_AUTH_ENABLED;
delete process.env.AUTH_DECODE_ONLY;
delete process.env.SUPABASE_URL;

const { verifyJwt, getIdentity, isAdmin } = await import('../netlify/functions/_auth.mjs');
const { mintAccessToken } = await import('../netlify/functions/_native-jwt.mjs');

const USER = { id: '11111111-2222-3333-4444-555555555555', email: 'admin@example.com', role: 'admin', token_version: 5 };

function nativeToken() {
  const result = mintAccessToken(USER, { NATIVE_AUTH_ENABLED: 'true', AUTH_JWT_SECRET: AUTH_SECRET });
  assert.equal(result.ok, true);
  return result.token;
}

// A legacy Supabase-style HS256 token, signed with SUPABASE_JWT_SECRET.
function supabaseToken(over = {}) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    sub: 'supabase-user-1',
    email: 'legacy@example.com',
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  });
  const sig = crypto.createHmac('sha256', SUPABASE_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function withNativeEnabled(fn) {
  process.env.NATIVE_AUTH_ENABLED = 'true';
  try {
    return fn();
  } finally {
    delete process.env.NATIVE_AUTH_ENABLED;
  }
}

// ── FLAG OFF: nothing may change ──

test('flag off: a native token is REFUSED, never silently accepted', async () => {
  // Native tokens are HS256, so they reach the Supabase HS256 branch and are
  // checked against SUPABASE_JWT_SECRET — a guaranteed mismatch. This is the
  // fail-closed behaviour that makes enabling native auth a real cutover.
  const result = await verifyJwt(nativeToken());
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'invalid signature');
});

test('flag off: a legacy Supabase token still verifies exactly as before', async () => {
  const result = await verifyJwt(supabaseToken());
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.authMode, 'verified_hs256');
  assert.equal(result.userId, 'supabase-user-1');
  assert.equal(result.email, 'legacy@example.com');
  assert.equal(result.orgId, 'default');
});

test('flag off: an expired Supabase token is still rejected', async () => {
  const expired = supabaseToken({ exp: Math.floor(Date.now() / 1000) - 10 });
  const result = await verifyJwt(expired);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'token expired');
});

test('flag off: a malformed token is still rejected', async () => {
  for (const bad of ['', 'a.b', null, undefined, 'x.y.z']) {
    const result = await verifyJwt(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

// ── FLAG ON: native accepted, Supabase untouched ──

test('flag on: a native token verifies and yields a verified identity', async () => {
  const result = await withNativeEnabled(() => verifyJwt(nativeToken()));
  assert.equal(result.ok, true);
  assert.equal(result.verified, true, 'native tokens are cryptographically verified');
  assert.equal(result.authMode, 'verified_native_hs256');
  assert.equal(result.userId, USER.id);
  assert.equal(result.email, 'admin@example.com');
  assert.equal(result.orgId, 'default');
});

test('flag on: legacy Supabase tokens KEEP working (both sources at once)', async () => {
  // This is what makes the cutover safe: during the transition both token kinds
  // are accepted, so enabling the flag cannot lock the owner out.
  const result = await withNativeEnabled(() => verifyJwt(supabaseToken()));
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.authMode, 'verified_hs256');
  assert.equal(result.email, 'legacy@example.com');
});

test('flag on: a forged native token is still refused', async () => {
  const forged = mintAccessToken(USER, { NATIVE_AUTH_ENABLED: 'true', AUTH_JWT_SECRET: 'w'.repeat(48) });
  const result = await withNativeEnabled(() => verifyJwt(forged.token));
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'TOKEN_SIGNATURE_INVALID');
  assert.equal(result.authMode, 'native');
});

test('flag on: an expired native token is refused with a specific reason', async () => {
  const expired = mintAccessToken(
    USER,
    { NATIVE_AUTH_ENABLED: 'true', AUTH_JWT_SECRET: AUTH_SECRET, ACCESS_TOKEN_TTL_SECONDS: '60' },
    Date.now() - 120_000,
  );
  const result = await withNativeEnabled(() => verifyJwt(expired.token));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TOKEN_EXPIRED');
});

test('flag on: a token merely CLAIMING our issuer is refused (routing is not trust)', async () => {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    iss: 'swing-terminal', aud: 'swing-terminal-app', sub: 'attacker', email: 'attacker@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const result = await withNativeEnabled(() => verifyJwt(`${header}.${payload}.forged`));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TOKEN_SIGNATURE_INVALID');
});

// ── downstream authorization keeps working for native identities ──

test('a native identity flows through getIdentity and isAdmin', async () => {
  const req = new Request('https://ctl.example/api/bot/x', {
    headers: { Authorization: `Bearer ${nativeToken()}` },
  });
  const identity = await withNativeEnabled(() => getIdentity(req));
  const resolved = await identity;
  assert.equal(resolved.ok, true);
  assert.equal(resolved.verified, true);
  // BOT_ADMIN_EMAILS is the only admin authority, and it is auth-source-agnostic.
  assert.equal(isAdmin(resolved), true);
});

test('a native identity NOT on the admin allowlist is not admin', async () => {
  const nonAdmin = mintAccessToken(
    { id: 'u-2', email: 'someone@example.com', role: 'admin', token_version: 1 },
    { NATIVE_AUTH_ENABLED: 'true', AUTH_JWT_SECRET: AUTH_SECRET },
  );
  const result = await withNativeEnabled(() => verifyJwt(nonAdmin.token));
  assert.equal(result.ok, true);
  // The token says role:'admin'. That must count for nothing.
  assert.equal(isAdmin(result), false, 'a role claim in a user-held token must never grant admin');
});

// ── decode-only dev mode must not become a native bypass ──

test('AUTH_DECODE_ONLY cannot smuggle an unsigned native token through', async () => {
  process.env.AUTH_DECODE_ONLY = 'true';
  process.env.NATIVE_AUTH_ENABLED = 'true';
  try {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = [
      b64({ alg: 'none', typ: 'JWT' }),
      b64({ iss: 'swing-terminal', aud: 'swing-terminal-app', sub: 'x', email: 'x@y.co', exp: Math.floor(Date.now() / 1000) + 600 }),
      '',
    ].join('.');

    const result = await verifyJwt(unsigned);
    assert.equal(result.ok, false, 'decode-only must never accept an unsigned NATIVE token');
    assert.equal(result.reason, 'TOKEN_ALG_NOT_ALLOWED');
  } finally {
    delete process.env.AUTH_DECODE_ONLY;
    delete process.env.NATIVE_AUTH_ENABLED;
  }
});

test('flag on but AUTH_JWT_SECRET missing: native tokens fail closed', async () => {
  const token = nativeToken();
  const saved = process.env.AUTH_JWT_SECRET;
  process.env.NATIVE_AUTH_ENABLED = 'true';
  delete process.env.AUTH_JWT_SECRET;
  try {
    const result = await verifyJwt(token);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'AUTH_JWT_SECRET_MISSING');
  } finally {
    process.env.AUTH_JWT_SECRET = saved;
    delete process.env.NATIVE_AUTH_ENABLED;
  }
});
