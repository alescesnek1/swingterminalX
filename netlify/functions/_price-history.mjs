// Market price history storage foundation only.
//
// Writes/reads rows for `market_price_snapshots` / `market_price_points`
// (see netlify/database/migrations/20260720130902_add-market-price-history).
// No product function calls this yet — it exists so a future ingest point
// has one safe, tested path instead of hand-rolling INSERT/SELECT.
//
// SAFETY MODEL (mirrors netlify/functions/_observability.mjs)
//   - Every export returns { ok:true, ... } or { ok:false, reason }. Nothing
//     here throws for an expected failure (bad input, DB unavailable, write
//     failure) — callers can always check `.ok`. `reason` is always a
//     stable, short code, never a raw error message or connection string.
//   - raw_meta is allowlist-sanitized the same way observability payloads
//     are: dangerous-named keys (token, secret, password, auth, ids,
//     connection info) are stripped unconditionally, JSON-unsafe values are
//     dropped, and size is bounded. The full external API payload is never
//     stored.
//   - No query runs at import time. No env var is read at import time.
//   - No trading, RADAR, reclaim/absorption, alert, or Telegram side effects
//     of any kind live in this file.
import { getDb } from './_db.mjs';

export const ALLOWED_SNAPSHOT_STATUSES = Object.freeze(['ok', 'partial', 'failed']);
const ALLOWED_SNAPSHOT_STATUSES_SET = new Set(ALLOWED_SNAPSHOT_STATUSES);

const MAX_ROWS_PER_WRITE = 2000;
const MAX_RAW_META_CHARS = 500;
const MAX_TEXT_FIELD_CHARS = 200;

// Batch-insert tuning for writeMarketPriceSnapshot. 200 rows/chunk keeps a
// single INSERT well under Postgres's 65535-parameter limit (13 cols x 200
// = 2600 params) while cutting a 975-row write from ~975 sequential
// round-trips to ~5 — the fix for the Netlify function timeout a fully
// sequential per-row loop would hit at production coin-universe size.
const POINT_INSERT_COLUMNS = [
  'snapshot_id', 'symbol', 'name', 'price_usd', 'change_1h_pct', 'change_24h_pct', 'change_7d_pct',
  'volume_24h_usd', 'market_cap_usd', 'rank', 'source', 'sampled_at', 'raw_meta',
];
const INSERT_CHUNK_SIZE = 200;

// Prune tuning for pruneSnapshotsOlderThan — batched so an old, wide backlog
// is never removed via one unbounded DELETE.
const DEFAULT_PRUNE_BATCH_SIZE = 20;
const MAX_PRUNE_BATCH_SIZE = 500;
const DEFAULT_PRUNE_MAX_BATCHES = 50;
const MAX_PRUNE_MAX_BATCHES = 200;

// Same dangerous-key list/behavior as _observability.mjs's sanitizePayload,
// duplicated locally so this module has no import-time dependency on the
// observability helper's internals.
const DANGEROUS_KEYS = new Set([
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'apikey',
  'secret', 'password', 'passwd', 'authorization', 'auth', 'cookie', 'jwt',
  'chatid', 'userid', 'dburl', 'databaseurl', 'connection', 'connectionstring',
]);

function isDangerousKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return DANGEROUS_KEYS.has(normalized)
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password');
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

function sanitizeValue(value, depth) {
  if (depth > 3) return '[max-depth-exceeded]';
  if (isJsonSafePrimitive(value)) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeValue(v, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (isDangerousKey(key)) continue;
      out[key] = sanitizeValue(val, depth + 1);
    }
    return out;
  }
  return undefined;
}

// Sanitizes a raw market row into a tiny, safe `raw_meta` blob — never the
// full external API payload. Exported so tests can verify stripping
// behavior directly.
export function sanitizeRawMeta(value) {
  if (value === undefined || value === null || !isPlainObject(value)) return {};
  const cleaned = sanitizeValue(value, 0);
  let json;
  try {
    json = JSON.stringify(cleaned);
  } catch {
    return {};
  }
  if (json.length > MAX_RAW_META_CHARS) return { _truncated: true };
  return cleaned;
}

function truncate(str, max) {
  if (typeof str !== 'string') return str;
  return str.length > max ? str.slice(0, max) : str;
}

function toSafeNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toSafeInt(v) {
  const n = toSafeNumber(v);
  return n === null ? null : Math.trunc(n);
}

function firstDefined(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function logFailure(location, err) {
  // Never log err.message — pg connection errors can embed host/port
  // details. name + code (a stable Postgres SQLSTATE when present) is
  // enough to diagnose without risking a leak.
  console.warn(`[PRICE_HISTORY] ${location} failed`, { name: err?.name || 'Error', code: err?.code || null });
}

/**
 * Normalizes one raw market row into a DB-ready point object, or `null` if
 * the row has no usable symbol. Never throws for a malformed row. Missing
 * values stay `null` — nothing is invented.
 */
export function normalizePricePoint(row, sampledAt, source) {
  if (!row || typeof row !== 'object') return null;

  const rawSymbol = firstDefined(row, ['symbol', 's']);
  const symbol = typeof rawSymbol === 'string' ? rawSymbol.trim().toUpperCase() : '';
  if (!symbol) return null;

  const rawName = firstDefined(row, ['name', 'coinName']);
  const name = typeof rawName === 'string' && rawName.trim() ? truncate(rawName.trim(), MAX_TEXT_FIELD_CHARS) : null;

  // Field-alias lists must cover the ACTUAL /api/markets row shape
  // (apps/edge/netlify/edge-functions/markets.js shapeFromCoingecko /
  // _makeBinanceSpotRow) — current_price, price_change_percentage_24h,
  // total_volume, market_cap, market_cap_rank — plus the Binance-ticker
  // and generic aliases already supported for other/future sources.
  const priceUsd = toSafeNumber(firstDefined(row, ['price', 'priceUsd', 'price_usd', 'lastPrice', 'current_price']));
  const change1hPct = toSafeNumber(firstDefined(row, ['change1h', 'change_1h_pct', 'pct1h', '_c1']));
  const change24hPct = toSafeNumber(firstDefined(row, ['change24h', 'change_24h_pct', 'priceChangePercent', 'pct24h', 'price_change_percentage_24h', '_c24']));
  const change7dPct = toSafeNumber(firstDefined(row, ['change7d', 'change_7d_pct', 'pct7d', '_c7d']));
  const volume24hUsd = toSafeNumber(firstDefined(row, ['volume24h', 'quoteVolume', 'volume_24h_usd', 'total_volume']));
  const marketCapUsd = toSafeNumber(firstDefined(row, ['marketCap', 'market_cap_usd', 'market_cap']));

  const rawRank = toSafeInt(firstDefined(row, ['rank', 'marketCapRank', 'market_cap_rank']));
  const rank = rawRank !== null && rawRank > 0 ? rawRank : null;

  const sourceTag = typeof source === 'string' && source.trim() ? truncate(source.trim(), MAX_TEXT_FIELD_CHARS) : null;

  const sampledAtDate = sampledAt instanceof Date && !Number.isNaN(sampledAt.getTime())
    ? sampledAt
    : new Date();

  return {
    symbol,
    name,
    priceUsd,
    change1hPct,
    change24hPct,
    change7dPct,
    volume24hUsd,
    marketCapUsd,
    rank,
    source: sourceTag,
    sampledAt: sampledAtDate,
    rawMeta: sanitizeRawMeta(row),
  };
}

/**
 * Deduplicates normalized points by symbol, first occurrence wins. Matches
 * the DB's own `ON CONFLICT (snapshot_id, symbol) DO NOTHING` semantics, so
 * dedupe here and the unique index agree on which row survives. Exported so
 * tests can verify dedupe logic without touching the DB.
 */
export function dedupePointsBySymbol(points) {
  const bySymbol = new Map();
  let duplicates = 0;
  for (const point of points) {
    if (bySymbol.has(point.symbol)) {
      duplicates += 1;
    } else {
      bySymbol.set(point.symbol, point);
    }
  }
  return { deduped: [...bySymbol.values()], duplicates };
}

// Builds one point row's positional VALUES array, in POINT_INSERT_COLUMNS
// order. `storeRawMeta === false` stores `{}` instead of the point's own
// sanitized raw_meta — the scheduled collector passes this to cut storage,
// since nothing downstream (listRecentPricePoints, the reclaim/absorption
// analyzers) ever reads raw_meta.
function buildPointRowValues(snapshotId, point, storeRawMeta) {
  const rawMeta = storeRawMeta === false ? {} : point.rawMeta;
  return [
    snapshotId, point.symbol, point.name, point.priceUsd, point.change1hPct,
    point.change24hPct, point.change7dPct, point.volume24hUsd, point.marketCapUsd,
    point.rank, point.source, point.sampledAt, JSON.stringify(rawMeta),
  ];
}

// Builds a multi-row `INSERT ... VALUES (...), (...), ... ON CONFLICT DO
// NOTHING` statement for `rowCount` rows of POINT_INSERT_COLUMNS.length
// columns each, with sequential $N placeholders.
function buildBatchInsertQuery(rowCount) {
  const perRow = POINT_INSERT_COLUMNS.length;
  const valuesClauses = [];
  let paramIndex = 1;
  for (let i = 0; i < rowCount; i += 1) {
    const placeholders = [];
    for (let c = 0; c < perRow; c += 1) {
      placeholders.push(`$${paramIndex}`);
      paramIndex += 1;
    }
    valuesClauses.push(`(${placeholders.join(', ')})`);
  }
  return `INSERT INTO market_price_points (${POINT_INSERT_COLUMNS.join(', ')})
       VALUES ${valuesClauses.join(', ')}
       ON CONFLICT (snapshot_id, symbol) DO NOTHING`;
}

/**
 * Writes one snapshot row plus its normalized, deduped point rows. Returns
 * { ok:true, snapshotId, inserted, dropped, duplicates } or
 * { ok:false, reason }. Rows sharing a symbol within one batch are deduped
 * before insert (first occurrence wins) so `inserted` and the snapshot's
 * `coin_count` always reflect actual insertable rows, never attempted
 * inserts — `inserted` itself is summed from each batch INSERT's rowCount,
 * so it always equals the number of rows that actually landed in the DB
 * even if the unique constraint ever skips one unexpectedly. Points are
 * inserted in chunks of INSERT_CHUNK_SIZE via a multi-row VALUES statement
 * rather than one query per row — same ON CONFLICT semantics, far fewer
 * round-trips. Pass `storeRawMeta:false` to store `{}` instead of each
 * row's sanitized raw_meta (the scheduled collector's default, to reduce
 * storage — nothing downstream reads raw_meta). Never throws for
 * DB-unavailable or invalid input. No trading, alert, or Telegram side
 * effects — this is a storage write only.
 */
export async function writeMarketPriceSnapshot(input, deps = {}) {
  const getDbImpl = deps.getDbImpl || getDb;
  const { source, sampledAt, rows, metadata, storeRawMeta } = input && typeof input === 'object' ? input : {};

  const sourceTag = typeof source === 'string' ? source.trim() : '';
  if (!sourceTag) return { ok: false, reason: 'MISSING_SOURCE' };
  if (!Array.isArray(rows)) return { ok: false, reason: 'INVALID_ROWS' };

  const sampledAtDate = sampledAt instanceof Date && !Number.isNaN(sampledAt.getTime())
    ? sampledAt
    : new Date();

  const boundedRows = rows.slice(0, MAX_ROWS_PER_WRITE);
  const normalized = [];
  let dropped = rows.length - boundedRows.length;
  for (const row of boundedRows) {
    const point = normalizePricePoint(row, sampledAtDate, sourceTag);
    if (point) normalized.push(point);
    else dropped += 1;
  }

  const { deduped, duplicates } = dedupePointsBySymbol(normalized);

  const safeMetadata = sanitizeRawMeta(metadata);
  const status = ALLOWED_SNAPSHOT_STATUSES_SET.has(input?.status) ? input.status : 'ok';

  let db;
  try {
    db = getDbImpl();
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }

  const client = await (async () => {
    try {
      return await db.pool.connect();
    } catch {
      return null;
    }
  })();
  if (!client) return { ok: false, reason: 'DB_UNAVAILABLE' };

  try {
    await client.query('BEGIN');
    const snapshotRes = await client.query(
      `INSERT INTO market_price_snapshots (source, sampled_at, coin_count, status, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [sourceTag, sampledAtDate, deduped.length, status, JSON.stringify(safeMetadata)],
    );
    const snapshotId = snapshotRes.rows[0].id;

    let inserted = 0;
    for (let i = 0; i < deduped.length; i += INSERT_CHUNK_SIZE) {
      const chunk = deduped.slice(i, i + INSERT_CHUNK_SIZE);
      const values = [];
      for (const point of chunk) {
        values.push(...buildPointRowValues(snapshotId, point, storeRawMeta));
      }
      const chunkRes = await client.query(buildBatchInsertQuery(chunk.length), values);
      inserted += chunkRes.rowCount;
    }

    await client.query('COMMIT');
    return { ok: true, snapshotId, inserted, dropped, duplicates };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    logFailure('writeMarketPriceSnapshot', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  } finally {
    client.release();
  }
}

/**
 * Reads the most recent points for one symbol, newest first. `raw_meta` is
 * never included by default. Returns { ok:true, points } or
 * { ok:false, reason }.
 */
export async function listRecentPricePoints(opts = {}, deps = {}) {
  const getDbImpl = deps.getDbImpl || getDb;
  const rawSymbol = typeof opts.symbol === 'string' ? opts.symbol.trim().toUpperCase() : '';
  if (!rawSymbol) return { ok: false, reason: 'MISSING_SYMBOL' };
  const limit = Math.min(Math.max(1, Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 100), 500);

  let db;
  try {
    db = getDbImpl();
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }

  try {
    const res = await db.pool.query(
      `SELECT id, snapshot_id, symbol, name, price_usd, change_1h_pct, change_24h_pct, change_7d_pct,
              volume_24h_usd, market_cap_usd, rank, source, sampled_at
       FROM market_price_points
       WHERE symbol = $1
       ORDER BY sampled_at DESC
       LIMIT $2`,
      [rawSymbol, limit],
    );
    return { ok: true, points: res.rows };
  } catch (err) {
    logFailure('listRecentPricePoints', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/**
 * Reads the most recent snapshot metadata rows, newest first. Returns
 * { ok:true, snapshots } or { ok:false, reason }.
 */
export async function listRecentSnapshots(opts = {}, deps = {}) {
  const getDbImpl = deps.getDbImpl || getDb;
  const limit = Math.min(Math.max(1, Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 50), 200);

  let db;
  try {
    db = getDbImpl();
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }

  try {
    const res = await db.pool.query(
      `SELECT id, source, sampled_at, coin_count, status, metadata, created_at
       FROM market_price_snapshots
       ORDER BY sampled_at DESC
       LIMIT $1`,
      [limit],
    );
    return { ok: true, snapshots: res.rows };
  } catch (err) {
    logFailure('listRecentSnapshots', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/**
 * Reads the timestamp of the most recent snapshot for one `source`, via the
 * existing (source, sampled_at DESC) index — used by the scheduled
 * collector's min-spacing guard so a double-fire never re-fetches or
 * re-writes within the configured window. Returns
 * { ok:true, sampledAt } (`null` when no snapshot exists yet for that
 * source) or { ok:false, reason }. Never throws.
 */
export async function getLatestSnapshotAt(opts = {}, deps = {}) {
  const getDbImpl = deps.getDbImpl || getDb;
  const sourceTag = typeof opts.source === 'string' ? opts.source.trim() : '';
  if (!sourceTag) return { ok: false, reason: 'MISSING_SOURCE' };

  let db;
  try {
    db = getDbImpl();
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }

  try {
    const res = await db.pool.query(
      `SELECT sampled_at FROM market_price_snapshots WHERE source = $1 ORDER BY sampled_at DESC LIMIT 1`,
      [sourceTag],
    );
    return { ok: true, sampledAt: res.rows[0] ? res.rows[0].sampled_at : null };
  } catch (err) {
    logFailure('getLatestSnapshotAt', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

/**
 * Deletes snapshots (and, via ON DELETE CASCADE, their points) older than
 * `days`, in bounded batches of at most `batchSize` rows per DELETE so a
 * large backlog can never be removed via one unbounded statement. Missing,
 * non-numeric, or non-positive `days` deletes nothing and returns
 * { ok:false, reason:'PRUNE_INVALID_RETENTION', prunedSnapshots:0 } — a
 * misconfigured retention value must never silently become "delete
 * everything." Returns { ok:true, prunedSnapshots, reason:null } on
 * success, or { ok:false, reason, prunedSnapshots } (partial progress kept)
 * on DB failure. Never throws.
 */
export async function pruneSnapshotsOlderThan(opts = {}, deps = {}) {
  const getDbImpl = deps.getDbImpl || getDb;
  const daysNum = Number(opts.days);
  if (!Number.isFinite(daysNum) || daysNum <= 0) {
    return { ok: false, reason: 'PRUNE_INVALID_RETENTION', prunedSnapshots: 0 };
  }

  const batchSizeNum = Number(opts.batchSize);
  const batchSize = Number.isFinite(batchSizeNum) && batchSizeNum > 0
    ? Math.min(Math.trunc(batchSizeNum), MAX_PRUNE_BATCH_SIZE)
    : DEFAULT_PRUNE_BATCH_SIZE;

  const maxBatchesNum = Number(opts.maxBatches);
  const maxBatches = Number.isFinite(maxBatchesNum) && maxBatchesNum > 0
    ? Math.min(Math.trunc(maxBatchesNum), MAX_PRUNE_MAX_BATCHES)
    : DEFAULT_PRUNE_MAX_BATCHES;

  const cutoff = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000);

  let db;
  try {
    db = getDbImpl();
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE', prunedSnapshots: 0 };
  }

  let prunedSnapshots = 0;
  try {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const res = await db.pool.query(
        `DELETE FROM market_price_snapshots
         WHERE id IN (
           SELECT id FROM market_price_snapshots
           WHERE sampled_at < $1
           ORDER BY sampled_at ASC
           LIMIT $2
         )`,
        [cutoff, batchSize],
      );
      prunedSnapshots += res.rowCount;
      if (res.rowCount < batchSize) break; // fewer than a full batch = nothing older remains
    }
    return { ok: true, prunedSnapshots, reason: null };
  } catch (err) {
    logFailure('pruneSnapshotsOlderThan', err);
    return { ok: false, reason: 'PRUNE_FAILED', prunedSnapshots };
  }
}
