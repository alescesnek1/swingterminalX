// Native login: email + password → a short-lived access token.
//
// This is the only unauthenticated write endpoint in the repo, so the whole file
// is written around three properties:
//
//   1. NON-ENUMERABLE. An unknown email, a wrong password, a disabled account,
//      and a locked-out account all return the SAME body (`INVALID_CREDENTIALS`)
//      and the same status. The unknown-email branch also spends the same scrypt
//      work as a real one (see getDummyHash), so response time does not reveal
//      which addresses are registered.
//   2. FAIL CLOSED. Disabled by default (NATIVE_AUTH_ENABLED), refuses to run
//      without a strong AUTH_JWT_SECRET, and a database outage is reported as an
//      outage (503) — never as "invalid credentials", which would hide the fault.
//   3. QUIET. No password, hash, token, email, or user id is ever logged. Only
//      stable outcome codes and counts.
//
// Rate limiting is per ACCOUNT (failed_login_count + locked_until in the DB), not
// per IP. A serverless function has no shared in-memory state to count IPs with,
// and a per-instance counter would be trivially bypassed by concurrency — so
// rather than ship something that looks like a limiter and is not, the defense is
// account lockout plus the platform's own edge protections.
import { getDummyHash, hashPassword, verifyPassword } from './_password.mjs';
import { mintAccessToken, nativeAuthEnabled, getSigningSecret } from './_native-jwt.mjs';
import {
  findByEmailForLogin,
  isLockedOut,
  recordLoginFailure,
  recordLoginSuccess,
  setPassword,
  toPublicUser,
  validateEmail,
  writeAudit,
} from './_user-store.mjs';

function headers(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Content-Type': 'application/json; charset=utf-8',
    // A credential response must never be cached by a browser or a proxy.
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
  };
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(req) });
}

// The single response every failed attempt gets, whatever the real cause.
function invalidCredentials(req) {
  return json(req, { ok: false, error: 'Invalid email or password.', reason: 'INVALID_CREDENTIALS' }, 401);
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

export async function runAuthLogin(req, deps = {}) {
  const env = deps.env || process.env;
  const store = deps.store || {
    findByEmailForLogin, recordLoginFailure, recordLoginSuccess, setPassword, writeAudit,
  };
  const passwords = deps.passwords || { verifyPassword, hashPassword, getDummyHash };
  const mint = deps.mintAccessToken || mintAccessToken;
  const now = deps.nowMs || Date.now();

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);

  // ── Gate: the native path must be explicitly on, with a usable secret ──
  // These are 503s with a specific reason, not 401s: a misconfigured server is
  // an operator problem, and reporting it as "invalid credentials" would send
  // the owner hunting for a password that was never wrong.
  if (!nativeAuthEnabled(env)) {
    console.warn('[AUTH_LOGIN] refused: native auth is disabled', { reason: 'NATIVE_AUTH_DISABLED' });
    return json(req, {
      ok: false,
      error: 'Native login is not enabled on this deployment.',
      reason: 'NATIVE_AUTH_DISABLED',
    }, 503);
  }
  const secret = getSigningSecret(env);
  if (!secret.ok) {
    console.error('[AUTH_LOGIN] refused: signing secret unusable', { reason: secret.reason });
    return json(req, {
      ok: false,
      error: 'Login is misconfigured on the server.',
      reason: secret.reason,
    }, 503);
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return json(req, { ok: false, error: err.message, reason: 'BAD_REQUEST' }, 400);
  }

  const emailCheck = validateEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  // A malformed email is still answered with the generic failure: telling the
  // caller their address was "invalid" vs "unknown" is itself a hint.
  if (!emailCheck.ok || !password) return invalidCredentials(req);

  const lookup = await store.findByEmailForLogin(emailCheck.email, deps);
  if (!lookup.ok) {
    // DB down. Say so — this is exactly the case CLAUDE.md forbids disguising as
    // a normal empty/negative result.
    console.error('[AUTH_LOGIN] lookup failed', { reason: lookup.reason });
    return json(req, {
      ok: false,
      error: 'Login is temporarily unavailable (database unreachable).',
      reason: lookup.reason,
    }, 503);
  }

  if (!lookup.found) {
    // Spend the same scrypt work as a real verification so the response time of
    // an unknown email is indistinguishable from a wrong password.
    await passwords.verifyPassword(password, await passwords.getDummyHash());
    await store.writeAudit({ action: 'login_failed', targetEmail: emailCheck.email, detail: { outcome: 'no_such_account' } }, deps);
    return invalidCredentials(req);
  }

  const row = lookup.row;

  // Disabled and locked-out accounts are refused with the SAME response as a
  // wrong password. The owner sees the real state on the admin page and in the
  // audit log; the client is told nothing it could enumerate with.
  if (row.status !== 'active') {
    await store.writeAudit({
      action: 'login_failed', targetEmail: row.email, targetUserId: row.id, detail: { outcome: 'account_disabled' },
    }, deps);
    return invalidCredentials(req);
  }
  if (isLockedOut(row, now)) {
    await store.writeAudit({
      action: 'login_locked', targetEmail: row.email, targetUserId: row.id, detail: { outcome: 'locked_out' },
    }, deps);
    return invalidCredentials(req);
  }

  const verdict = await passwords.verifyPassword(password, row.password_hash);
  if (!verdict.ok) {
    // The stored hash itself is unusable — an operator problem, not a wrong
    // password. Logged loudly, and deliberately NOT counted as a login failure
    // (that would lock the user out of an account they cannot fix).
    console.error('[AUTH_LOGIN] stored hash unusable for an account', { reason: verdict.reason });
    await store.writeAudit({
      action: 'login_failed', targetEmail: row.email, targetUserId: row.id, detail: { outcome: verdict.reason },
    }, deps);
    return json(req, {
      ok: false,
      error: 'This account cannot be verified. Ask an admin to reset the password.',
      reason: 'ACCOUNT_HASH_UNREADABLE',
    }, 500);
  }

  if (!verdict.matches) {
    const failure = await store.recordLoginFailure(row.id, deps);
    if (!failure.ok) console.warn('[AUTH_LOGIN] could not record a failed attempt', { reason: failure.reason });
    await store.writeAudit({
      action: failure.locked ? 'login_locked' : 'login_failed',
      targetEmail: row.email,
      targetUserId: row.id,
      detail: { outcome: 'wrong_password', failedLoginCount: failure.failedLoginCount ?? null },
    }, deps);
    return invalidCredentials(req);
  }

  // ── Authenticated ──
  const minted = mint(row, env, now);
  if (!minted.ok) {
    console.error('[AUTH_LOGIN] token minting failed', { reason: minted.reason });
    return json(req, { ok: false, error: 'Could not issue a session token.', reason: minted.reason }, 500);
  }

  const success = await store.recordLoginSuccess(row.id, deps);
  if (!success.ok) {
    // Non-fatal: the login is genuinely valid. But it means the failure counter
    // was not cleared, so it must not vanish silently.
    console.warn('[AUTH_LOGIN] could not record a successful login', { reason: success.reason });
  }

  // Opportunistic upgrade: if this password was stored with weaker scrypt
  // parameters than current policy, re-hash it now that we hold the plaintext.
  // Never allowed to fail the login.
  if (verdict.needsRehash) {
    const rehashed = await passwords.hashPassword(password);
    if (rehashed.ok) {
      const stored = await store.setPassword({
        id: row.id,
        passwordHash: rehashed.hash,
        // Preserve the existing flag: an automatic cost upgrade is not a reason
        // to force the user to pick a new password.
        mustChangePassword: row.must_change_password === true,
      }, deps);
      if (!stored.ok) console.warn('[AUTH_LOGIN] password rehash could not be stored', { reason: stored.reason });
    } else {
      console.warn('[AUTH_LOGIN] password rehash failed', { reason: rehashed.reason });
    }
  }

  await store.writeAudit({ action: 'login_ok', targetEmail: row.email, targetUserId: row.id }, deps);

  return json(req, {
    ok: true,
    token: minted.token,
    expiresAt: minted.expiresAt,
    expiresInSeconds: minted.expiresInSeconds,
    // `mustChangePassword` only ever reaches an already-authenticated caller, so
    // it cannot be used to probe accounts.
    mustChangePassword: row.must_change_password === true,
    user: toPublicUser(row),
  });
}

export default async function handler(req) {
  return await runAuthLogin(req);
}

export const config = { path: '/api/auth-login' };
