// Cross-runtime compatibility: the Deno-edge native token verifier
// (apps/edge/netlify/edge-functions/lib/native-jwt.js) must accept exactly what
// the Node minter (netlify/functions/_native-jwt.mjs) produces, and reject
// exactly what the Node verifier rejects.
//
// WHY THIS FILE MATTERS: there are two independent implementations of the same
// HS256 check, in two runtimes, because the edge cannot use node:crypto. A drift
// between them would not be a clean failure — half the API (Node functions)
// would accept a token while the other half (edge functions) refused it, and the
// terminal would look randomly broken. So every token here is minted by the Node
// module and verified by the edge one.
//
// The edge module reads Deno.env at CALL time (never at import time), so a Deno
// shim installed before the calls is enough to exercise it under node:test.
// Web Crypto (crypto.subtle), atob, TextEncoder/TextDecoder are all present in
// Node 22+, so no other shim is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mintAccessToken, NATIVE_ISSUER, NATIVE_AUDIENCE } from '../netlify/functions/_native-jwt.mjs';

const SECRET = 'e'.repeat(48);
const NOW = 1_800_000_000_000;
const USER = { id: '11111111-2222-3333-4444-555555555555', email: 'Owner@Example.com', role: 'admin', token_version: 7 };

// Install the Deno shim BEFORE importing the edge module so nothing observes a
// missing global. Values are swapped per test via `denoEnv`.
let denoEnv = { NATIVE_AUTH_ENABLED: 'true', AUTH_JWT_SECRET: SECRET };
globalThis.Deno = { env: { get: (key) => denoEnv[key] } };

const edge = await import('../apps/edge/netlify/edge-functions/lib/native-jwt.js');

function nodeEnv(over = {}) {
  return { NATIVE_AUTH_ENABLED: 'true', AUTH_JWT_SECRET: SECRET, ...over };
}

function mint(over = {}, env = nodeEnv()) {
  const result = mintAccessToken({ ...USER, ...over }, env, NOW);
  assert.equal(result.ok, true, `minting failed: ${result.reason}`);
  return result.token;
}

test('the two implementations agree on the shared contract constants', () => {
  // If these ever diverge, every token silently fails audience/issuer checks on
  // one side only.
  assert.equal(edge.NATIVE_ISSUER, NATIVE_ISSUER);
  assert.equal(edge.NATIVE_AUDIENCE, NATIVE_AUDIENCE);
  assert.equal(edge.MIN_SECRET_LENGTH, 32);
});

test('a Node-minted token verifies on the edge with identical claims', async () => {
  const token = mint();
  const result = await edge.verifyNativeAccessToken(token, NOW);
  assert.equal(result.ok, true, `edge rejected a valid token: ${result.reason}`);
  assert.equal(result.userId, USER.id);
  assert.equal(result.email, 'owner@example.com');
  assert.equal(result.role, 'admin');
  assert.equal(result.tokenVersion, 7);
});

test('edge dispatch recognizes a Node-minted token', () => {
  assert.equal(edge.looksLikeNativeToken(mint()), true);
  // A Supabase-shaped token must not be claimed by the native verifier.
  const supabaseish = [
    Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ iss: 'https://x.supabase.co/auth/v1', sub: 'u' })).toString('base64url'),
    'sig',
  ].join('.');
  assert.equal(edge.looksLikeNativeToken(supabaseish), false);
  for (const bad of ['', 'a.b', null, undefined, 'a.!!!.c']) {
    assert.equal(edge.looksLikeNativeToken(bad), false);
  }
});

// ── the edge must refuse everything the Node side refuses ──

test('the edge rejects a token signed with a different secret', async () => {
  const foreign = mint({}, nodeEnv({ AUTH_JWT_SECRET: 'z'.repeat(48) }));
  const result = await edge.verifyNativeAccessToken(foreign, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TOKEN_SIGNATURE_INVALID');
});

test('the edge rejects a tampered payload', async () => {
  const [h, p, s] = mint({ role: 'user' }).split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  payload.role = 'admin';
  const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
  const result = await edge.verifyNativeAccessToken(forged, NOW);
  assert.equal(result.reason, 'TOKEN_SIGNATURE_INVALID');
});

test('the edge rejects alg: none and alg confusion', async () => {
  const header = (alg) => Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: NATIVE_ISSUER, aud: NATIVE_AUDIENCE, sub: USER.id, email: 'a@b.co',
    exp: Math.floor(NOW / 1000) + 600,
  })).toString('base64url');

  for (const alg of ['none', 'RS256', 'HS512', '']) {
    const result = await edge.verifyNativeAccessToken(`${header(alg)}.${payload}.whatever`, NOW);
    assert.equal(result.ok, false, `alg=${alg} must be refused`);
    assert.equal(result.reason, 'TOKEN_ALG_NOT_ALLOWED');
  }
});

test('the edge rejects an expired token, at the exact expiry second', async () => {
  const token = mint();
  const atExpiry = NOW + 3600 * 1000;
  assert.equal((await edge.verifyNativeAccessToken(token, atExpiry)).reason, 'TOKEN_EXPIRED');
  assert.equal((await edge.verifyNativeAccessToken(token, atExpiry - 1000)).ok, true);
});

test('the edge rejects malformed tokens without throwing', async () => {
  for (const bad of ['', 'a', 'a.b', 'a.b.c.d', null, undefined, 42, 'not.base64url.at!!all']) {
    const result = await edge.verifyNativeAccessToken(bad, NOW);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('the edge rejects a wrong issuer or audience', async () => {
  // Signed correctly, but not for this app — must still fail.
  const crypto = await import('node:crypto');
  const sign = (headerB64, payloadB64) => crypto.default
    .createHmac('sha256', SECRET).update(`${headerB64}.${payloadB64}`).digest('base64url');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

  const wrongIss = Buffer.from(JSON.stringify({
    iss: 'someone-else', aud: NATIVE_AUDIENCE, sub: 'u', email: 'a@b.co', exp: Math.floor(NOW / 1000) + 600,
  })).toString('base64url');
  assert.equal(
    (await edge.verifyNativeAccessToken(`${header}.${wrongIss}.${sign(header, wrongIss)}`, NOW)).reason,
    'TOKEN_ISSUER_MISMATCH',
  );

  const wrongAud = Buffer.from(JSON.stringify({
    iss: NATIVE_ISSUER, aud: 'another-app', sub: 'u', email: 'a@b.co', exp: Math.floor(NOW / 1000) + 600,
  })).toString('base64url');
  assert.equal(
    (await edge.verifyNativeAccessToken(`${header}.${wrongAud}.${sign(header, wrongAud)}`, NOW)).reason,
    'TOKEN_AUDIENCE_MISMATCH',
  );
});

// ── configuration gates, edge side ──

test('the edge refuses native tokens unless NATIVE_AUTH_ENABLED is exactly "true"', async () => {
  const token = mint();
  const original = denoEnv;
  try {
    for (const flag of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      denoEnv = { NATIVE_AUTH_ENABLED: flag, AUTH_JWT_SECRET: SECRET };
      assert.equal(edge.nativeAuthEnabled(), false, `flag=${String(flag)} must not enable native auth`);
      const result = await edge.verifyNativeAccessToken(token, NOW);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'NATIVE_AUTH_DISABLED');
    }
  } finally {
    denoEnv = original;
  }
});

test('the edge refuses a missing or short secret without echoing it', async () => {
  const token = mint();
  const original = denoEnv;
  try {
    denoEnv = { NATIVE_AUTH_ENABLED: 'true' };
    assert.equal((await edge.verifyNativeAccessToken(token, NOW)).reason, 'AUTH_JWT_SECRET_MISSING');

    const short = 'q'.repeat(31);
    denoEnv = { NATIVE_AUTH_ENABLED: 'true', AUTH_JWT_SECRET: short };
    const result = await edge.verifyNativeAccessToken(token, NOW);
    assert.equal(result.reason, 'AUTH_JWT_SECRET_TOO_SHORT');
    assert.ok(!JSON.stringify(result).includes(short));
  } finally {
    denoEnv = original;
  }
});

test('a secret that differs between runtimes fails closed, it does not half-work', async () => {
  // The realistic misconfiguration: AUTH_JWT_SECRET set for Node functions but
  // not (or differently) for the edge. The token must be refused, never
  // partially trusted.
  const token = mint();
  const original = denoEnv;
  try {
    denoEnv = { NATIVE_AUTH_ENABLED: 'true', AUTH_JWT_SECRET: 'd'.repeat(48) };
    const result = await edge.verifyNativeAccessToken(token, NOW);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'TOKEN_SIGNATURE_INVALID');
  } finally {
    denoEnv = original;
  }
});

// ── the constant-time comparison must not early-return ──

test('signature comparison does not short-circuit on length or first byte', async () => {
  const token = mint();
  const [h, p, s] = token.split('.');

  // Truncated signature (length mismatch) and a signature differing only in the
  // LAST byte must both be refused. The latter is what an early-return
  // implementation would still get right, but it pins the behaviour.
  assert.equal((await edge.verifyNativeAccessToken(`${h}.${p}.${s.slice(0, -4)}`, NOW)).reason, 'TOKEN_SIGNATURE_INVALID');
  const flipped = s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
  assert.equal((await edge.verifyNativeAccessToken(`${h}.${p}.${flipped}`, NOW)).reason, 'TOKEN_SIGNATURE_INVALID');
});
