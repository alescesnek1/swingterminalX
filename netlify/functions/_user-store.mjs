// Read/write helper over `app_users` + `app_user_audit` (native auth accounts).
//
// SAFETY MODEL (same contract as _observability.mjs)
//   - Every export returns `{ ok:true, ... }` or `{ ok:false, reason }` with a
//     stable short code. Nothing throws for an expected failure (bad input, DB
//     unavailable, duplicate email), so callers check `.ok` instead of guessing
//     from a null.
//   - A user row NEVER leaves this module with its `password_hash` unless the
//     caller explicitly asks via `findByEmailForLogin`, which exists only for the
//     login path. `toPublicUser()` is the shape everything else sees, so an admin
//     endpoint cannot accidentally serialize a hash into a response.
//   - Nothing here logs an email, a hash, or a user id. DB faults are logged as
//     name + SQLSTATE only, matching _observability.mjs's reasoning.
//   - No query runs at import time; no env var is read at import time.
import { getDb } from './_db.mjs';

// Public columns only — deliberately excludes password_hash.
const PUBLIC_COLUMNS = `
  id, email, status, role, must_change_password, token_version,
  failed_login_count, locked_until, last_login_at, created_at, updated_at
`;

const MAX_EMAIL_LENGTH = 320; // RFC-practical ceiling (64 local + @ + 255 domain)

// Deliberately permissive: a single @, no whitespace, a dot in the domain. A
// stricter regex rejects valid addresses, and this value is never interpolated
// into SQL (every query below is parameterized) or into HTML unescaped.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function validateEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, reason: 'EMAIL_REQUIRED' };
  if (normalized.length > MAX_EMAIL_LENGTH) return { ok: false, reason: 'EMAIL_TOO_LONG' };
  if (!EMAIL_RE.test(normalized)) return { ok: false, reason: 'EMAIL_INVALID' };
  return { ok: true, email: normalized };
}

/** Strip a row down to what is safe to return to a caller / serialize. */
export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    role: row.role,
    mustChangePassword: row.must_change_password === true,
    tokenVersion: row.token_version,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until ? new Date(row.locked_until).toISOString() : null,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function logDbFailure(location, err) {
  // Never err.message: pg errors can embed host/port/connection detail, and this
  // module's whole job is keeping account data out of logs.
  console.warn(`[USER_STORE] ${location} failed`, { name: err?.name || 'Error', code: err?.code || null });
}

function resolveDb(deps) {
  const getDbImpl = deps.getDbImpl || getDb;
  try {
    return { ok: true, db: getDbImpl() };
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

// Postgres unique-violation.
const UNIQUE_VIOLATION = '23505';

/**
 * Look up one account for the LOGIN path only — this is the single export that
 * returns `password_hash`. Kept separate so no other caller can reach a hash by
 * accident.
 */
export async function findByEmailForLogin(email, deps = {}) {
  const valid = validateEmail(email);
  if (!valid.ok) return valid;

  const conn = resolveDb(deps);
  if (!conn.ok) return conn;

  try {
    const res = await conn.db.pool.query(
      `SELECT ${PUBLIC_COLUMNS}, password_hash FROM app_users WHERE lower(email) = $1 LIMIT 1`,
      [valid.email],
    );
    // `found:false` rather than an error: "no such account" is a normal login
    // outcome, and the login path must treat it identically to a wrong password.
    if (res.rows.length === 0) return { ok: true, found: false };
    return { ok: true, found: true, row: res.rows[0] };
  } catch (err) {
    logDbFailure('findByEmailForLogin', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/** Look up one account by id, public shape only. */
export async function findById(id, deps = {}) {
  if (typeof id !== 'string' || !id.trim()) return { ok: false, reason: 'ID_REQUIRED' };

  const conn = resolveDb(deps);
  if (!conn.ok) return conn;

  try {
    const res = await conn.db.pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM app_users WHERE id = $1 LIMIT 1`,
      [id.trim()],
    );
    if (res.rows.length === 0) return { ok: true, found: false };
    return { ok: true, found: true, user: toPublicUser(res.rows[0]) };
  } catch (err) {
    // An invalid uuid text is a client-shaped error (SQLSTATE 22P02), not an
    // outage — report it distinctly so a bad id is not read as "DB down".
    if (err?.code === '22P02') return { ok: true, found: false };
    logDbFailure('findById', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/** List accounts, newest first. Public shape only. */
export async function listUsers(opts = {}, deps = {}) {
  const limit = Math.min(Math.max(1, Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 100), 500);

  const conn = resolveDb(deps);
  if (!conn.ok) return conn;

  try {
    const res = await conn.db.pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM app_users ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return { ok: true, users: res.rows.map(toPublicUser) };
  } catch (err) {
    logDbFailure('listUsers', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

export async function countUsers(deps = {}) {
  const conn = resolveDb(deps);
  if (!conn.ok) return conn;
  try {
    const res = await conn.db.pool.query('SELECT count(*)::int AS count FROM app_users');
    return { ok: true, count: res.rows[0].count };
  } catch (err) {
    logDbFailure('countUsers', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/**
 * Create an account. `passwordHash` must already be hashed — this module never
 * sees a plaintext password, so it cannot mishandle one.
 */
export async function createUser(input, deps = {}) {
  const { email, passwordHash, role, mustChangePassword } = input && typeof input === 'object' ? input : {};

  const valid = validateEmail(email);
  if (!valid.ok) return valid;
  if (typeof passwordHash !== 'string' || !passwordHash.startsWith('scrypt$')) {
    return { ok: false, reason: 'PASSWORD_HASH_REQUIRED' };
  }
  const safeRole = role === 'admin' ? 'admin' : 'user';

  const conn = resolveDb(deps);
  if (!conn.ok) return conn;

  try {
    const res = await conn.db.pool.query(
      `INSERT INTO app_users (email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PUBLIC_COLUMNS}`,
      [valid.email, passwordHash, safeRole, mustChangePassword !== false],
    );
    return { ok: true, user: toPublicUser(res.rows[0]) };
  } catch (err) {
    if (err?.code === UNIQUE_VIOLATION) return { ok: false, reason: 'EMAIL_ALREADY_EXISTS' };
    logDbFailure('createUser', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/**
 * Replace an account's password. Bumps `token_version` and clears any lockout,
 * so a reset both invalidates outstanding sessions at their next refresh and
 * lets a locked-out user back in immediately.
 */
export async function setPassword(input, deps = {}) {
  const { id, passwordHash, mustChangePassword } = input && typeof input === 'object' ? input : {};
  if (typeof id !== 'string' || !id.trim()) return { ok: false, reason: 'ID_REQUIRED' };
  if (typeof passwordHash !== 'string' || !passwordHash.startsWith('scrypt$')) {
    return { ok: false, reason: 'PASSWORD_HASH_REQUIRED' };
  }

  const conn = resolveDb(deps);
  if (!conn.ok) return conn;

  try {
    const res = await conn.db.pool.query(
      `UPDATE app_users
          SET password_hash = $2,
              token_version = token_version + 1,
              must_change_password = $3,
              failed_login_count = 0,
              locked_until = NULL,
              updated_at = now()
        WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
      [id.trim(), passwordHash, mustChangePassword === true],
    );
    if (res.rows.length === 0) return { ok: true, found: false };
    return { ok: true, found: true, user: toPublicUser(res.rows[0]) };
  } catch (err) {
    if (err?.code === '22P02') return { ok: true, found: false };
    logDbFailure('setPassword', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/**
 * Enable or disable an account. Disabling bumps `token_version`, so the user's
 * next token refresh fails and they are out within one access-token TTL.
 */
export async function setStatus(id, status, deps = {}) {
  if (typeof id !== 'string' || !id.trim()) return { ok: false, reason: 'ID_REQUIRED' };
  if (status !== 'active' && status !== 'disabled') return { ok: false, reason: 'STATUS_INVALID' };

  const conn = resolveDb(deps);
  if (!conn.ok) return conn;

  try {
    const res = await conn.db.pool.query(
      `UPDATE app_users
          SET status = $2,
              token_version = token_version + 1,
              failed_login_count = CASE WHEN $2 = 'active' THEN 0 ELSE failed_login_count END,
              locked_until = CASE WHEN $2 = 'active' THEN NULL ELSE locked_until END,
              updated_at = now()
        WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
      [id.trim(), status],
    );
    if (res.rows.length === 0) return { ok: true, found: false };
    return { ok: true, found: true, user: toPublicUser(res.rows[0]) };
  } catch (err) {
    if (err?.code === '22P02') return { ok: true, found: false };
    logDbFailure('setStatus', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/** Record a successful login: clears the failure counter and stamps the time. */
export async function recordLoginSuccess(id, deps = {}) {
  if (typeof id !== 'string' || !id.trim()) return { ok: false, reason: 'ID_REQUIRED' };

  const conn = resolveDb(deps);
  if (!conn.ok) return conn;

  try {
    await conn.db.pool.query(
      `UPDATE app_users
          SET last_login_at = now(), failed_login_count = 0, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [id.trim()],
    );
    return { ok: true };
  } catch (err) {
    logDbFailure('recordLoginSuccess', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

export const MAX_FAILED_LOGINS = 8;
export const LOCKOUT_MINUTES = 15;

/**
 * Record a failed login and lock the account once the threshold is reached.
 * Returns the new counter and whether a lock was applied, so the caller can
 * audit it — but the RESPONSE to the user must not reveal either (that would
 * confirm the email exists).
 */
export async function recordLoginFailure(id, deps = {}) {
  if (typeof id !== 'string' || !id.trim()) return { ok: false, reason: 'ID_REQUIRED' };

  const conn = resolveDb(deps);
  if (!conn.ok) return conn;

  const maxFailed = Number.isInteger(deps.maxFailedLogins) ? deps.maxFailedLogins : MAX_FAILED_LOGINS;
  const lockoutMinutes = Number.isInteger(deps.lockoutMinutes) ? deps.lockoutMinutes : LOCKOUT_MINUTES;

  try {
    const res = await conn.db.pool.query(
      `UPDATE app_users
          SET failed_login_count = failed_login_count + 1,
              locked_until = CASE
                WHEN failed_login_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
                ELSE locked_until
              END,
              updated_at = now()
        WHERE id = $1
      RETURNING failed_login_count, locked_until`,
      [id.trim(), maxFailed, lockoutMinutes],
    );
    if (res.rows.length === 0) return { ok: true, found: false };
    const row = res.rows[0];
    return {
      ok: true,
      found: true,
      failedLoginCount: row.failed_login_count,
      locked: row.locked_until != null && new Date(row.locked_until).getTime() > Date.now(),
    };
  } catch (err) {
    logDbFailure('recordLoginFailure', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/** True when the row is currently locked out. Fails closed on a bad value. */
export function isLockedOut(row, nowMs = Date.now()) {
  if (!row || !row.locked_until) return false;
  const until = new Date(row.locked_until).getTime();
  // An unparseable lock timestamp is treated as LOCKED: on ambiguous data the
  // safe reading is "keep the door shut", never "let them in".
  if (!Number.isFinite(until)) return true;
  return until > nowMs;
}

/**
 * Append an audit row. Best-effort by design: a failure to audit must never
 * block or reverse the action it describes, but it is always logged.
 */
export async function writeAudit(input, deps = {}) {
  const { action, actorEmail, targetEmail, targetUserId, detail } = input && typeof input === 'object' ? input : {};
  if (typeof action !== 'string' || !action.trim()) return { ok: false, reason: 'ACTION_REQUIRED' };

  const conn = resolveDb(deps);
  if (!conn.ok) return conn;

  // Only JSON-safe primitives survive into `detail`, and never a token/hash.
  const safeDetail = {};
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    for (const [key, value] of Object.entries(detail)) {
      if (/pass|hash|token|secret/i.test(key)) continue;
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        safeDetail[key] = typeof value === 'string' ? value.slice(0, 200) : value;
      }
    }
  }

  try {
    await conn.db.pool.query(
      `INSERT INTO app_user_audit (action, actor_email, target_email, target_user_id, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        action.trim(),
        normalizeEmail(actorEmail) || null,
        normalizeEmail(targetEmail) || null,
        typeof targetUserId === 'string' && targetUserId.trim() ? targetUserId.trim() : null,
        JSON.stringify(safeDetail),
      ],
    );
    return { ok: true };
  } catch (err) {
    logDbFailure('writeAudit', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/** Recent audit rows for the admin page, newest first. */
export async function listAudit(opts = {}, deps = {}) {
  const limit = Math.min(Math.max(1, Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 50), 200);

  const conn = resolveDb(deps);
  if (!conn.ok) return conn;

  try {
    const res = await conn.db.pool.query(
      `SELECT id, ts, action, actor_email, target_email, target_user_id, detail
         FROM app_user_audit ORDER BY ts DESC LIMIT $1`,
      [limit],
    );
    return { ok: true, entries: res.rows };
  } catch (err) {
    logDbFailure('listAudit', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}
