// Mint + verify the terminal's OWN access tokens (native auth path).
//
// HS256 over a single shared secret (AUTH_JWT_SECRET). Symmetric is the right
// choice here: the only issuer is this repo's own login function, and the two
// verifiers (Node functions and the Deno edge) are both first-party. Asymmetric
// keys would add JWKS hosting and rotation machinery for no gain.
//
// The Deno edge has its own verifier
// (apps/edge/netlify/edge-functions/lib/native-jwt.js) because it cannot import
// node:crypto reliably. The two MUST stay byte-compatible; the shared claim
// contract is documented here and asserted from both sides in
// tests/auth.native-jwt.test.mjs.
//
// ── Revocation model (deliberate, documented tradeoff) ──
// Verification is STATELESS: no database read on the request hot path. That
// keeps auth working when the DB is unreachable, and keeps the trading control
// plane from acquiring a new hard dependency. The cost is that a token stays
// valid until it expires, so:
//   • Access tokens are SHORT-lived (60 min default, ACCESS_TOKEN_TTL_SECONDS).
//   • The browser silently re-mints via the refresh endpoint, and refresh IS
//     database-checked (status + token_version). So disabling an account or
//     resetting a password takes effect at the next refresh — within one TTL.
//   • For IMMEDIATE global revocation, rotate AUTH_JWT_SECRET: every outstanding
//     token stops verifying at once.
// `tv` (token_version) is carried in the claims so refresh can compare it
// against the row. It is intentionally NOT enforced on stateless verification —
// doing so would require the DB read this design exists to avoid.
import crypto from 'node:crypto';

export const NATIVE_ISSUER = 'swing-terminal';
export const NATIVE_AUDIENCE = 'swing-terminal-app';
export const DEFAULT_ACCESS_TTL_SECONDS = 60 * 60;

// A secret shorter than the HMAC block size weakens HS256 for no reason. 32
// bytes of real entropy is the floor, enforced rather than advised.
export const MIN_SECRET_LENGTH = 32;

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

/**
 * Read + validate the signing secret. Returns `{ ok:true, secret }` or
 * `{ ok:false, reason }` — never throws, and never returns the secret in a
 * reason string.
 */
export function getSigningSecret(env = process.env) {
  const secret = typeof env.AUTH_JWT_SECRET === 'string' ? env.AUTH_JWT_SECRET.trim() : '';
  if (!secret) return { ok: false, reason: 'AUTH_JWT_SECRET_MISSING' };
  if (secret.length < MIN_SECRET_LENGTH) return { ok: false, reason: 'AUTH_JWT_SECRET_TOO_SHORT' };
  return { ok: true, secret };
}

/** True only when the native auth path has been explicitly switched on. */
export function nativeAuthEnabled(env = process.env) {
  return env.NATIVE_AUTH_ENABLED === 'true';
}

export function accessTtlSeconds(env = process.env) {
  const raw = Number(env.ACCESS_TOKEN_TTL_SECONDS);
  if (!Number.isFinite(raw)) return DEFAULT_ACCESS_TTL_SECONDS;
  // Clamped: a 10-second token makes the terminal unusable, and a multi-day one
  // defeats the revocation model above.
  return Math.min(Math.max(Math.trunc(raw), 60), 24 * 60 * 60);
}

function sign(signingInput, secret) {
  return crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
}

/**
 * Mint an access token for a user row.
 * Returns `{ ok:true, token, expiresAt, expiresInSeconds }` or `{ ok:false, reason }`.
 */
export function mintAccessToken(user, env = process.env, nowMs = Date.now()) {
  const secretResult = getSigningSecret(env);
  if (!secretResult.ok) return secretResult;

  if (!user || typeof user !== 'object') return { ok: false, reason: 'USER_REQUIRED' };
  const sub = typeof user.id === 'string' ? user.id.trim() : '';
  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  if (!sub) return { ok: false, reason: 'USER_ID_REQUIRED' };
  if (!email) return { ok: false, reason: 'USER_EMAIL_REQUIRED' };

  const ttl = accessTtlSeconds(env);
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttl;

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: NATIVE_ISSUER,
    aud: NATIVE_AUDIENCE,
    sub,
    email,
    // Informational only. Authorization comes from BOT_ADMIN_EMAILS server-side
    // (see _auth.mjs isAdmin) — a claim in a token the user holds must never be
    // what grants them admin.
    role: user.role === 'admin' ? 'admin' : 'user',
    tv: Number.isInteger(user.token_version) ? user.token_version : 1,
    iat,
    exp,
    jti: crypto.randomBytes(12).toString('base64url'),
  };

  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const token = `${signingInput}.${sign(signingInput, secretResult.secret)}`;

  return { ok: true, token, expiresAt: new Date(exp * 1000).toISOString(), expiresInSeconds: ttl };
}

/**
 * Is this token shaped like one of ours? Used to DISPATCH between the native and
 * Supabase verifiers without trusting anything. Reads the unverified issuer
 * claim only — routing to a verifier is not a security decision, and the chosen
 * verifier then rejects the token on its own terms.
 */
export function looksLikeNativeToken(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && payload.iss === NATIVE_ISSUER;
  } catch {
    // Routing predicate, not a verdict on the token: an unparseable payload is
    // genuinely "not one of ours", and the caller's only use of false is to hand
    // the token to the Supabase verifier instead. `false` can never be mistaken
    // for data here, and the token is fully verified afterwards either way.
    // eslint-disable-next-line repo-contract/no-indistinguishable-catch-return -- see above
    return false;
  }
}

/**
 * Verify a native access token.
 * Returns `{ ok:true, userId, email, role, tokenVersion, expiresAt }`
 * or `{ ok:false, reason }`. Never throws.
 *
 * Order matters: the SIGNATURE is checked before any claim is believed, so a
 * forged token can never produce a claim-specific error message that tells an
 * attacker how far they got.
 */
export function verifyAccessToken(token, env = process.env, nowMs = Date.now()) {
  if (!nativeAuthEnabled(env)) return { ok: false, reason: 'NATIVE_AUTH_DISABLED' };

  const secretResult = getSigningSecret(env);
  if (!secretResult.ok) return secretResult;

  if (typeof token !== 'string') return { ok: false, reason: 'TOKEN_MALFORMED' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'TOKEN_MALFORMED' };
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'TOKEN_MALFORMED' };
  }
  // Pin the algorithm. Accepting whatever the token asks for is the classic
  // alg-confusion hole, and `alg: "none"` must never be honoured.
  if (!header || header.alg !== 'HS256') return { ok: false, reason: 'TOKEN_ALG_NOT_ALLOWED' };

  const expected = Buffer.from(sign(`${headerB64}.${payloadB64}`, secretResult.secret), 'utf8');
  const provided = Buffer.from(signatureB64, 'utf8');
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'TOKEN_SIGNATURE_INVALID' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'TOKEN_MALFORMED' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'TOKEN_MALFORMED' };

  if (payload.iss !== NATIVE_ISSUER) return { ok: false, reason: 'TOKEN_ISSUER_MISMATCH' };
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(NATIVE_AUDIENCE)) return { ok: false, reason: 'TOKEN_AUDIENCE_MISMATCH' };

  const exp = Number(payload.exp);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'TOKEN_EXP_MISSING' };
  if (Math.floor(nowMs / 1000) >= exp) return { ok: false, reason: 'TOKEN_EXPIRED' };

  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (!sub) return { ok: false, reason: 'TOKEN_SUBJECT_MISSING' };
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email) return { ok: false, reason: 'TOKEN_EMAIL_MISSING' };

  return {
    ok: true,
    userId: sub,
    email,
    role: payload.role === 'admin' ? 'admin' : 'user',
    tokenVersion: Number.isInteger(payload.tv) ? payload.tv : 1,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}
