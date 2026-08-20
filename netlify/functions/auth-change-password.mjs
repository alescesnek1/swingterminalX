// Let a signed-in user change their OWN password.
//
// Without this, `must_change_password` (set whenever an admin creates an account
// or resets a password) could never be satisfied by the user — only an admin
// could ever set a password, which means the admin always knows it.
//
// Requires the CURRENT password even though the caller already holds a valid
// token: a stolen token should not be enough to take an account over
// permanently. That is the whole point of re-authentication on a credential
// change.
//
// Changing the password bumps `token_version`, which invalidates every OTHER
// session for this account at its next refresh. So a fresh token is minted and
// returned here — otherwise the user would change their password and then be
// logged out by their own action.
//
// Native accounts only. A Supabase-authenticated caller has no native password
// to change, and is told so explicitly rather than being handed a confusing
// credential error.
import { getIdentity } from './_auth.mjs';
import { hashPassword, validatePasswordPolicy, verifyPassword } from './_password.mjs';
import { mintAccessToken, nativeAuthEnabled, getSigningSecret } from './_native-jwt.mjs';
import { findByEmailForLogin, setPassword, writeAudit } from './_user-store.mjs';

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

const MAX_BODY_BYTES = 4_000;

async function parseBody(req) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new Error('Request body too large.');
  if (!raw.trim()) throw new Error('Missing request body.');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

export async function runAuthChangePassword(req, deps = {}) {
  const env = deps.env || process.env;
  const verifyIdentity = deps.getIdentity || getIdentity;
  const store = deps.store || { findByEmailForLogin, setPassword, writeAudit };
  const passwords = deps.passwords || { verifyPassword, hashPassword };
  const mint = deps.mintAccessToken || mintAccessToken;
  const now = deps.nowMs || Date.now();

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);

  if (!nativeAuthEnabled(env)) {
    return json(req, { ok: false, error: 'Native auth is not enabled.', reason: 'NATIVE_AUTH_DISABLED' }, 503);
  }
  const secret = getSigningSecret(env);
  if (!secret.ok) {
    console.error('[AUTH_CHANGE_PASSWORD] refused: signing secret unusable', { reason: secret.reason });
    return json(req, { ok: false, error: 'Auth is misconfigured on the server.', reason: secret.reason }, 503);
  }

  const identity = await verifyIdentity(req);
  if (!identity || !identity.ok || !identity.userId) {
    return json(req, {
      ok: false,
      error: 'Unauthorized',
      reason: identity && identity.reason ? identity.reason : 'No bearer token',
    }, 401);
  }
  // A decode-only token must never be able to change a credential.
  if (identity.verified !== true) {
    return json(req, {
      ok: false,
      error: 'Changing a password requires a cryptographically verified token.',
      reason: 'IDENTITY_NOT_VERIFIED',
    }, 403);
  }
  // Only a native session can change a native password.
  if (identity.authMode !== 'verified_native_hs256') {
    return json(req, {
      ok: false,
      error: 'This session is not a native account session, so it has no password to change here.',
      reason: 'NOT_A_NATIVE_SESSION',
    }, 400);
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return json(req, { ok: false, error: err.message, reason: 'BAD_REQUEST' }, 400);
  }

  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!currentPassword) {
    return json(req, { ok: false, error: 'The current password is required.', reason: 'CURRENT_PASSWORD_REQUIRED' }, 400);
  }

  const policy = validatePasswordPolicy(newPassword);
  if (!policy.ok) {
    return json(req, { ok: false, error: 'The new password does not meet policy.', reason: policy.reason }, 400);
  }
  if (newPassword === currentPassword) {
    return json(req, { ok: false, error: 'The new password must differ from the current one.', reason: 'PASSWORD_UNCHANGED' }, 400);
  }

  const lookup = await store.findByEmailForLogin(identity.email, deps);
  if (!lookup.ok) {
    console.error('[AUTH_CHANGE_PASSWORD] lookup failed', { reason: lookup.reason });
    return json(req, { ok: false, error: 'Cannot change the password right now.', reason: lookup.reason }, 503);
  }
  if (!lookup.found) {
    return json(req, { ok: false, error: 'Account no longer exists.', reason: 'ACCOUNT_NOT_FOUND' }, 401);
  }

  const row = lookup.row;
  // Defense in depth: the token's subject must be the row we just loaded by
  // email. If they ever disagree, something is wrong and we do not guess.
  if (row.id !== identity.userId) {
    console.error('[AUTH_CHANGE_PASSWORD] token subject did not match the row found by email', { reason: 'IDENTITY_ROW_MISMATCH' });
    return json(req, { ok: false, error: 'Unauthorized', reason: 'IDENTITY_ROW_MISMATCH' }, 401);
  }
  if (row.status !== 'active') {
    return json(req, { ok: false, error: 'Account is disabled.', reason: 'ACCOUNT_DISABLED' }, 401);
  }

  const verdict = await passwords.verifyPassword(currentPassword, row.password_hash);
  if (!verdict.ok) {
    console.error('[AUTH_CHANGE_PASSWORD] stored hash unusable', { reason: verdict.reason });
    return json(req, {
      ok: false,
      error: 'This account cannot be verified. Ask an admin to reset the password.',
      reason: 'ACCOUNT_HASH_UNREADABLE',
    }, 500);
  }
  if (!verdict.matches) {
    await store.writeAudit({
      action: 'login_failed', targetEmail: row.email, targetUserId: row.id, detail: { outcome: 'change_password_wrong_current' },
    }, deps);
    return json(req, { ok: false, error: 'The current password is not correct.', reason: 'CURRENT_PASSWORD_INCORRECT' }, 401);
  }

  const hashed = await passwords.hashPassword(newPassword);
  if (!hashed.ok) {
    console.error('[AUTH_CHANGE_PASSWORD] hashing failed', { reason: hashed.reason });
    return json(req, { ok: false, error: 'Could not hash the new password.', reason: hashed.reason }, 500);
  }

  const stored = await store.setPassword({
    id: row.id,
    passwordHash: hashed.hash,
    // The obligation is discharged: the user has now chosen their own password.
    mustChangePassword: false,
  }, deps);
  if (!stored.ok) {
    console.error('[AUTH_CHANGE_PASSWORD] could not store the new password', { reason: stored.reason });
    return json(req, { ok: false, error: 'Could not save the new password.', reason: stored.reason }, 503);
  }
  if (!stored.found) return json(req, { ok: false, error: 'Account no longer exists.', reason: 'ACCOUNT_NOT_FOUND' }, 401);

  await store.writeAudit({ action: 'password_reset', actorEmail: row.email, targetEmail: row.email, targetUserId: row.id, detail: { selfService: true } }, deps);

  // setPassword bumped token_version, so the caller's existing token is now
  // stale. Hand back a fresh one minted from the UPDATED row, or the user would
  // be signed out by their own password change.
  const minted = mint(
    { id: stored.user.id, email: stored.user.email, role: stored.user.role, token_version: stored.user.tokenVersion },
    env,
    now,
  );
  if (!minted.ok) {
    console.error('[AUTH_CHANGE_PASSWORD] could not mint a replacement token', { reason: minted.reason });
    // The password DID change. Say so precisely, so the user re-signs in with
    // the new password instead of thinking the change failed.
    return json(req, {
      ok: true,
      passwordChanged: true,
      token: null,
      error: 'Password changed, but a new session token could not be issued. Please sign in again.',
      reason: minted.reason,
    }, 200);
  }

  return json(req, {
    ok: true,
    passwordChanged: true,
    token: minted.token,
    expiresAt: minted.expiresAt,
    expiresInSeconds: minted.expiresInSeconds,
    // A self-service change re-proves the password, so this deliberately opens a
    // NEW device session window rather than inheriting the remainder of the old
    // one — it is equivalent to logging in again.
    sessionExpiresAt: minted.sessionExpiresAt,
    sessionExpiresInSeconds: minted.sessionExpiresInSeconds,
    mustChangePassword: false,
    user: stored.user,
    notice: 'Password changed. Any other session for this account stops working at its next refresh.',
  });
}

export default async function handler(req) {
  return await runAuthChangePassword(req);
}

export const config = { path: '/api/auth-change-password' };
