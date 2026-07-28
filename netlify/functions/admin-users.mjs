// Admin user management for native accounts — the backend behind the terminal's
// admin page.
//
// AUTHORIZATION is deliberately unchanged from every other admin endpoint in
// this repo: `getIdentity()` for the caller's identity, then `isAdmin()`, which
// reads the BOT_ADMIN_EMAILS env allowlist and requires a cryptographically
// verified token. Two consequences worth being explicit about:
//
//   • The `role` column in app_users grants nothing. Only the env allowlist
//     does. A DB column that granted admin would let anyone who can write a row
//     grant themselves admin, which AGENTS.md forbids as relaxing an auth gate.
//   • This endpoint works with EITHER auth source. During the cutover the owner
//     is still signed in through Supabase, so they can create the first native
//     accounts here BEFORE NATIVE_AUTH_ENABLED is ever switched on. That is what
//     avoids the chicken-and-egg problem of "the admin page needs a native
//     account to create the first native account", with no bootstrap secret and
//     no extra attack surface.
//
// A generated password is returned EXACTLY ONCE, in the create/reset response,
// and is never stored in plaintext, never logged, and never written to the audit
// table. If the admin loses it, the fix is another reset.
import { getIdentity, isAdmin } from './_auth.mjs';
import { hashPassword, validatePasswordPolicy, MIN_PASSWORD_LENGTH } from './_password.mjs';
import {
  createUser,
  findById,
  listAudit,
  listUsers,
  setPassword,
  setStatus,
  validateEmail,
  writeAudit,
} from './_user-store.mjs';
import crypto from 'node:crypto';

function headers(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin, Authorization',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  };
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(req) });
}

const MAX_BODY_BYTES = 8_000;

async function parseBody(req) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new Error('Request body too large.');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

// A generated password the admin reads once and hands over. Base64url of 18
// random bytes → 24 characters, comfortably above MIN_PASSWORD_LENGTH, and no
// ambiguous-character problem to explain because it is copy-pasted, not typed.
export function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');
}

const ACTIONS = new Set(['create', 'reset-password', 'disable', 'enable']);

export async function runAdminUsers(req, deps = {}) {
  const verifyIdentity = deps.getIdentity || getIdentity;
  const adminCheck = deps.isAdmin || isAdmin;
  const store = deps.store || {
    createUser, findById, listUsers, listAudit, setPassword, setStatus, writeAudit,
  };
  const passwords = deps.passwords || { hashPassword, generatePassword };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });

  const identity = await verifyIdentity(req);
  if (!identity || !identity.ok || !identity.userId) {
    return json(req, {
      ok: false,
      error: 'Unauthorized',
      reason: identity && identity.reason ? identity.reason : 'No bearer token',
    }, 401);
  }

  // Managing accounts is the most privileged thing this app can do, so it
  // requires a cryptographically VERIFIED token — never a decode-only dev token,
  // whatever AUTH_DECODE_ONLY is set to.
  if (identity.verified !== true) {
    console.warn('[ADMIN_USERS] refused an unverified identity', { reason: 'IDENTITY_NOT_VERIFIED' });
    return json(req, {
      ok: false,
      error: 'Account management requires a cryptographically verified token.',
      reason: 'IDENTITY_NOT_VERIFIED',
    }, 403);
  }

  if (!adminCheck(identity)) {
    console.warn('[ADMIN_USERS] refused a non-admin caller', { reason: 'NOT_ADMIN' });
    return json(req, { ok: false, error: 'Forbidden', reason: 'NOT_ADMIN' }, 403);
  }

  const actorEmail = identity.email;

  // ── GET: list accounts (+ recent audit) ──
  if (req.method === 'GET') {
    const listed = await store.listUsers({ limit: 500 }, deps);
    if (!listed.ok) {
      console.error('[ADMIN_USERS] list failed', { reason: listed.reason });
      return json(req, { ok: false, error: 'Could not read the user list.', reason: listed.reason }, 503);
    }
    const audit = await store.listAudit({ limit: 50 }, deps);
    return json(req, {
      ok: true,
      users: listed.users,
      // An audit read failure must not take the whole page down, but it must be
      // visible rather than rendering as "no history".
      audit: audit.ok ? audit.entries : [],
      auditError: audit.ok ? null : audit.reason,
      passwordPolicy: { minLength: MIN_PASSWORD_LENGTH },
    });
  }

  if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);

  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return json(req, { ok: false, error: err.message, reason: 'BAD_REQUEST' }, 400);
  }

  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!ACTIONS.has(action)) {
    return json(req, {
      ok: false,
      error: `Unknown action. Expected one of: ${[...ACTIONS].join(', ')}.`,
      reason: 'UNKNOWN_ACTION',
    }, 400);
  }

  // ── create ──
  if (action === 'create') {
    const emailCheck = validateEmail(body.email);
    if (!emailCheck.ok) return json(req, { ok: false, error: 'Invalid email address.', reason: emailCheck.reason }, 400);

    // An admin may supply a password, but it still has to pass policy — an
    // endpoint that accepts a weak password "because an admin asked" is just a
    // weak password.
    const supplied = typeof body.password === 'string' && body.password ? body.password : null;
    if (supplied) {
      const policy = validatePasswordPolicy(supplied);
      if (!policy.ok) return json(req, { ok: false, error: 'Password does not meet policy.', reason: policy.reason }, 400);
    }
    const plaintext = supplied || passwords.generatePassword();

    const hashed = await passwords.hashPassword(plaintext);
    if (!hashed.ok) {
      console.error('[ADMIN_USERS] hashing failed on create', { reason: hashed.reason });
      return json(req, { ok: false, error: 'Could not hash the password.', reason: hashed.reason }, 500);
    }

    const created = await store.createUser({
      email: emailCheck.email,
      passwordHash: hashed.hash,
      role: body.role === 'admin' ? 'admin' : 'user',
      mustChangePassword: true,
    }, deps);

    if (!created.ok) {
      const status = created.reason === 'EMAIL_ALREADY_EXISTS' ? 409 : 503;
      if (status === 503) console.error('[ADMIN_USERS] create failed', { reason: created.reason });
      return json(req, { ok: false, error: 'Could not create the account.', reason: created.reason }, status);
    }

    await store.writeAudit({
      action: 'created',
      actorEmail,
      targetEmail: created.user.email,
      targetUserId: created.user.id,
      detail: { role: created.user.role, passwordGenerated: !supplied },
    }, deps);

    return json(req, {
      ok: true,
      user: created.user,
      // Shown once. Not stored, not logged, not audited.
      generatedPassword: supplied ? null : plaintext,
      notice: 'Copy this password now — it is shown once and cannot be recovered. The user must change it on first sign-in.',
    }, 201);
  }

  // Every remaining action targets an existing account by id.
  const targetId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!targetId) return json(req, { ok: false, error: 'userId is required.', reason: 'USER_ID_REQUIRED' }, 400);

  const target = await store.findById(targetId, deps);
  if (!target.ok) {
    console.error('[ADMIN_USERS] target lookup failed', { reason: target.reason });
    return json(req, { ok: false, error: 'Could not read the account.', reason: target.reason }, 503);
  }
  if (!target.found) return json(req, { ok: false, error: 'No such account.', reason: 'ACCOUNT_NOT_FOUND' }, 404);

  // ── reset-password ──
  if (action === 'reset-password') {
    const supplied = typeof body.password === 'string' && body.password ? body.password : null;
    if (supplied) {
      const policy = validatePasswordPolicy(supplied);
      if (!policy.ok) return json(req, { ok: false, error: 'Password does not meet policy.', reason: policy.reason }, 400);
    }
    const plaintext = supplied || passwords.generatePassword();

    const hashed = await passwords.hashPassword(plaintext);
    if (!hashed.ok) {
      console.error('[ADMIN_USERS] hashing failed on reset', { reason: hashed.reason });
      return json(req, { ok: false, error: 'Could not hash the password.', reason: hashed.reason }, 500);
    }

    const stored = await store.setPassword({
      id: targetId,
      passwordHash: hashed.hash,
      mustChangePassword: true,
    }, deps);
    if (!stored.ok) {
      console.error('[ADMIN_USERS] password reset failed', { reason: stored.reason });
      return json(req, { ok: false, error: 'Could not reset the password.', reason: stored.reason }, 503);
    }
    if (!stored.found) return json(req, { ok: false, error: 'No such account.', reason: 'ACCOUNT_NOT_FOUND' }, 404);

    await store.writeAudit({
      action: 'password_reset',
      actorEmail,
      targetEmail: stored.user.email,
      targetUserId: stored.user.id,
      detail: { passwordGenerated: !supplied },
    }, deps);

    return json(req, {
      ok: true,
      user: stored.user,
      generatedPassword: supplied ? null : plaintext,
      notice: 'Copy this password now — it is shown once. Existing sessions for this account stop working at their next refresh.',
    });
  }

  // ── disable / enable ──
  const nextStatus = action === 'disable' ? 'disabled' : 'active';

  // An admin locking themselves out of account management is a foot-gun with no
  // in-app recovery path, so it is refused outright.
  if (action === 'disable' && target.user.email && actorEmail
      && target.user.email.toLowerCase() === String(actorEmail).toLowerCase()) {
    return json(req, {
      ok: false,
      error: 'You cannot disable your own account.',
      reason: 'CANNOT_DISABLE_SELF',
    }, 400);
  }

  const updated = await store.setStatus(targetId, nextStatus, deps);
  if (!updated.ok) {
    console.error('[ADMIN_USERS] status change failed', { reason: updated.reason });
    return json(req, { ok: false, error: 'Could not change the account status.', reason: updated.reason }, 503);
  }
  if (!updated.found) return json(req, { ok: false, error: 'No such account.', reason: 'ACCOUNT_NOT_FOUND' }, 404);

  await store.writeAudit({
    action: action === 'disable' ? 'disabled' : 'enabled',
    actorEmail,
    targetEmail: updated.user.email,
    targetUserId: updated.user.id,
  }, deps);

  return json(req, {
    ok: true,
    user: updated.user,
    notice: action === 'disable'
      ? 'The account is disabled. Any live session stops working at its next token refresh (within one access-token lifetime).'
      : 'The account is active again. The user can sign in immediately.',
  });
}

export default async function handler(req) {
  return await runAdminUsers(req);
}

export const config = { path: '/api/admin-users' };
