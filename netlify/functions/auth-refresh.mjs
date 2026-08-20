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
// A refresh NEVER accepts a password.
//
// ── Device sessions: what a refresh may and may not extend ──
// A refresh re-mints the SHORT access token and carries the token's device
// session (`sid`/`sxp`, opened at login, 8h by default) forward UNCHANGED. It
// therefore accepts a token whose `exp` has already lapsed, as long as the
// session window is still open — that is what makes a page reload after an hour
// silent instead of a login prompt. It can never push the deadline out: 8h after
// signing in the session is refused here and on every other path, and the user
// logs in again on that device.
//
// The tolerance is bounded and DB-checked, never blind: verifyRefreshableToken()
// checks the signature/issuer/audience as strictly as the request path and
// refuses once `sxp` has passed, and the account lookup below still ends the
// session on a disabled account or a changed password. A token accepted here is
// refused by every API path, which uses verifyAccessToken().
//
// A legacy token minted before `sxp` existed gets NO tolerance (it must still be
// unexpired) and, when refreshed, is upgraded into a token with a fresh session
// window — so the fleet migrates by itself with no forced logout.
import {
  mintAccessToken, nativeAuthEnabled, getSigningSecret, verifyRefreshableToken,
} from './_native-jwt.mjs';
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
  const verify = deps.verifyRefreshableToken || verifyRefreshableToken;
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
    // The ONE thing carried over from the presented token: its device session.
    // Null for a legacy token, which then opens a fresh window rather than
    // living forever without one.
    verified.sessionExpiresAtSeconds
      ? { sessionId: verified.sessionId, sessionExpiresAtSeconds: verified.sessionExpiresAtSeconds }
      : null,
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
    // The absolute deadline of this device session. The browser needs it to know
    // when to stop refreshing and show the login form, instead of discovering it
    // through a failed request.
    sessionExpiresAt: minted.sessionExpiresAt,
    sessionExpiresInSeconds: minted.sessionExpiresInSeconds,
    mustChangePassword: user.mustChangePassword === true,
    user,
  });
}

export default async function handler(req) {
  return await runAuthRefresh(req);
}

export const config = { path: '/api/auth-refresh' };
