// Phase 2C: thin write/read helper over the Phase 2B observability tables
// (`system_events`, `ingest_runs`). No product function calls this yet —
// it exists so a future caller has one safe, tested path instead of each
// hand-rolling its own INSERT/SELECT against `_db.mjs`.
//
// SAFETY MODEL
//   - Every export returns { ok:true, ... } or { ok:false, reason }. Nothing
//     here throws for an expected failure (bad input, DB unavailable, write
//     failure) — callers can always check `.ok` instead of wrapping in
//     try/catch. `reason` is always a stable, short code, never a raw error
//     message or connection string.
//   - Payload sanitization is allowlist-shaped: only JSON-safe primitives,
//     arrays, and plain objects survive; anything else (functions, class
//     instances, non-JSON-safe values) is dropped rather than trusted. On
//     top of that shape allowlist, a fixed set of known-dangerous key names
//     (token, secret, password, session data, ids, connection info) is
//     stripped unconditionally, because "safe shape" alone doesn't stop a
//     caller from putting a real secret in a plain string field.
//   - No query runs at import time. No env var is read at import time.
import { getDb } from './_db.mjs';

export const ALLOWED_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error', 'critical']);
const ALLOWED_LEVELS_SET = new Set(ALLOWED_LEVELS);

export const ALLOWED_RUN_STATUSES = Object.freeze(['ok', 'partial', 'failed', 'running']);
const ALLOWED_RUN_STATUSES_SET = new Set(ALLOWED_RUN_STATUSES);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Key names that must never survive into a stored payload, regardless of
// value. Separators and case are normalized before matching, so snake_case,
// camelCase, and case variants are treated identically.
const DANGEROUS_PAYLOAD_KEYS = new Set([
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'apikey',
  'secret', 'password', 'passwd', 'authorization', 'auth', 'cookie', 'jwt',
  'chatid', 'userid', 'dburl', 'databaseurl', 'connection', 'connectionstring',
]);

function isDangerousPayloadKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return DANGEROUS_PAYLOAD_KEYS.has(normalized)
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password');
}

const MAX_PAYLOAD_CHARS = 8000;
const MAX_TEXT_FIELD_CHARS = 200;

function truncate(str, max) {
  if (typeof str !== 'string') return str;
  return str.length > max ? str.slice(0, max) + '…[truncated]' : str;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  try {
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

function isJsonSafePrimitive(v) {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

// Recursively keeps only JSON-safe primitives / arrays / plain objects
// (shallow allowlist), dropping dangerous-named keys at every level. Bounds
// depth so a malicious/broken caller can't hand us a deeply nested or
// circular structure.
function sanitizeValue(value, depth) {
  if (depth > 4) return '[max-depth-exceeded]';
  if (isJsonSafePrimitive(value)) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeValue(v, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (isDangerousPayloadKey(key)) continue;
      out[key] = sanitizeValue(val, depth + 1);
    }
    return out;
  }
  // Functions, class instances, symbols, undefined, etc. are not JSON-safe —
  // drop rather than trust.
  return undefined;
}

export function sanitizePayload(payload) {
  if (payload === undefined || payload === null) return {};
  if (!isPlainObject(payload)) return { _rejected: 'payload must be a plain object' };
  const cleaned = sanitizeValue(payload, 0);
  let json;
  try {
    json = JSON.stringify(cleaned);
  } catch {
    return { _rejected: 'payload is not JSON-safe' };
  }
  if (json.length > MAX_PAYLOAD_CHARS) {
    return { _rejected: 'payload too large', _originalSizeChars: json.length };
  }
  return cleaned;
}

function logWriteFailure(location, err) {
  // Never log err.message here — pg connection errors can embed host/port
  // details, and this file's whole job is to keep that kind of thing out of
  // logs. name + code (a stable Postgres SQLSTATE when present) is enough
  // to diagnose without risking it.
  console.warn(`[OBSERVABILITY] ${location} failed`, { name: err?.name || 'Error', code: err?.code || null });
}

/**
 * Insert one row into `system_events`. Returns { ok:true, id } or
 * { ok:false, reason }. Never throws for DB-unavailable or invalid input —
 * only a genuine programmer error (e.g. calling this with a non-object)
 * would surface as a thrown error, and even that is guarded against below.
 */
export async function writeSystemEvent(input, deps = {}) {
  const getDbImpl = deps.getDbImpl || getDb;
  const { level, event, source, corrId, payload, errorName, errorCode } = input && typeof input === 'object' ? input : {};

  if (!ALLOWED_LEVELS_SET.has(level)) return { ok: false, reason: 'INVALID_LEVEL' };
  const eventCode = typeof event === 'string' ? event.trim() : '';
  if (!eventCode) return { ok: false, reason: 'MISSING_EVENT' };
  const sourceTag = typeof source === 'string' ? source.trim() : '';
  if (!sourceTag) return { ok: false, reason: 'MISSING_SOURCE' };

  const corrIdSafe = typeof corrId === 'string' && UUID_RE.test(corrId) ? corrId : null;
  const safePayload = sanitizePayload(payload);
  const safeErrorName = typeof errorName === 'string' ? truncate(errorName, MAX_TEXT_FIELD_CHARS) : null;
  const safeErrorCode = typeof errorCode === 'string' ? truncate(errorCode, MAX_TEXT_FIELD_CHARS) : null;

  let db;
  try {
    db = getDbImpl();
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }

  try {
    const res = await db.pool.query(
      `INSERT INTO system_events (level, event, source, corr_id, payload, error_name, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [level, eventCode, sourceTag, corrIdSafe, JSON.stringify(safePayload), safeErrorName, safeErrorCode],
    );
    return { ok: true, id: res.rows[0].id };
  } catch (err) {
    logWriteFailure('writeSystemEvent', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/**
 * Insert one row into `ingest_runs`. Same contract as writeSystemEvent.
 */
export async function writeIngestRun(input, deps = {}) {
  const getDbImpl = deps.getDbImpl || getDb;
  const {
    job, startedAt, finishedAt, status,
    symbolsRequested, symbolsWritten, rowsWritten, source, errorCode, detail,
  } = input && typeof input === 'object' ? input : {};

  const jobName = typeof job === 'string' ? job.trim() : '';
  if (!jobName) return { ok: false, reason: 'MISSING_JOB' };
  if (!ALLOWED_RUN_STATUSES_SET.has(status)) return { ok: false, reason: 'INVALID_STATUS' };

  const started = startedAt instanceof Date && !Number.isNaN(startedAt.getTime()) ? startedAt : new Date();
  const finished = finishedAt instanceof Date && !Number.isNaN(finishedAt.getTime()) ? finishedAt : null;
  const toCount = (v) => (Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);
  const safeSource = typeof source === 'string' ? truncate(source.trim(), MAX_TEXT_FIELD_CHARS) || null : null;
  const safeErrorCode = typeof errorCode === 'string' ? truncate(errorCode, MAX_TEXT_FIELD_CHARS) : null;
  const safeDetail = sanitizePayload(detail);

  let db;
  try {
    db = getDbImpl();
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }

  try {
    const res = await db.pool.query(
      `INSERT INTO ingest_runs
         (job, started_at, finished_at, status, symbols_requested, symbols_written, rows_written, source, error_code, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        jobName, started, finished, status,
        toCount(symbolsRequested), toCount(symbolsWritten), toCount(rowsWritten),
        safeSource, safeErrorCode, JSON.stringify(safeDetail),
      ],
    );
    return { ok: true, id: res.rows[0].id };
  } catch (err) {
    logWriteFailure('writeIngestRun', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/**
 * Read the most recent `system_events` rows, newest first. Optional filters
 * by `level` / `source`. Returns { ok:true, events } or { ok:false, reason }.
 */
export async function listRecentSystemEvents(opts = {}) {
  const limit = Math.min(Math.max(1, Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 50), 100);
  const level = ALLOWED_LEVELS_SET.has(opts.level) ? opts.level : null;
  const source = typeof opts.source === 'string' && opts.source.trim() ? opts.source.trim() : null;

  let db;
  try {
    db = getDb();
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }

  const conditions = [];
  const params = [];
  if (level) { params.push(level); conditions.push(`level = $${params.length}`); }
  if (source) { params.push(source); conditions.push(`source = $${params.length}`); }
  params.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const res = await db.pool.query(
      `SELECT id, ts, level, event, source, corr_id, payload, error_name, error_code
       FROM system_events
       ${where}
       ORDER BY ts DESC
       LIMIT $${params.length}`,
      params,
    );
    return { ok: true, events: res.rows };
  } catch (err) {
    logWriteFailure('listRecentSystemEvents', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/**
 * Read the most recent `ingest_runs` rows, newest first.
 */
export async function listRecentIngestRuns(opts = {}) {
  const limit = Math.min(Math.max(1, Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 50), 100);

  let db;
  try {
    db = getDb();
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }

  try {
    const res = await db.pool.query(
      `SELECT id, job, started_at, finished_at, status, symbols_requested, symbols_written, rows_written, source, error_code, detail
       FROM ingest_runs
       ORDER BY started_at DESC
       LIMIT $1`,
      [limit],
    );
    return { ok: true, runs: res.rows };
  } catch (err) {
    logWriteFailure('listRecentIngestRuns', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/**
 * Aggregate counts of `system_events` in the last `sinceMs` milliseconds,
 * grouped by level and by source. Used by the admin observability endpoint
 * to show a cheap health summary without shipping raw rows.
 */
export async function countSystemEventsSince(opts = {}) {
  const sinceMs = Number.isFinite(opts.sinceMs) && opts.sinceMs > 0 ? opts.sinceMs : 24 * 60 * 60 * 1000;

  let db;
  try {
    db = getDb();
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }

  try {
    const [byLevelRes, bySourceRes] = await Promise.all([
      db.pool.query(
        `SELECT level, count(*)::int AS count FROM system_events WHERE ts >= now() - ($1 || ' milliseconds')::interval GROUP BY level`,
        [sinceMs],
      ),
      db.pool.query(
        `SELECT source, count(*)::int AS count FROM system_events WHERE ts >= now() - ($1 || ' milliseconds')::interval GROUP BY source`,
        [sinceMs],
      ),
    ]);
    const byLevel = {};
    for (const row of byLevelRes.rows) byLevel[row.level] = row.count;
    const bySource = {};
    for (const row of bySourceRes.rows) bySource[row.source] = row.count;
    return { ok: true, byLevel, bySource };
  } catch (err) {
    logWriteFailure('countSystemEventsSince', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}
