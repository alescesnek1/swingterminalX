// Tests for the native access token (netlify/functions/_native-jwt.mjs).
//
// A token verifier is a security boundary, so the negative cases carry the
// weight here: alg confusion, `alg: none`, a swapped signature, a tampered
// payload, a wrong secret, an expired token, and — importantly — that the whole
// path stays shut when NATIVE_AUTH_ENABLED is not explicitly 'true'.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  mintAccessToken,
  verifyAccessToken,
  looksLikeNativeToken,
  getSigningSecret,
  nativeAuthEnabled,
  accessTtlSeconds,
  NATIVE_ISSUER,
  NATIVE_AUDIENCE,
  DEFAULT_ACCESS_TTL_SECONDS,
  MIN_SECRET_LENGTH,
} from '../netlify/functions/_native-jwt.mjs';

const SECRET = 'a'.repeat(48);
const ENV = { NATIVE_AUTH_ENABLED: 'true', AUTH_JWT_SECRET: SECRET };
const USER = { id: '11111111-2222-3333-4444-555555555555', email: 'Owner@Example.com', role: 'admin', token_version: 3 };

function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

// ── minting ──

test('a minted token verifies and carries the expected claims', () => {
  const minted = mintAccessToken(USER, ENV);
  assert.equal(minted.ok, true);

  const verified = verifyAccessToken(minted.token, ENV);
  assert.equal(verified.ok, true);
  assert.equal(verified.userId, USER.id);
  assert.equal(verified.email, 'owner@example.com', 'email must be normalized to lowercase');
  assert.equal(verified.role, 'admin');
  assert.equal(verified.tokenVersion, 3);
});

test('claims use the pinned issuer/audience and a bounded lifetime', () => {
  const now = 1_800_000_000_000;
  const minted = mintAccessToken(USER, ENV, now);
  const payload = decodePayload(minted.token);
  assert.equal(payload.iss, NATIVE_ISSUER);
  assert.equal(payload.aud, NATIVE_AUDIENCE);
  assert.equal(payload.iat, Math.floor(now / 1000));
  assert.equal(payload.exp, Math.floor(now / 1000) + DEFAULT_ACCESS_TTL_SECONDS);
  assert.equal(minted.expiresInSeconds, DEFAULT_ACCESS_TTL_SECONDS);
});

test('no password, hash, or secret is ever embedded in a token', () => {
  const minted = mintAccessToken({ ...USER, password_hash: 'scrypt$N=1$aa$bb' }, ENV);
  assert.ok(!minted.token.includes(SECRET));
  const payload = decodePayload(minted.token);
  assert.equal(payload.password_hash, undefined);
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['aud', 'email', 'exp', 'iat', 'iss', 'jti', 'role', 'sub', 'tv'],
    'the claim set is deliberately fixed — a new claim must be a conscious change',
  );
});

test('two tokens for the same user are distinct (jti)', () => {
  const a = mintAccessToken(USER, ENV, 1_800_000_000_000);
  const b = mintAccessToken(USER, ENV, 1_800_000_000_000);
  assert.notEqual(a.token, b.token);
});

test('an unknown role is never promoted to admin', () => {
  for (const role of ['ADMIN', 'superuser', '', null, undefined, 'Admin']) {
    const minted = mintAccessToken({ ...USER, role }, ENV);
    assert.equal(decodePayload(minted.token).role, 'user', `role=${String(role)} must not become admin`);
  }
});

test('minting refuses an incomplete user', () => {
  assert.equal(mintAccessToken(null, ENV).reason, 'USER_REQUIRED');
  assert.equal(mintAccessToken({ email: 'a@b.co' }, ENV).reason, 'USER_ID_REQUIRED');
  assert.equal(mintAccessToken({ id: 'x' }, ENV).reason, 'USER_EMAIL_REQUIRED');
});

// ── the secret ──

test('a missing or short secret is refused, and never echoed back', () => {
  assert.equal(getSigningSecret({}).reason, 'AUTH_JWT_SECRET_MISSING');
  assert.equal(getSigningSecret({ AUTH_JWT_SECRET: '   ' }).reason, 'AUTH_JWT_SECRET_MISSING');

  const short = 'b'.repeat(MIN_SECRET_LENGTH - 1);
  const result = getSigningSecret({ AUTH_JWT_SECRET: short });
  assert.equal(result.reason, 'AUTH_JWT_SECRET_TOO_SHORT');
  assert.ok(!JSON.stringify(result).includes(short), 'the reason must not leak the secret');
});

test('minting and verifying both fail closed without a usable secret', () => {
  assert.equal(mintAccessToken(USER, { NATIVE_AUTH_ENABLED: 'true' }).ok, false);
  const minted = mintAccessToken(USER, ENV);
  assert.equal(verifyAccessToken(minted.token, { NATIVE_AUTH_ENABLED: 'true' }).ok, false);
});

// ── the enable flag ──

test('verification is refused unless NATIVE_AUTH_ENABLED is exactly "true"', () => {
  const minted = mintAccessToken(USER, ENV);
  for (const flag of [undefined, '', 'false', 'TRUE', '1', 'yes', 'True']) {
    const env = { AUTH_JWT_SECRET: SECRET, NATIVE_AUTH_ENABLED: flag };
    assert.equal(nativeAuthEnabled(env), false, `flag=${String(flag)} must not enable native auth`);
    const result = verifyAccessToken(minted.token, env);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NATIVE_AUTH_DISABLED');
  }
});

// ── forgery ──

test('a tampered payload is rejected', () => {
  const minted = mintAccessToken({ ...USER, role: 'user' }, ENV);
  const [h, p, s] = minted.token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  payload.role = 'admin';
  payload.email = 'attacker@example.com';
  const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;

  const result = verifyAccessToken(forged, ENV);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TOKEN_SIGNATURE_INVALID');
});

test('alg: none is rejected', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: NATIVE_ISSUER, aud: NATIVE_AUDIENCE, sub: USER.id, email: USER.email,
    exp: Math.floor(Date.now() / 1000) + 600,
  })).toString('base64url');

  for (const sig of ['', 'x', 'anything']) {
    const result = verifyAccessToken(`${header}.${payload}.${sig}`, ENV);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'TOKEN_ALG_NOT_ALLOWED');
  }
});

test('an algorithm other than HS256 is rejected even with a valid HMAC', () => {
  // Alg confusion: a token that claims RS256 but is actually HMAC-signed with
  // the shared secret must not be accepted just because the bytes check out.
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: NATIVE_ISSUER, aud: NATIVE_AUDIENCE, sub: USER.id, email: USER.email,
    exp: Math.floor(Date.now() / 1000) + 600,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');

  const result = verifyAccessToken(`${header}.${payload}.${sig}`, ENV);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TOKEN_ALG_NOT_ALLOWED');
});

test('a token signed with a different secret is rejected', () => {
  const minted = mintAccessToken(USER, { ...ENV, AUTH_JWT_SECRET: 'z'.repeat(48) });
  const result = verifyAccessToken(minted.token, ENV);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TOKEN_SIGNATURE_INVALID');
});

test('rotating AUTH_JWT_SECRET invalidates every outstanding token at once', () => {
  // This is the documented emergency-revocation lever, so it needs coverage.
  const minted = mintAccessToken(USER, ENV);
  assert.equal(verifyAccessToken(minted.token, ENV).ok, true);
  const rotated = { ...ENV, AUTH_JWT_SECRET: 'r'.repeat(48) };
  assert.equal(verifyAccessToken(minted.token, rotated).ok, false);
});

test('the signature is checked BEFORE any claim is believed', () => {
  // A forged token with a wrong issuer AND a bad signature must report the
  // signature failure — otherwise the error message tells an attacker their
  // forgery was structurally accepted and only a claim was off.
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'evil', aud: 'evil', sub: '', exp: 1,
  })).toString('base64url');
  const result = verifyAccessToken(`${header}.${payload}.badsignature`, ENV);
  assert.equal(result.reason, 'TOKEN_SIGNATURE_INVALID');
});

test('malformed tokens are rejected without throwing', () => {
  for (const bad of ['', 'a', 'a.b', 'a.b.c.d', null, undefined, 42, {}, 'not.base64url.at!!all']) {
    const result = verifyAccessToken(bad, ENV);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

// ── expiry ──

test('an expired token is rejected', () => {
  const now = 1_800_000_000_000;
  const minted = mintAccessToken(USER, ENV, now);
  const afterExpiry = now + (DEFAULT_ACCESS_TTL_SECONDS + 1) * 1000;
  const result = verifyAccessToken(minted.token, ENV, afterExpiry);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TOKEN_EXPIRED');
});

test('a token is rejected exactly AT its expiry second, not one later', () => {
  const now = 1_800_000_000_000;
  const minted = mintAccessToken(USER, ENV, now);
  const atExpiry = now + DEFAULT_ACCESS_TTL_SECONDS * 1000;
  assert.equal(verifyAccessToken(minted.token, ENV, atExpiry).reason, 'TOKEN_EXPIRED');
  assert.equal(verifyAccessToken(minted.token, ENV, atExpiry - 1000).ok, true);
});

test('the TTL is clamped to a sane window', () => {
  assert.equal(accessTtlSeconds({ ACCESS_TOKEN_TTL_SECONDS: '1' }), 60, 'a 1s token would make the app unusable');
  assert.equal(accessTtlSeconds({ ACCESS_TOKEN_TTL_SECONDS: '999999' }), 24 * 60 * 60, 'a multi-day token defeats revocation');
  assert.equal(accessTtlSeconds({ ACCESS_TOKEN_TTL_SECONDS: 'nonsense' }), DEFAULT_ACCESS_TTL_SECONDS);
  assert.equal(accessTtlSeconds({}), DEFAULT_ACCESS_TTL_SECONDS);
  assert.equal(accessTtlSeconds({ ACCESS_TOKEN_TTL_SECONDS: '900' }), 900);
});

// ── dispatch helper ──

test('looksLikeNativeToken identifies our tokens and rejects others', () => {
  const minted = mintAccessToken(USER, ENV);
  assert.equal(looksLikeNativeToken(minted.token), true);

  // A Supabase-shaped token must NOT be claimed by the native verifier.
  const supabaseish = [
    Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ iss: 'https://x.supabase.co/auth/v1', sub: 'u' })).toString('base64url'),
    'sig',
  ].join('.');
  assert.equal(looksLikeNativeToken(supabaseish), false);

  for (const bad of ['', 'a.b', null, undefined, 'a.!!!.c']) {
    assert.equal(looksLikeNativeToken(bad), false);
  }
});

test('dispatch is not a security decision: a fake native issuer still fails verification', () => {
  // Anyone can put iss:'swing-terminal' in an unsigned token to get routed to our
  // verifier. Routing must not imply trust.
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: NATIVE_ISSUER, aud: NATIVE_AUDIENCE, sub: 'attacker', email: 'a@b.co',
    exp: Math.floor(Date.now() / 1000) + 600,
  })).toString('base64url');
  const forged = `${header}.${payload}.forged`;

  assert.equal(looksLikeNativeToken(forged), true, 'it does get routed to us');
  assert.equal(verifyAccessToken(forged, ENV).ok, false, 'and we reject it');
});
