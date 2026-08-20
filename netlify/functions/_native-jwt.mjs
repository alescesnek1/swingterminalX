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
//
// ── Device sessions (`sid` / `sxp`) ──
// A login opens a DEVICE SESSION with an ABSOLUTE deadline (`sxp`, default 8h)
// carried inside the claims. Access tokens stay short (`exp`, default 60 min)
// and are re-minted by the refresh endpoint, which carries the SAME `sid`/`sxp`
// forward — a refresh can never push the deadline out. So:
//   • a page reload inside the 8h window never asks for a password again, even
//     if the access token expired while the tab was closed (refresh accepts an
//     expired-but-signed token — see verifyRefreshableToken);
//   • 8h after signing in, every path refuses the session and the user logs in
//     again, on that device only;
//   • a stolen access token is still useless for API calls after `exp` (≤60 min)
//     because request-path verification (verifyAccessToken) never tolerates an
//     expired token, and it cannot outlive `sxp` at the refresh endpoint either.
// Tokens minted before this claim existed have no `sxp`. They keep verifying
// until their `exp` and are simply NOT refreshable past it — the user logs in
// once and gets a session-bearing token. No migration, no forced logout.
import crypto from 'node:crypto';

export const NATIVE_ISSUER = 'swing-terminal';
export const NATIVE_AUDIENCE = 'swing-terminal-app';
export const DEFAULT_ACCESS_TTL_SECONDS = 60 * 60;
// 8 hours: one working day of a terminal that is refreshed constantly, without
// a token that stays useful overnight on a device someone else can reach.
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
// A device session may not outlive a week even if an operator asks for more —
// past that the "log in per device" property stops meaning anything.
export const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

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

/**
 * Read a numeric env var, or NaN when it is absent/blank. Written out because
 * `Number('')` and `Number(null)` are 0, not NaN — reading a blank
 * ACCESS_TOKEN_TTL_SECONDS as 0 would clamp to 60-second tokens, and a blank
 * SESSION_TTL_SECONDS as 0 would end every session immediately. A blank setting
 * must mean "unset", never "the smallest allowed value".
 */
function numericSetting(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'string' && !value.trim()) return NaN;
  return Number(value);
}

export function accessTtlSeconds(env = process.env) {
  const raw = numericSetting(env.ACCESS_TOKEN_TTL_SECONDS);
  if (!Number.isFinite(raw)) return DEFAULT_ACCESS_TTL_SECONDS;
  // Clamped: a 10-second token makes the terminal unusable, and a multi-day one
  // defeats the revocation model above.
  return Math.min(Math.max(Math.trunc(raw), 60), 24 * 60 * 60);
}

/**
 * How long a device session may live from the moment of LOGIN. Never shorter
 * than one access token (a session that ends before its first refresh would
 * make the terminal unusable) and never longer than a week.
 */
export function sessionTtlSeconds(env = process.env) {
  const accessTtl = accessTtlSeconds(env);
  const raw = numericSetting(env.SESSION_TTL_SECONDS);
  if (!Number.isFinite(raw)) return Math.max(DEFAULT_SESSION_TTL_SECONDS, accessTtl);
  return Math.min(Math.max(Math.trunc(raw), accessTtl), MAX_SESSION_TTL_SECONDS);
}

/**
 * Read a session descriptor (`{ sessionId, sessionExpiresAtSeconds }`) that a
 * refresh wants carried forward. Returns null when it is absent or unusable, in
 * which case the caller mints a NEW session rather than silently inventing a
 * deadline — a missing session must never become a longer one.
 */
function readCarriedSession(session) {
  if (!session || typeof session !== 'object') return null;
  const sid = typeof session.sessionId === 'string' ? session.sessionId.trim() : '';
  const sxp = Number(session.sessionExpiresAtSeconds);
  if (!sid || !Number.isFinite(sxp)) return null;
  return { sid, sxp: Math.trunc(sxp) };
}

function sign(signingInput, secret) {
  return crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
}

/**
 * Mint an access token for a user row.
 *
 * `session` is optional. Omitted (login), it OPENS a new device session whose
 * absolute deadline is `now + sessionTtlSeconds()`. Passed (refresh), the given
 * `{ sessionId, sessionExpiresAtSeconds }` is carried forward unchanged, so
 * refreshing can never extend the window.
 *
 * Returns `{ ok:true, token, expiresAt, expiresInSeconds, sessionId,
 * sessionExpiresAt }` or `{ ok:false, reason }`.
 */
export function mintAccessToken(user, env = process.env, nowMs = Date.now(), session = null) {
  const secretResult = getSigningSecret(env);
  if (!secretResult.ok) return secretResult;

  if (!user || typeof user !== 'object') return { ok: false, reason: 'USER_REQUIRED' };
  const sub = typeof user.id === 'string' ? user.id.trim() : '';
  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  if (!sub) return { ok: false, reason: 'USER_ID_REQUIRED' };
  if (!email) return { ok: false, reason: 'USER_EMAIL_REQUIRED' };

  const iat = Math.floor(nowMs / 1000);

  const carried = readCarriedSession(session);
  const sid = carried ? carried.sid : crypto.randomBytes(12).toString('base64url');
  const sxp = carried ? carried.sxp : iat + sessionTtlSeconds(env);
  // A session that has already ended must never produce a token, however the
  // caller got here. This is the last line of defence behind the refresh
  // endpoint's own check.
  if (iat >= sxp) return { ok: false, reason: 'SESSION_EXPIRED' };

  // The access token may not outlive its session: `exp` is capped at `sxp`, so
  // the stateless request path alone already stops a token past the deadline
  // even without reading `sxp`.
  const exp = Math.min(iat + accessTtlSeconds(env), sxp);
  const ttl = exp - iat;

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
    // Device session: `sid` identifies it (audit / future per-device revocation),
    // `sxp` is its absolute deadline in unix seconds.
    sid,
    sxp,
    iat,
    exp,
    jti: crypto.randomBytes(12).toString('base64url'),
  };

  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const token = `${signingInput}.${sign(signingInput, secretResult.secret)}`;

  return {
    ok: true,
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
    expiresInSeconds: ttl,
    sessionId: sid,
    sessionExpiresAt: new Date(sxp * 1000).toISOString(),
    sessionExpiresInSeconds: sxp - iat,
  };
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
  return verifyToken(token, env, nowMs, false);
}

/**
 * Verify a token for the REFRESH endpoint only.
 *
 * Identical to verifyAccessToken except that an expired `exp` is tolerated while
 * the token's device session (`sxp`) is still open. That is what lets a page
 * reload after the access token lapsed re-mint silently instead of bouncing the
 * user to the login gate — and it is safe because:
 *   • the signature, issuer, audience and algorithm are checked exactly as
 *     strictly as on the request path;
 *   • the tolerance is bounded by `sxp`, which a refresh cannot extend;
 *   • the refresh endpoint additionally re-reads the account from the database
 *     (status + token_version), so a disabled account or a changed password
 *     still ends the session here;
 *   • the token it accepts is NOT accepted anywhere else — every API path calls
 *     verifyAccessToken, which refuses it.
 * A legacy token with no `sxp` gets no tolerance at all.
 *
 * Returns the same shape, plus `expired:true` when the tolerance was used.
 */
export function verifyRefreshableToken(token, env = process.env, nowMs = Date.now()) {
  return verifyToken(token, env, nowMs, true);
}

function verifyToken(token, env, nowMs, allowExpiredWithinSession) {
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

  const nowSeconds = Math.floor(nowMs / 1000);

  // The device session is checked BEFORE the access token's own expiry: once the
  // absolute deadline has passed the token is dead everywhere, and saying
  // SESSION_EXPIRED (rather than TOKEN_EXPIRED) is what tells the browser to
  // stop refreshing and show the login form.
  const sessionExp = Number(payload.sxp);
  const hasSession = Number.isFinite(sessionExp);
  if (hasSession && nowSeconds >= sessionExp) return { ok: false, reason: 'SESSION_EXPIRED' };

  const exp = Number(payload.exp);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'TOKEN_EXP_MISSING' };
  const expired = nowSeconds >= exp;
  // Tolerated only at the refresh endpoint, and only inside a live session.
  if (expired && !(allowExpiredWithinSession && hasSession)) {
    return { ok: false, reason: 'TOKEN_EXPIRED' };
  }

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
    expired,
    // Null for a pre-session (legacy) token, so a caller can tell "no session
    // window recorded" apart from "session window still open" instead of
    // inferring one that was never issued.
    sessionId: typeof payload.sid === 'string' && payload.sid ? payload.sid : null,
    sessionExpiresAtSeconds: hasSession ? sessionExp : null,
    sessionExpiresAt: hasSession ? new Date(sessionExp * 1000).toISOString() : null,
  };
}
