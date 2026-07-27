// Re-mint an access token from a still-valid one.
//
// This endpoint is the whole reason stateless verification is acceptable
// elsewhere. Normal request verification does NO database read, so a disabled
// account would otherwise keep working until its token expired with nothing able
// to stop it. Refresh is the one place that checks the database:
//
//   • account still exists          → else refuse
//   • status is still 'active'      → else refuse
//   • token_version still matches   → else refuse
//
// `token_version` is bumped by setPassword() and setStatus(), so disabling an
// account or resetting a password causes the user's next refresh to fail. With a
// 60-minute access token that means they are out within an hour, without putting
// a database dependency on every authenticated request. For IMMEDIATE global
// revocation the lever is rotating AUTH_JWT_SECRET.
//
// A refresh NEVER accepts a password and never extends an already-expired token:
// once a token is past `exp`, the user logs in again.
import { mintAccessToken, nativeAuthEnabled, getSigningSecret, verifyAccessToken } from './_native-jwt.mjs';
import { findById, writeAudit } from './_user-store.mjs';

function headers(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin, Authorization',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  };
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(req) });
}

function bearerToken(req) {
  const header = req.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

export async function runAuthRefresh(req, deps = {}) {
  const env = deps.env || process.env;
  const store = deps.store || { findById, writeAudit };
  const verify = deps.verifyAccessToken || verifyAccessToken;
  const mint = deps.mintAccessToken || mintAccessToken;
  const now = deps.nowMs || Date.now();

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);

  if (!nativeAuthEnabled(env)) {
    return json(req, { ok: false, error: 'Native auth is not enabled.', reason: 'NATIVE_AUTH_DISABLED' }, 503);
  }
  const secret = getSigningSecret(env);
  if (!secret.ok) {
    console.error('[AUTH_REFRESH] refused: signing secret unusable', { reason: secret.reason });
    return json(req, { ok: false, error: 'Auth is misconfigured on the server.', reason: secret.reason }, 503);
  }

  const token = bearerToken(req);
  if (!token) return json(req, { ok: false, error: 'Missing bearer token.', reason: 'NO_BEARER_TOKEN' }, 401);

  const verified = verify(token, env, now);
  if (!verified.ok) {
    // The specific reason is safe to return here: the caller already holds the
    // token, so nothing is revealed that they do not have. It also lets the
    // browser tell "expired, log in again" apart from "this build is misconfigured".
    return json(req, { ok: false, error: 'Token rejected.', reason: verified.reason }, 401);
  }

  // ── The database check that makes revocation real ──
  const lookup = await store.findById(verified.userId, deps);
  if (!lookup.ok) {
    // Fail CLOSED: without a database we cannot prove the account is still
    // active, so we do not hand out a fresh token. 503 (not 401) so the browser
    // keeps the current token until it expires instead of logging the user out
    // over a transient outage.
    console.error('[AUTH_REFRESH] account lookup failed', { reason: lookup.reason });
    return json(req, {
      ok: false,
      error: 'Cannot refresh right now (database unreachable).',
      reason: lookup.reason,
    }, 503);
  }

  if (!lookup.found) {
    return json(req, { ok: false, error: 'Account no longer exists.', reason: 'ACCOUNT_NOT_FOUND' }, 401);
  }

  const user = lookup.user;
  if (user.status !== 'active') {
    await store.writeAudit({
      action: 'login_failed', targetEmail: user.email, targetUserId: user.id, detail: { outcome: 'refresh_disabled' },
    }, deps);
    return json(req, { ok: false, error: 'Account is disabled.', reason: 'ACCOUNT_DISABLED' }, 401);
  }

  if (user.tokenVersion !== verified.tokenVersion) {
    // The password was changed or the account was disabled+re-enabled since this
    // token was issued. That is a deliberate invalidation, so refuse.
    return json(req, { ok: false, error: 'Session was invalidated.', reason: 'TOKEN_VERSION_STALE' }, 401);
  }

  const minted = mint(
    // Mint from the CURRENT database row, never from the old token's claims —
    // otherwise a stale role or email would be carried forward indefinitely.
    { id: user.id, email: user.email, role: user.role, token_version: user.tokenVersion },
    env,
    now,
  );
  if (!minted.ok) {
    console.error('[AUTH_REFRESH] token minting failed', { reason: minted.reason });
    return json(req, { ok: false, error: 'Could not issue a session token.', reason: minted.reason }, 500);
  }

  return json(req, {
    ok: true,
    token: minted.token,
    expiresAt: minted.expiresAt,
    expiresInSeconds: minted.expiresInSeconds,
    mustChangePassword: user.mustChangePassword === true,
    user,
  });
}

export default async function handler(req) {
  return await runAuthRefresh(req);
}

export const config = { path: '/api/auth-refresh' };
