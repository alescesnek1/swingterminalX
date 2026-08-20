// ─────────────────────────────────────────────────────────────
// Deno-edge verifier for the terminal's own (native) access tokens.
//
// This is the edge twin of netlify/functions/_native-jwt.mjs. It exists
// separately because the edge runtime is Deno and cannot rely on
// node:crypto — here HMAC-SHA256 goes through Web Crypto instead.
//
// The two MUST stay byte-compatible: same issuer, same audience, same
// HS256 signing input (`base64url(header).base64url(payload)`), same
// claim checks in the same ORDER. tests/auth.edge-native-jwt.test.mjs
// mints with the Node module and verifies with this one, so a drift
// between them fails the suite rather than silently locking users out
// of half the API.
//
// WHY THIS IS WORTH HAVING: the existing Supabase `verifyAuth` makes a
// network call to Supabase's API on EVERY request just to check a token.
// A native token is verified locally with one HMAC — no upstream
// dependency, no added latency, and no third party in the path of every
// authenticated read.
// ─────────────────────────────────────────────────────────────

export const NATIVE_ISSUER = 'swing-terminal';
export const NATIVE_AUDIENCE = 'swing-terminal-app';
export const MIN_SECRET_LENGTH = 32;

function base64urlToBytes(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64urlToJson(input) {
  try {
    return JSON.parse(new TextDecoder().decode(base64urlToBytes(input)));
  } catch {
    // A malformed segment is not a JSON value — the callers below turn this
    // null into an explicit TOKEN_MALFORMED reason, so it is never mistaken
    // for a valid empty payload.
    // eslint-disable-next-line repo-contract/no-indistinguishable-catch-return -- see above
    return null;
  }
}

/** True only when the native auth path has been explicitly switched on. */
export function nativeAuthEnabled() {
  return Deno.env.get('NATIVE_AUTH_ENABLED') === 'true';
}

/**
 * Read + validate the shared signing secret. Returns `{ ok, secret, reason }`
 * and never puts the secret into a reason string.
 */
export function getSigningSecret() {
  const secret = (Deno.env.get('AUTH_JWT_SECRET') || '').trim();
  if (!secret) return { ok: false, reason: 'AUTH_JWT_SECRET_MISSING' };
  if (secret.length < MIN_SECRET_LENGTH) return { ok: false, reason: 'AUTH_JWT_SECRET_TOO_SHORT' };
  return { ok: true, secret };
}

/**
 * Is this token shaped like one of ours? Used only to DISPATCH between the
 * native and Supabase verifiers. Reads the unverified issuer claim, which is
 * safe because routing is not a trust decision — the chosen verifier then
 * rejects the token on its own terms.
 */
export function looksLikeNativeToken(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payload = base64urlToJson(parts[1]);
  return Boolean(payload && payload.iss === NATIVE_ISSUER);
}

// Constant-time comparison. Web Crypto has no timingSafeEqual, so this is the
// standard accumulate-differences form: it must not early-return on the first
// differing byte, or the comparison leaks the signature prefix.
function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Verify a native access token. Async because Web Crypto is async.
 * Returns `{ ok:true, userId, email, role, tokenVersion, expiresAt }`
 * or `{ ok:false, reason }`. Never throws.
 *
 * Claim checks run only AFTER the signature verifies, so a forged token can
 * never produce a claim-specific error that tells an attacker how far it got.
 */
export async function verifyNativeAccessToken(token, nowMs = Date.now()) {
  if (!nativeAuthEnabled()) return { ok: false, reason: 'NATIVE_AUTH_DISABLED' };

  const secretResult = getSigningSecret();
  if (!secretResult.ok) return secretResult;

  if (typeof token !== 'string') return { ok: false, reason: 'TOKEN_MALFORMED' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'TOKEN_MALFORMED' };
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = base64urlToJson(headerB64);
  // Pin the algorithm: `alg: none` and RS256-confusion must both be refused
  // before any HMAC work happens.
  if (!header || header.alg !== 'HS256') return { ok: false, reason: 'TOKEN_ALG_NOT_ALLOWED' };

  let expected;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secretResult.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signed = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    expected = new Uint8Array(signed);
  } catch (err) {
    // A Web Crypto failure is a runtime/config fault, not a bad token. It must
    // be visible: silently treating it as "signature invalid" would make a
    // broken deploy look like every user suddenly having a bad token.
    console.error('[NATIVE_JWT] HMAC computation failed', { name: err?.name || 'Error' });
    return { ok: false, reason: 'TOKEN_VERIFY_UNAVAILABLE' };
  }

  const provided = base64urlToBytes(signatureB64);
  if (!timingSafeEqualBytes(expected, provided)) {
    return { ok: false, reason: 'TOKEN_SIGNATURE_INVALID' };
  }

  const payload = base64urlToJson(payloadB64);
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'TOKEN_MALFORMED' };

  if (payload.iss !== NATIVE_ISSUER) return { ok: false, reason: 'TOKEN_ISSUER_MISMATCH' };
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(NATIVE_AUDIENCE)) return { ok: false, reason: 'TOKEN_AUDIENCE_MISMATCH' };

  const nowSeconds = Math.floor(nowMs / 1000);

  // Device session (`sxp`, minted at login, 8h by default). Checked BEFORE the
  // access token's own expiry and in the same order as the Node twin: once the
  // absolute deadline passes, no token from that session is accepted anywhere.
  // Absent on tokens minted before the claim existed — those are governed by
  // `exp` alone, exactly as before, so no live session is invalidated by this.
  const sessionExp = Number(payload.sxp);
  const hasSession = Number.isFinite(sessionExp);
  if (hasSession && nowSeconds >= sessionExp) return { ok: false, reason: 'SESSION_EXPIRED' };

  const exp = Number(payload.exp);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'TOKEN_EXP_MISSING' };
  if (nowSeconds >= exp) return { ok: false, reason: 'TOKEN_EXPIRED' };

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
    sessionId: typeof payload.sid === 'string' && payload.sid ? payload.sid : null,
    sessionExpiresAt: hasSession ? new Date(sessionExp * 1000).toISOString() : null,
  };
}
