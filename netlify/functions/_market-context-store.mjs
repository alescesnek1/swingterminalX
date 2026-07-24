import { getDb } from './_db.mjs';

export const CONTEXT_SCOPE_ID = 'global';
const RUN_BUCKET_MS = 3 * 60 * 1000;
const ROW_CHUNK_SIZE = 200;
const MICRO_CHUNK_SIZE = 25;
const SECRET_KEY = /token|secret|authorization|cookie|password|api[_-]?key|header|bearer/i;
const SAFE_STATUS = new Set(['complete', 'partial', 'unavailable', 'unsupported']);

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function intOrNull(value) {
  const n = numberOrNull(value);
  return n === null ? null : Math.trunc(n);
}
function isoDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}
function upper(value, max = 32) {
  return typeof value === 'string' ? value.trim().toUpperCase().slice(0, max) : '';
}
function json(value, fallback) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}
function sqlValues(rowCount, columns) {
  let next = 1;
  return Array.from({ length: rowCount }, () => `(${Array.from({ length: columns }, () => `$${next++}`).join(', ')})`).join(', ');
}
function safeStatus(value, fallback = 'unknown') {
  return SAFE_STATUS.has(value) ? value : fallback;
}

// Removes secret-shaped keys recursively. Diagnostics are operational metadata,
// never a storage channel for request headers, tokens, raw upstream payloads,
// or database connection failures.
export function sanitizeDiagnostics(input, depth = 0) {
  if (depth > 4 || input === null || input === undefined) return input === undefined ? {} : input;
  if (typeof input === 'string') return input.slice(0, 160);
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (Array.isArray(input)) return input.slice(0, 50).map((value) => sanitizeDiagnostics(value, depth + 1));
  if (typeof input !== 'object') return String(input).slice(0, 80);
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY.test(key)) continue;
    out[String(key).slice(0, 64)] = sanitizeDiagnostics(value, depth + 1);
  }
  return out;
}

export function makeRunKey(value = new Date()) {
  const observed = isoDate(value);
  const bucket = Math.floor(observed.getTime() / RUN_BUCKET_MS) * RUN_BUCKET_MS;
  return `global:${new Date(bucket).toISOString()}`;
}

export function normalizeMarketRow(raw, observedAt) {
  if (!raw || typeof raw !== 'object') return null;
  const market = raw.market === 'futures' ? 'futures' : raw.market === 'spot' ? 'spot' : null;
  const symbol = upper(raw.symbol || raw.pair, 32);
  const baseAsset = upper(raw.baseAsset, 24);
  const quoteAsset = upper(raw.quoteAsset, 12);
  if (!market || !symbol || !baseAsset || !quoteAsset) return null;
  return {
    market, symbol, baseAsset, quoteAsset,
    lastPrice: numberOrNull(raw.lastPrice), priceChangePercent: numberOrNull(raw.priceChangePercent),
    highPrice: numberOrNull(raw.highPrice), lowPrice: numberOrNull(raw.lowPrice),
    baseVolume: numberOrNull(raw.baseVolume), quoteVolume: numberOrNull(raw.quoteVolume),
    tradeCount: intOrNull(raw.tradeCount), observedAt: isoDate(observedAt),
    dataStatus: safeStatus(raw.dataStatus, 'complete'), diagnostics: sanitizeDiagnostics(raw.diagnostics || {}),
  };
}

export function normalizeMicrostructureRow(raw, observedAt) {
  if (!raw || typeof raw !== 'object') return null;
  const market = raw.market === 'futures' ? 'futures' : raw.market === 'spot' ? 'spot' : null;
  const symbol = upper(raw.symbol || raw.pair, 32);
  if (!market || !symbol) return null;
  const status = safeStatus(raw.dataStatus, 'unknown');
  return {
    market, symbol, observedAt: isoDate(observedAt), windowStart: raw.windowStart ? isoDate(raw.windowStart) : null,
    windowEnd: raw.windowEnd ? isoDate(raw.windowEnd) : null, dataStatus: status,
    failureCode: status === 'complete' ? null : upper(raw.failureCode, 80) || null,
    klines1m: Array.isArray(raw.klines1m) ? raw.klines1m.slice(0, 120) : [],
    depthSummary: sanitizeDiagnostics(raw.depthSummary || {}),
    tradesSummary: sanitizeDiagnostics(raw.tradesSummary || {}),
    payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {},
    missingInputs: Array.isArray(raw.missingInputs) ? raw.missingInputs.map((v) => upper(v, 80)).filter(Boolean).slice(0, 20) : [],
  };
}

function dbError(label, err) {
  console.warn(`[CONTEXT_STORE] ${label}`, { code: err?.code || null, name: err?.name || 'Error' });
}

export async function withContextTransaction(callback, deps = {}) {
  let database;
  try { database = deps.db || (deps.getDbImpl || getDb)(); } catch { return { ok: false, reason: 'DB_UNAVAILABLE' }; }
  let client;
  try { client = await database.pool.connect(); } catch { return { ok: false, reason: 'DB_UNAVAILABLE' }; }
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    if (!result?.ok) { await client.query('ROLLBACK'); return result; }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* broken connection */ }
    dbError('transaction_failed', err);
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  } finally { client.release(); }
}

export async function upsertCollectionRunByKey(db, run = {}) {
  const observedAt = isoDate(run.observedAt);
  const runKey = typeof run.runKey === 'string' && run.runKey ? run.runKey.slice(0, 80) : makeRunKey(observedAt);
  const status = ['started', 'collected', 'published', 'failed', 'skipped'].includes(run.status) ? run.status : 'started';
  try {
    const res = await db.query(
      `INSERT INTO market_collection_runs (scope_id, run_key, status, reason_code, diagnostics, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (scope_id, run_key) DO UPDATE SET updated_at = now()
       RETURNING id, run_key, status, observed_at`,
      [CONTEXT_SCOPE_ID, runKey, status, typeof run.reasonCode === 'string' ? run.reasonCode.slice(0, 80) : null, json(sanitizeDiagnostics(run.diagnostics || {}), {}), observedAt],
    );
    const row = res.rows[0];
    return { ok: true, runId: row.id, runKey: row.run_key, status: row.status, observedAt: row.observed_at };
  } catch (err) { dbError('run_upsert_failed', err); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

export async function insertMarketContextRevision(db, payload = {}) {
  const observedAt = isoDate(payload.observedAt);
  const collectedAt = isoDate(payload.collectedAt);
  const dataStatus = safeStatus(payload.dataStatus, 'partial');
  if (!payload.runId) return { ok: false, reason: 'INVALID_RUN' };
  try {
    const res = await db.query(
      `INSERT INTO market_context_snapshots (scope_id, run_id, observed_at, collected_at, data_status, diagnostics)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, observed_at, collected_at, data_status`,
      [CONTEXT_SCOPE_ID, payload.runId, observedAt, collectedAt, dataStatus, json(sanitizeDiagnostics(payload.diagnostics || {}), {})],
    );
    return { ok: true, revisionId: res.rows[0].id, ...res.rows[0] };
  } catch (err) {
    if (err?.code === '23505') return { ok: false, reason: 'RUN_ALREADY_HAS_REVISION' };
    dbError('revision_insert_failed', err); return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

export async function insertMarketRows(db, revision, rows = []) {
  const revisionId = typeof revision === 'object' ? revision.revisionId : revision;
  const normalized = rows.map((row) => normalizeMarketRow(row, revision?.observedAt)).filter(Boolean);
  if (!revisionId) return { ok: false, reason: 'INVALID_REVISION' };
  try {
    for (let offset = 0; offset < normalized.length; offset += ROW_CHUNK_SIZE) {
      const chunk = normalized.slice(offset, offset + ROW_CHUNK_SIZE); if (!chunk.length) continue;
      const values = [];
      for (const row of chunk) values.push(revisionId, row.market, row.symbol, row.baseAsset, row.quoteAsset, row.lastPrice, row.priceChangePercent, row.highPrice, row.lowPrice, row.baseVolume, row.quoteVolume, row.tradeCount, row.observedAt, row.dataStatus, json(row.diagnostics, {}));
      await db.query(`INSERT INTO market_context_rows (revision_id, market, symbol, base_asset, quote_asset, last_price, price_change_percent, high_price, low_price, base_volume, quote_volume, trade_count, observed_at, data_status, diagnostics) VALUES ${sqlValues(chunk.length, 15)}`, values);
    }
    return { ok: true, inserted: normalized.length, dropped: rows.length - normalized.length };
  } catch (err) { dbError('market_rows_insert_failed', err); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

export async function insertMicrostructureRows(db, revision, rows = []) {
  const revisionId = typeof revision === 'object' ? revision.revisionId : revision;
  const normalized = rows.map((row) => normalizeMicrostructureRow(row, revision?.observedAt)).filter(Boolean);
  if (!revisionId) return { ok: false, reason: 'INVALID_REVISION' };
  try {
    for (let offset = 0; offset < normalized.length; offset += MICRO_CHUNK_SIZE) {
      const chunk = normalized.slice(offset, offset + MICRO_CHUNK_SIZE); if (!chunk.length) continue;
      const values = [];
      for (const row of chunk) values.push(revisionId, row.market, row.symbol, row.observedAt, row.windowStart, row.windowEnd, row.dataStatus, row.failureCode, json(row.klines1m, []), json(row.depthSummary, {}), json(row.tradesSummary, {}), json(row.payload, {}), json(row.missingInputs, []));
      await db.query(`INSERT INTO market_microstructure_rows (revision_id, market, symbol, observed_at, window_start, window_end, data_status, failure_code, klines_1m, depth_summary, trades_summary, payload, missing_inputs) VALUES ${sqlValues(chunk.length, 13)}`, values);
    }
    return { ok: true, inserted: normalized.length, dropped: rows.length - normalized.length };
  } catch (err) { dbError('micro_rows_insert_failed', err); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

// Locks the one global head. A newer observed_at always wins. Publishing a new
// market revision explicitly clears radar pointers: an old RADAR result cannot
// be paired with market N+1. A future radar publisher must provide a revision
// whose market_revision_id matches the current market head.
export async function publishContextHeadSafely(db, payload = {}) {
  const marketRevisionId = Number(payload.marketRevisionId);
  if (!Number.isInteger(marketRevisionId) || marketRevisionId <= 0) return { ok: false, reason: 'INVALID_REVISION' };
  try {
    const current = await db.query(
      `SELECT h.published_market_revision_id, m.observed_at
       FROM context_heads h LEFT JOIN market_context_snapshots m ON m.id = h.published_market_revision_id
       WHERE h.scope_id = $1 FOR UPDATE`, [CONTEXT_SCOPE_ID],
    );
    const currentObservedAt = current.rows[0]?.observed_at ? new Date(current.rows[0].observed_at).getTime() : null;
    const candidate = await db.query('SELECT observed_at FROM market_context_snapshots WHERE id = $1 AND scope_id = $2', [marketRevisionId, CONTEXT_SCOPE_ID]);
    if (!candidate.rows[0]) return { ok: false, reason: 'REVISION_NOT_FOUND' };
    const candidateObservedAt = new Date(candidate.rows[0].observed_at).getTime();
    if (currentObservedAt !== null && candidateObservedAt < currentObservedAt) return { ok: false, reason: 'STALE_REVISION' };
    await db.query(
      `UPDATE context_heads SET published_market_revision_id = $2, published_radar_revision_id = NULL,
       published_radar_market_revision_id = NULL, published_at = $3, updated_at = now() WHERE scope_id = $1`,
      [CONTEXT_SCOPE_ID, marketRevisionId, candidate.rows[0].observed_at],
    );
    if (payload.runId) await db.query(`UPDATE market_collection_runs SET status = 'published', updated_at = now() WHERE id = $1`, [payload.runId]);
    return { ok: true, marketRevisionId, radarRevisionId: null, status: 'PENDING' };
  } catch (err) { dbError('head_publish_failed', err); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

export async function getPublishedContext(db, options = {}) {
  const rowLimit = Math.min(Math.max(Number(options.rowLimit) || 500, 1), 1000);
  const microLimit = Math.min(Math.max(Number(options.microLimit) || 50, 1), 200);
  try {
    const headRes = await db.query(
      `SELECT h.published_market_revision_id, h.published_radar_revision_id, h.published_at,
       m.observed_at, m.collected_at, m.data_status, m.diagnostics, r.status AS radar_status, r.market_revision_id AS radar_market_revision_id
       FROM context_heads h
       LEFT JOIN market_context_snapshots m ON m.id = h.published_market_revision_id
       LEFT JOIN radar_context_snapshots r ON r.id = h.published_radar_revision_id
       WHERE h.scope_id = $1`, [CONTEXT_SCOPE_ID],
    );
    const head = headRes.rows[0];
    if (!head?.published_market_revision_id) return { ok: true, contextVersion: null, market: null, radar: { revision: null, marketRevision: null, status: 'PENDING', payload: null } };
    const [rowsRes, microRes] = await Promise.all([
      db.query(`SELECT market, symbol, base_asset, quote_asset, last_price, price_change_percent, high_price, low_price, base_volume, quote_volume, trade_count, observed_at, data_status, diagnostics FROM market_context_rows WHERE revision_id = $1 ORDER BY quote_volume DESC NULLS LAST LIMIT $2`, [head.published_market_revision_id, rowLimit]),
      db.query(`SELECT market, symbol, observed_at, window_start, window_end, data_status, failure_code, klines_1m, depth_summary, trades_summary, missing_inputs FROM market_microstructure_rows WHERE revision_id = $1 ORDER BY market, symbol LIMIT $2`, [head.published_market_revision_id, microLimit]),
    ]);
    const ageMs = Date.now() - new Date(head.observed_at).getTime();
    const freshness = !Number.isFinite(ageMs) ? 'MISSING' : ageMs <= 6 * 60 * 1000 ? 'FRESH' : 'STALE';
    return {
      ok: true, contextVersion: head.published_market_revision_id,
      market: { revision: head.published_market_revision_id, observedAt: head.observed_at, collectedAt: head.collected_at, freshness, rows: rowsRes.rows, microstructure: microRes.rows, dataQuality: sanitizeDiagnostics(head.diagnostics || {}) },
      radar: { revision: head.published_radar_revision_id || null, marketRevision: head.published_market_revision_id, status: head.radar_status ? String(head.radar_status).toUpperCase() : 'PENDING', payload: null },
    };
  } catch (err) { dbError('published_context_read_failed', err); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

export async function getContextDiagnostics(db) {
  try {
    const res = await db.query(
      `SELECT h.published_market_revision_id, h.published_radar_revision_id, h.published_at,
       m.observed_at, m.collected_at, m.data_status, m.diagnostics,
       (SELECT count(*) FROM market_context_rows x WHERE x.revision_id = h.published_market_revision_id) AS row_count,
       (SELECT count(*) FROM market_microstructure_rows x WHERE x.revision_id = h.published_market_revision_id) AS microstructure_count
       FROM context_heads h LEFT JOIN market_context_snapshots m ON m.id = h.published_market_revision_id WHERE h.scope_id = $1`, [CONTEXT_SCOPE_ID],
    );
    const row = res.rows[0] || {};
    return { ok: true, diagnostics: sanitizeDiagnostics({ marketRevision: row.published_market_revision_id || null, radarRevision: row.published_radar_revision_id || null, publishedAt: row.published_at || null, observedAt: row.observed_at || null, collectedAt: row.collected_at || null, dataStatus: row.data_status || 'missing', rowCount: Number(row.row_count || 0), microstructureCount: Number(row.microstructure_count || 0), source: row.diagnostics || {} }) };
  } catch (err) { dbError('diagnostics_read_failed', err); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}
