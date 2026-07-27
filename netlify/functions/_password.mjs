// Password hashing for native (own-database) accounts.
//
// scrypt, from Node's built-in `crypto`. No dependency is added: this codebase
// is real-money-adjacent and a password hash is exactly the wrong place to take
// on supply-chain risk. scrypt is memory-hard and is what lets us skip bcrypt
// (which Node cannot do natively) — the reason Supabase's existing bcrypt hashes
// are NOT migrated and the owner sets fresh passwords instead.
//
// STORED FORMAT (self-describing, versioned):
//
//   scrypt$N=32768,r=8,p=1$<salt-base64>$<digest-base64>
//
// The parameters travel WITH the hash, so the cost can be raised later without
// invalidating every existing password: `needsRehash()` reports which stored
// hashes are below the current policy, and they get upgraded on next successful
// login. A bare digest could never do that.
//
// SAFETY MODEL
//   - Every export returns a value or a discriminated `{ ok:false, reason }`.
//     `verifyPassword` NEVER throws on malformed stored input — a corrupt hash
//     must read as "does not match", never as an exception that a caller might
//     accidentally treat as success.
//   - Comparison is `timingSafeEqual` on equal-length buffers.
//   - Nothing here logs. A module that handles plaintext passwords must not be
//     able to put one in a log line, so it has no console call at all.
import crypto from 'node:crypto';

// Current policy. N=32768 measures ~105ms on the target runtime — enough to make
// offline guessing expensive, cheap enough for an interactive login.
export const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1 });
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

// scrypt needs roughly 128 * N * r bytes; Node's default maxmem (32MB) is below
// what N=32768,r=8 requires (~33.5MB), so it must be raised explicitly or
// hashing throws.
const MAXMEM = 96 * 1024 * 1024;

// Minimums, enforced here so every caller gets the same policy. Deliberately not
// a complexity regex: length is what actually resists guessing, and character
// rules push people toward predictable substitutions.
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Validate a candidate password against policy.
 * Returns `{ ok:true }` or `{ ok:false, reason }` with a stable code.
 */
export function validatePasswordPolicy(password) {
  if (typeof password !== 'string') return { ok: false, reason: 'PASSWORD_NOT_A_STRING' };
  // Length is measured in code points, not UTF-16 units, so an emoji or an
  // accented character counts once rather than twice.
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'PASSWORD_TOO_SHORT' };
  if (length > MAX_PASSWORD_LENGTH) return { ok: false, reason: 'PASSWORD_TOO_LONG' };
  if (password.trim().length === 0) return { ok: false, reason: 'PASSWORD_BLANK' };
  return { ok: true };
}

function scryptAsync(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      // Normalize so a password typed with a different Unicode composition still
      // matches. Without this, the same visible characters can hash differently
      // across operating systems and the user is simply locked out.
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (err, derivedKey) => (err ? reject(err) : resolve(derivedKey)),
    );
  });
}

function formatParams(params) {
  return `N=${params.N},r=${params.r},p=${params.p}`;
}

/**
 * Hash a password. Returns `{ ok:true, hash }` or `{ ok:false, reason }`.
 * Rejects a policy-violating password rather than storing it.
 */
export async function hashPassword(password) {
  const policy = validatePasswordPolicy(password);
  if (!policy.ok) return policy;

  const salt = crypto.randomBytes(SALT_BYTES);
  let digest;
  try {
    digest = await scryptAsync(password, salt, SCRYPT_PARAMS);
  } catch {
    // A scrypt failure is a configuration/runtime fault (e.g. maxmem), not a bad
    // password. Surface it as a distinct reason so a caller never stores a
    // partial or empty hash.
    return { ok: false, reason: 'HASH_FAILED' };
  }

  return {
    ok: true,
    hash: `scrypt$${formatParams(SCRYPT_PARAMS)}$${salt.toString('base64')}$${digest.toString('base64')}`,
  };
}

/**
 * Parse a stored hash string. Returns null for anything malformed — callers
 * treat null as "cannot verify", never as a match.
 */
export function parseStoredHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 4) return null;
  const [algo, paramStr, saltB64, digestB64] = parts;
  if (algo !== 'scrypt') return null;

  const params = {};
  for (const pair of paramStr.split(',')) {
    const [key, rawValue] = pair.split('=');
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value <= 0) return null;
    params[key] = value;
  }
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return null;
  // Refuse absurd parameters from a tampered row: scrypt with a huge N would
  // otherwise hang the function or exhaust memory.
  if (params.N > 1048576 || params.r > 64 || params.p > 16) return null;

  let salt;
  let digest;
  try {
    salt = Buffer.from(saltB64, 'base64');
    digest = Buffer.from(digestB64, 'base64');
  } catch {
    // This function's documented contract is "null for anything malformed", and
    // null is NOT the value a caller acts on: verifyPassword() turns it into the
    // discriminated { ok:false, reason:'STORED_HASH_UNREADABLE' } that keeps a
    // corrupt row distinguishable from a wrong password. Asserted in
    // tests/auth.password.test.mjs ("an unreadable stored hash is a distinct
    // error, never a match").
    // eslint-disable-next-line repo-contract/no-indistinguishable-catch-return -- see above
    return null;
  }
  if (salt.length === 0 || digest.length === 0) return null;

  return { algo, params, salt, digest };
}

/**
 * Verify a password against a stored hash.
 * Returns `{ ok:true, matches:boolean, needsRehash:boolean }` on a usable hash,
 * or `{ ok:false, reason }` when the stored hash itself cannot be used.
 *
 * `ok:false` and `matches:false` are deliberately different: the first means
 * "this account's stored hash is broken" (an operator problem worth surfacing),
 * the second means "wrong password" (a normal event). Collapsing them would hide
 * a corrupted row behind a stream of ordinary failed logins.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: true, matches: false, needsRehash: false };
  }
  const parsed = parseStoredHash(stored);
  if (!parsed) return { ok: false, reason: 'STORED_HASH_UNREADABLE' };

  let candidate;
  try {
    candidate = await scryptAsync(password, parsed.salt, parsed.params);
  } catch {
    return { ok: false, reason: 'HASH_FAILED' };
  }

  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first — and a differing length is itself a non-match.
  const matches = candidate.length === parsed.digest.length
    && crypto.timingSafeEqual(candidate, parsed.digest);

  return { ok: true, matches, needsRehash: matches && isBelowPolicy(parsed.params) };
}

function isBelowPolicy(params) {
  return params.N < SCRYPT_PARAMS.N || params.r < SCRYPT_PARAMS.r || params.p < SCRYPT_PARAMS.p;
}

/** True when a stored hash was made with weaker-than-current parameters. */
export function needsRehash(stored) {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false; // unreadable is a verify-time problem, not a rehash one
  return isBelowPolicy(parsed.params);
}

// A fixed, valid hash of a value nobody can log in with. Used by the login path
// to spend the SAME scrypt work when an email does not exist as when it does —
// otherwise the response time tells an attacker which emails are registered.
// Generated at module load, so it is never a committed constant.
let _dummyHash = null;
export async function getDummyHash() {
  if (!_dummyHash) {
    const result = await hashPassword(crypto.randomBytes(32).toString('base64'));
    // hashPassword can only fail here on a runtime fault; fall back to a
    // structurally valid hash so the timing-equalization path still runs.
    _dummyHash = result.ok
      ? result.hash
      : `scrypt$${formatParams(SCRYPT_PARAMS)}$${crypto.randomBytes(SALT_BYTES).toString('base64')}$${crypto.randomBytes(KEY_LENGTH).toString('base64')}`;
  }
  return _dummyHash;
}
