import { getDb } from './_db.mjs';

export const CONTEXT_SCOPE_ID = 'global';
const RUN_BUCKET_MS = 3 * 60 * 1000;
// Rows per multi-VALUES INSERT. Each chunk is one round trip, so this directly
// sets how long a collection cycle takes: at 100 a futures-enabled cycle issued
// ~150 statements and ran ~29s against the 30s function limit (functions are in
// eu-central-1, the database is not co-located, so every round trip is costly).
// The widest insert here binds 20 columns, so 500 rows = 10,000 bind parameters,
// comfortably inside PostgreSQL's 65,535 limit.
const INSERT_CHUNK = 500;
// Must match the collector band in scripts/radar/rolling-microstructure-snapshot.mjs
// (validateTrustedRollingRow). Picking a depth baseline outside this band yields a
// windowSec the STRICT validator will reject for every symbol of the run.
const COLLECTOR_WINDOW_MIN_SEC = 120;
const COLLECTOR_WINDOW_MAX_SEC = 900;
const SECRET_KEY = /token|secret|authorization|cookie|password|api[_-]?key|header|bearer/i;
const SAFE_STATUS = new Set(['complete', 'partial', 'unavailable', 'unsupported']);

function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function integerOrNull(value) { const n = numberOrNull(value); return n === null ? null : Math.trunc(n); }
function asDate(value, fallback = new Date()) { const d = value instanceof Date ? value : new Date(value); return Number.isNaN(d.getTime()) ? fallback : d; }
function upper(value, max = 32) { return typeof value === 'string' ? value.trim().toUpperCase().slice(0, max) : ''; }
function safeStatus(value, fallback = 'partial') { return SAFE_STATUS.has(value) ? value : fallback; }
function safeJson(value, fallback = {}) { try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); } }
function valuesSql(rows, columns) { let p = 1; return Array.from({ length: rows }, () => `(${Array.from({ length: columns }, () => `$${p++}`).join(', ')})`).join(', '); }
function chunks(rows) { const out = []; for (let i = 0; i < rows.length; i += INSERT_CHUNK) out.push(rows.slice(i, i + INSERT_CHUNK)); return out; }
function dbError(label, error) { console.warn(`[ATOMIC_MARKET_STORE] ${label}`, { code: error?.code || null, name: error?.name || 'Error' }); }

export function sanitizeDiagnostics(input, depth = 0) {
  if (depth > 4 || input === null || input === undefined) return input === undefined ? {} : input;
  if (typeof input === 'string') return input.slice(0, 160);
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (Array.isArray(input)) return input.slice(0, 50).map((value) => sanitizeDiagnostics(value, depth + 1));
  if (typeof input !== 'object') return String(input).slice(0, 80);
  const clean = {};
  for (const [key, value] of Object.entries(input)) if (!SECRET_KEY.test(key)) clean[String(key).slice(0, 64)] = sanitizeDiagnostics(value, depth + 1);
  return clean;
}

export function makeRunKey(value = new Date()) {
  const observed = asDate(value); const bucket = Math.floor(observed.getTime() / RUN_BUCKET_MS) * RUN_BUCKET_MS;
  return `global:${new Date(bucket).toISOString()}`;
}

function normalizeTicker(raw, observedAt) {
  const market = raw?.market === 'futures' ? 'futures' : raw?.market === 'spot' ? 'spot' : null;
  const symbol = upper(raw?.symbol || raw?.pair); const baseAsset = upper(raw?.baseAsset, 24); const quoteAsset = upper(raw?.quoteAsset, 12);
  if (!market || !symbol || !baseAsset || !quoteAsset) return null;
  return { market, symbol, baseAsset, quoteAsset, observedAt: asDate(observedAt), lastPrice: numberOrNull(raw.lastPrice), priceChangePercent: numberOrNull(raw.priceChangePercent), highPrice: numberOrNull(raw.highPrice), lowPrice: numberOrNull(raw.lowPrice), baseVolume: numberOrNull(raw.baseVolume), quoteVolume: numberOrNull(raw.quoteVolume), tradeCount: integerOrNull(raw.tradeCount), change1hPct: numberOrNull(raw.change1hPct), change4hPct: numberOrNull(raw.change4hPct), change12hPct: numberOrNull(raw.change12hPct), change7dPct: numberOrNull(raw.change7dPct), dataStatus: safeStatus(raw.dataStatus, 'complete'), diagnostics: sanitizeDiagnostics(raw.diagnostics || {}) };
}
function normalizedMicro(raw, observedAt) {
  const market = raw?.market === 'futures' ? 'futures' : raw?.market === 'spot' ? 'spot' : null; const symbol = upper(raw?.symbol || raw?.pair);
  if (!market || !symbol) return null;
  const depth = raw.orderBook && typeof raw.orderBook === 'object' ? raw.orderBook : {};
  return { market, symbol, observedAt: asDate(observedAt), windowStart: raw.windowStart ? asDate(raw.windowStart) : null, windowEnd: raw.windowEnd ? asDate(raw.windowEnd) : null, dataStatus: safeStatus(raw.dataStatus, 'partial'), failureCode: typeof raw.failureCode === 'string' ? upper(raw.failureCode, 80) || null : null, missingInputs: Array.isArray(raw.missingInputs) ? raw.missingInputs.map((v) => upper(v, 80)).filter(Boolean).slice(0, 20) : [], klines: Array.isArray(raw.klines1m) ? raw.klines1m.slice(0, 120) : [], bids: Array.isArray(depth.bids) ? depth.bids.slice(0, 100) : [], asks: Array.isArray(depth.asks) ? depth.asks.slice(0, 100) : [], depthUpdateId: integerOrNull(depth.lastUpdateId), aggTrades: Array.isArray(raw.aggTrades) ? raw.aggTrades.slice(0, 500) : [], depthSummary: raw.depthSummary || {}, tradesSummary: raw.tradesSummary || {}, absorb: raw.absorb && typeof raw.absorb === 'object' && !Array.isArray(raw.absorb) ? raw.absorb : null };
}
function normalKline(micro, row) {
  if (!Array.isArray(row)) return null; const openMs = numberOrNull(row[0]); const closeMs = numberOrNull(row[6]);
  const values = [row[1], row[2], row[3], row[4], row[5]].map(numberOrNull); if (openMs === null || closeMs === null || values.some((v) => v === null)) return null;
  return { market: micro.market, symbol: micro.symbol, openTime: new Date(openMs), closeTime: new Date(closeMs), openPrice: values[0], highPrice: values[1], lowPrice: values[2], closePrice: values[3], baseVolume: values[4], quoteVolume: numberOrNull(row[7]), tradeCount: integerOrNull(row[8]), isClosed: closeMs <= micro.observedAt.getTime() };
}
function normalLevels(micro, side, rows) {
  return rows.map((row, index) => { const price = numberOrNull(row?.[0]); const quantity = numberOrNull(row?.[1]); return price === null || quantity === null ? null : { market: micro.market, symbol: micro.symbol, observedAt: micro.observedAt, sourceUpdateId: micro.depthUpdateId, side, levelRank: index + 1, price, quantity }; }).filter(Boolean);
}
function normalTrades(micro) {
  return micro.aggTrades.map((row) => { const id = integerOrNull(row?.a); const eventMs = numberOrNull(row?.T); const price = numberOrNull(row?.p); const quantity = numberOrNull(row?.q); if (id === null || eventMs === null || price === null || quantity === null || typeof row?.m !== 'boolean') return null; return { market: micro.market, symbol: micro.symbol, aggTradeId: id, eventTime: new Date(eventMs), price, quantity, quoteQuantity: price * quantity, buyerIsMaker: row.m, isBestMatch: typeof row.M === 'boolean' ? row.M : null }; }).filter(Boolean);
}

export async function withContextTransaction(callback, deps = {}) {
  let database; try { database = deps.db || (deps.getDbImpl || getDb)(); } catch { return { ok: false, reason: 'DB_UNAVAILABLE' }; }
  let client; try { client = await database.pool.connect(); } catch { return { ok: false, reason: 'DB_UNAVAILABLE' }; }
  try { await client.query('BEGIN'); const result = await callback(client); if (!result?.ok) { await client.query('ROLLBACK'); return result; } await client.query('COMMIT'); return result; }
  catch (error) { try { await client.query('ROLLBACK'); } catch {} dbError('transaction_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
  finally { client.release(); }
}

export async function upsertCollectionRunByKey(db, run = {}) {
  const observedAt = asDate(run.observedAt); const runKey = typeof run.runKey === 'string' && run.runKey ? run.runKey.slice(0, 80) : makeRunKey(observedAt);
  try {
    const res = await db.query(`INSERT INTO market_collection_runs (scope_id, run_key, status, reason_code, diagnostics, observed_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (scope_id, run_key) DO UPDATE SET
        status = CASE WHEN market_collection_runs.status = 'published' THEN 'published' ELSE EXCLUDED.status END,
        updated_at = now()
      RETURNING id, run_key, status, observed_at`, [CONTEXT_SCOPE_ID, runKey, 'started', null, safeJson(sanitizeDiagnostics(run.diagnostics || {})), observedAt]);
    const row = res.rows[0]; return { ok: true, runId: row.id, runKey: row.run_key, status: row.status, observedAt: row.observed_at };
  } catch (error) { dbError('run_upsert_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

async function upsertInstruments(db, rows) {
  for (const chunk of chunks(rows)) { const values = []; for (const row of chunk) values.push(row.market, row.symbol, row.baseAsset, row.quoteAsset, row.observedAt); await db.query(`INSERT INTO market_instruments (market,symbol,base_asset,quote_asset,last_seen_at) VALUES ${valuesSql(chunk.length, 5)} ON CONFLICT (market,symbol) DO UPDATE SET base_asset=EXCLUDED.base_asset, quote_asset=EXCLUDED.quote_asset, last_seen_at=EXCLUDED.last_seen_at`, values); }
}
async function insertTickers(db, runId, rows) {
  for (const chunk of chunks(rows)) { const values = []; for (const row of chunk) values.push(runId,row.market,row.symbol,row.observedAt,row.lastPrice,row.priceChangePercent,row.highPrice,row.lowPrice,row.baseVolume,row.quoteVolume,row.tradeCount,row.change1hPct,row.change4hPct,row.change12hPct,row.change7dPct,row.dataStatus,safeJson(row.diagnostics)); await db.query(`INSERT INTO market_ticker_observations (run_id,market,symbol,observed_at,last_price,price_change_percent,high_price,low_price,base_volume,quote_volume,trade_count,change_1h_pct,change_4h_pct,change_12h_pct,change_7d_pct,data_status,diagnostics) VALUES ${valuesSql(chunk.length,17)} ON CONFLICT (run_id,market,symbol) DO NOTHING`, values); }
}
async function insertCandles(db, runId, rows) {
  for (const chunk of chunks(rows)) { const values=[]; for (const row of chunk) values.push(runId,row.market,row.symbol,row.openTime,row.closeTime,row.openPrice,row.highPrice,row.lowPrice,row.closePrice,row.baseVolume,row.quoteVolume,row.tradeCount,row.isClosed); await db.query(`INSERT INTO market_candles_1m (run_id,market,symbol,open_time,close_time,open_price,high_price,low_price,close_price,base_volume,quote_volume,trade_count,is_closed) VALUES ${valuesSql(chunk.length,13)} ON CONFLICT (market,symbol,open_time) DO UPDATE SET run_id=EXCLUDED.run_id,close_time=EXCLUDED.close_time,high_price=EXCLUDED.high_price,low_price=EXCLUDED.low_price,close_price=EXCLUDED.close_price,base_volume=EXCLUDED.base_volume,quote_volume=EXCLUDED.quote_volume,trade_count=EXCLUDED.trade_count,is_closed=EXCLUDED.is_closed`, values); }
}
async function insertLevels(db, runId, rows) {
  for (const chunk of chunks(rows)) { const values=[]; for (const row of chunk) values.push(runId,row.market,row.symbol,row.observedAt,row.sourceUpdateId,row.side,row.levelRank,row.price,row.quantity); await db.query(`INSERT INTO market_order_book_levels (run_id,market,symbol,observed_at,source_update_id,side,level_rank,price,quantity) VALUES ${valuesSql(chunk.length,9)} ON CONFLICT (run_id,market,symbol,side,level_rank) DO NOTHING`, values); }
}
async function insertTrades(db, runId, rows) {
  for (const chunk of chunks(rows)) { const values=[]; for (const row of chunk) values.push(runId,row.market,row.symbol,row.aggTradeId,row.eventTime,row.price,row.quantity,row.quoteQuantity,row.buyerIsMaker,row.isBestMatch); await db.query(`INSERT INTO market_agg_trades (run_id,market,symbol,agg_trade_id,event_time,price,quantity,quote_quantity,buyer_is_maker,is_best_match) VALUES ${valuesSql(chunk.length,10)} ON CONFLICT (market,symbol,agg_trade_id) DO NOTHING`, values); }
}
async function insertMeasurements(db, runId, rows) {
  for (const chunk of chunks(rows)) { const values=[]; for (const row of chunk) { const depth=row.depthSummary||{}; const trades=row.tradesSummary||{}; values.push(runId,row.market,row.symbol,row.observedAt,row.windowStart,row.windowEnd,row.dataStatus,row.failureCode,row.missingInputs,row.klines.length,integerOrNull(depth?.levels?.bids)||0,integerOrNull(depth?.levels?.asks)||0,numberOrNull(depth.bestBid),numberOrNull(depth.bestAsk),numberOrNull(depth.spreadBps),numberOrNull(depth.bidQuote),numberOrNull(depth.askQuote),integerOrNull(trades.count)||0,numberOrNull(trades.takerBuyQuote),numberOrNull(trades.takerSellQuote),row.absorb ? safeJson(sanitizeDiagnostics(row.absorb)) : null); } await db.query(`INSERT INTO market_microstructure_measurements (run_id,market,symbol,observed_at,window_start,window_end,data_status,failure_code,missing_inputs,candle_count,order_book_bid_levels,order_book_ask_levels,best_bid,best_ask,spread_bps,bid_quote_depth,ask_quote_depth,agg_trade_count,taker_buy_quote,taker_sell_quote,absorb) VALUES ${valuesSql(chunk.length,21)} ON CONFLICT (run_id,market,symbol) DO NOTHING`, values); }
}

// Newest published run that is far enough back to be an honest depth baseline,
// plus that run's per-symbol bid depth. Shared by the collector (which computes
// absorption at collection time) and the RADAR bundle so both agree on what
// "previous" means; picking a drifted run seconds away yields a window the STRICT
// validator rejects for every symbol at once.
export async function getMicrostructureBaseline(db, observedAt) {
  const atMs = new Date(observedAt).getTime();
  if (!Number.isFinite(atMs)) return { ok: false, reason: 'INVALID_OBSERVED_AT' };
  try {
    const runsRes = await db.query(`SELECT id, observed_at FROM market_collection_runs WHERE scope_id=$1 AND status='published' AND observed_at < $2 ORDER BY observed_at DESC LIMIT 12`, [CONTEXT_SCOPE_ID, new Date(atMs)]);
    const elapsedSec = (row) => Math.round((atMs - new Date(row.observed_at).getTime()) / 1000);
    const run = runsRes.rows.find((row) => { const sec = elapsedSec(row); return sec >= COLLECTOR_WINDOW_MIN_SEC && sec <= COLLECTOR_WINDOW_MAX_SEC; }) || null;
    if (!run) {
      if (runsRes.rows.length) console.warn('[ATOMIC_MARKET_STORE] no_absorb_baseline_in_window', { candidates: runsRes.rows.length, nearestSec: elapsedSec(runsRes.rows[0]), band: [COLLECTOR_WINDOW_MIN_SEC, COLLECTOR_WINDOW_MAX_SEC] });
      return { ok: true, run: null, windowSec: null, bidDepth: new Map() };
    }
    const depthRes = await db.query(`SELECT market,symbol,bid_quote_depth FROM market_microstructure_measurements WHERE run_id=$1`, [run.id]);
    return { ok: true, run: { id: run.id, observedAt: run.observed_at }, windowSec: elapsedSec(run), bidDepth: new Map(depthRes.rows.map((r) => [`${r.market}:${r.symbol}`, num(r.bid_quote_depth)])) };
  } catch (error) { dbError('absorb_baseline_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

export async function insertAtomicMarketRecords(db, payload = {}) {
  const runId = Number(payload.runId); if (!Number.isInteger(runId) || runId <= 0) return { ok: false, reason: 'INVALID_RUN' };
  const observedAt = asDate(payload.observedAt); const tickers = (payload.rows || []).map((row) => normalizeTicker(row, observedAt)).filter(Boolean); const micro = (payload.microstructure || []).map((row) => normalizedMicro(row, observedAt)).filter(Boolean);
  try {
    await upsertInstruments(db, tickers); await insertTickers(db, runId, tickers);
    const candles = micro.flatMap((row) => row.klines.map((kline) => normalKline(row, kline)).filter(Boolean));
    const levels = micro.flatMap((row) => [...normalLevels(row, 'bid', row.bids), ...normalLevels(row, 'ask', row.asks)]);
    const trades = micro.flatMap(normalTrades);
    await insertCandles(db, runId, candles); await insertLevels(db, runId, levels); await insertTrades(db, runId, trades); await insertMeasurements(db, runId, micro);
    return { ok: true, tickerCount: tickers.length, candleCount: candles.length, orderBookLevelCount: levels.length, aggTradeCount: trades.length, measurementCount: micro.length, droppedTickerCount: (payload.rows || []).length - tickers.length, droppedMicrostructureCount: (payload.microstructure || []).length - micro.length };
  } catch (error) { dbError('atomic_insert_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

export async function completeCollectionRun(db, payload = {}) {
  const runId = Number(payload.runId); if (!Number.isInteger(runId) || runId <= 0) return { ok: false, reason: 'INVALID_RUN' };
  try { await db.query(`UPDATE market_collection_runs SET status='published', reason_code=NULL, diagnostics=$2, completed_at=$3, updated_at=now() WHERE id=$1`, [runId,safeJson(sanitizeDiagnostics(payload.diagnostics || {})),asDate(payload.completedAt)]); return { ok: true }; }
  catch (error) { dbError('run_complete_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

export async function getAtomizedMarketContext(db, options = {}) {
  const tickerLimit = Math.min(Math.max(Number(options.tickerLimit) || 500, 1), 1000); const microLimit = Math.min(Math.max(Number(options.microLimit) || 50, 1), 200);
  try {
    const runRes = await db.query(`SELECT id,run_key,observed_at,completed_at,diagnostics FROM market_collection_runs WHERE scope_id=$1 AND status='published' ORDER BY observed_at DESC LIMIT 1`, [CONTEXT_SCOPE_ID]); const run = runRes.rows[0];
    if (!run) return { ok: true, contextVersion: null, run: null, market: null, radar: { status: 'PENDING' } };
    const [tickers, micro] = await Promise.all([
      db.query(`SELECT market,symbol,last_price,price_change_percent,high_price,low_price,base_volume,quote_volume,trade_count,change_1h_pct,change_4h_pct,change_12h_pct,change_7d_pct,observed_at,data_status,diagnostics FROM market_ticker_observations WHERE run_id=$1 ORDER BY quote_volume DESC NULLS LAST LIMIT $2`, [run.id,tickerLimit]),
      db.query(`SELECT market,symbol,observed_at,window_start,window_end,data_status,failure_code,missing_inputs,candle_count,order_book_bid_levels,order_book_ask_levels,best_bid,best_ask,spread_bps,bid_quote_depth,ask_quote_depth,agg_trade_count,taker_buy_quote,taker_sell_quote FROM market_microstructure_measurements WHERE run_id=$1 ORDER BY market,symbol LIMIT $2`, [run.id,microLimit]),
    ]);
    const ageMs = Date.now() - new Date(run.observed_at).getTime(); const freshness = !Number.isFinite(ageMs) ? 'MISSING' : ageMs <= 6 * 60 * 1000 ? 'FRESH' : 'STALE';
    const radar = await readRadarForRun(db, run.id);
    return { ok: true, contextVersion: null, run: { id: run.id, key: run.run_key, observedAt: run.observed_at, completedAt: run.completed_at }, market: { observedAt: run.observed_at, freshness, tickers: tickers.rows, microstructure: micro.rows, dataQuality: sanitizeDiagnostics(run.diagnostics || {}) }, radar };
  } catch (error) { dbError('atomic_context_read_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

export async function getContextDiagnostics(db) {
  try { const result = await db.query(`SELECT id,run_key,observed_at,completed_at,(SELECT count(*) FROM market_ticker_observations t WHERE t.run_id=r.id) AS ticker_count,(SELECT count(*) FROM market_microstructure_measurements m WHERE m.run_id=r.id) AS measurement_count FROM market_collection_runs r WHERE scope_id=$1 AND status='published' ORDER BY observed_at DESC LIMIT 1`, [CONTEXT_SCOPE_ID]); const row=result.rows[0]; return { ok:true, diagnostics: row ? { runId:row.id,runKey:row.run_key,observedAt:row.observed_at,completedAt:row.completed_at,tickerCount:Number(row.ticker_count),measurementCount:Number(row.measurement_count) } : { runId:null, tickerCount:0, measurementCount:0 } }; }
  catch (error) { dbError('diagnostics_read_failed', error); return { ok:false, reason:'DB_UNAVAILABLE' }; }
}

// ── RADAR result persistence (derived, disposable, keyed by run) ─────────────
// A RADAR result is computed by the publisher over ONE published market run and
// is the canonical read for that run. There is no revision head / CAS here: the
// published market run IS the head, and the result that references it is the read.

const num = (value) => (value === null || value === undefined ? null : (Number.isFinite(Number(value)) ? Number(value) : null));

// Reads everything the RADAR publisher needs for the latest published run: the
// full ticker universe (for regime/stage/breadth) plus, for the collected top-N
// microstructure symbols, the raw agg trades / 1m candles / depth (N and N-1) so
// STRICT_ABSORB can be measured honestly from the database.
export async function getRadarInputBundle(db, options = {}) {
  const topN = Math.min(Math.max(Number(options.topN) || 8, 1), 50);
  const tickerLimit = Math.min(Math.max(Number(options.tickerLimit) || 1000, 1), 2000);
  const candleLimit = Math.min(Math.max(Number(options.candleLimit) || 60, 30), 120);
  try {
    // The depth-rebuild baseline is the previous run, but "previous" must be far
    // enough back to be a real window. The Netlify scheduler drifts, so two
    // consecutive published runs can land seconds apart; taking row[1] blindly
    // then produced a sub-120s windowSec and the STRICT validator rejected EVERY
    // symbol of that run at once (observed: all 5 rejected 'window-invalid').
    // Pick the newest earlier run that actually falls inside the honest collector
    // band instead — the reported window stays the true elapsed time, never padded.
    const runsRes = await db.query(`SELECT id, observed_at FROM market_collection_runs WHERE scope_id=$1 AND status='published' ORDER BY observed_at DESC LIMIT 12`, [CONTEXT_SCOPE_ID]);
    const latest = runsRes.rows[0];
    if (!latest) return { ok: true, run: null, windowSec: null, tickers: [], microSymbols: [] };
    const latestMs = new Date(latest.observed_at).getTime();
    const elapsedSec = (row) => Math.round((latestMs - new Date(row.observed_at).getTime()) / 1000);
    const prev = runsRes.rows.slice(1).find((row) => { const sec = elapsedSec(row); return sec >= COLLECTOR_WINDOW_MIN_SEC && sec <= COLLECTOR_WINDOW_MAX_SEC; }) || null;
    if (!prev && runsRes.rows.length > 1) console.warn('[ATOMIC_MARKET_STORE] no_baseline_run_in_window', { runId: latest.id, candidates: runsRes.rows.length - 1, nearestSec: elapsedSec(runsRes.rows[1]), band: [COLLECTOR_WINDOW_MIN_SEC, COLLECTOR_WINDOW_MAX_SEC] });
    const windowSec = prev ? elapsedSec(prev) : null;
    const [tickRes, measRes] = await Promise.all([
      db.query(`SELECT market,symbol,last_price,price_change_percent,high_price,low_price,base_volume,quote_volume,trade_count,change_1h_pct,change_4h_pct,change_12h_pct,change_7d_pct,observed_at,data_status FROM market_ticker_observations WHERE run_id=$1 ORDER BY quote_volume DESC NULLS LAST LIMIT $2`, [latest.id, tickerLimit]),
      // One row per SYMBOL, deepest venue first. The rolling snapshot the RADAR
      // consumes is keyed by symbol alone, so returning both venues of one symbol
      // would spend two of the topN slots on a single measured symbol and silently
      // drop one of them at merge time. DISTINCT ON keeps the busier venue.
      db.query(`SELECT * FROM (SELECT DISTINCT ON (symbol) market,symbol,observed_at,window_start,window_end,data_status,spread_bps,bid_quote_depth,ask_quote_depth,taker_buy_quote,taker_sell_quote,best_bid,best_ask,agg_trade_count,absorb, (COALESCE(taker_buy_quote,0)+COALESCE(taker_sell_quote,0)) AS taker_total FROM market_microstructure_measurements WHERE run_id=$1 ORDER BY symbol, taker_total DESC) m ORDER BY m.taker_total DESC LIMIT $2`, [latest.id, topN]),
    ]);
    let prevDepth = new Map();
    if (prev) { const prevRes = await db.query(`SELECT market,symbol,bid_quote_depth FROM market_microstructure_measurements WHERE run_id=$1`, [prev.id]); prevDepth = new Map(prevRes.rows.map((r) => [`${r.market}:${r.symbol}`, num(r.bid_quote_depth)])); }

    // Candles for EVERY measured symbol in one windowed query. The previous
    // per-symbol query cost one round trip per symbol, which caps the universe at
    // a handful; a per-partition ROW_NUMBER returns the same rows in a single
    // trip regardless of how many symbols were measured.
    const keys = measRes.rows.map((m) => `${m.market}:${m.symbol}`);
    const klinesByKey = new Map();
    if (keys.length) {
      const klRes = await db.query(
        `SELECT market,symbol,open_time,close_time,open_price,high_price,low_price,close_price,base_volume FROM (
           SELECT market,symbol,open_time,close_time,open_price,high_price,low_price,close_price,base_volume,
                  ROW_NUMBER() OVER (PARTITION BY market,symbol ORDER BY open_time DESC) AS rn
             FROM market_candles_1m WHERE market || ':' || symbol = ANY($1)
         ) c WHERE c.rn <= $2 ORDER BY market,symbol,open_time`,
        [keys, candleLimit],
      );
      for (const k of klRes.rows) {
        const key = `${k.market}:${k.symbol}`;
        if (!klinesByKey.has(key)) klinesByKey.set(key, []);
        klinesByKey.get(key).push([new Date(k.open_time).getTime(), num(k.open_price), num(k.high_price), num(k.low_price), num(k.close_price), num(k.base_volume), new Date(k.close_time).getTime()]);
      }
    }

    // Raw agg trades are only needed to REBUILD absorption for rows written before
    // it was computed at collection time. Rows that already carry a stored absorb
    // row need no trades at all — which is what lets raw trade retention shrink to
    // a small audit sample instead of the whole universe.
    const legacy = measRes.rows.filter((m) => !m.absorb);
    const tradesByKey = new Map();
    if (legacy.length) {
      const tradeRes = await db.query(`SELECT market,symbol,event_time,price,quantity,buyer_is_maker FROM market_agg_trades WHERE run_id=$1 AND market || ':' || symbol = ANY($2) ORDER BY market,symbol,event_time`, [latest.id, legacy.map((m) => `${m.market}:${m.symbol}`)]);
      for (const t of tradeRes.rows) {
        const key = `${t.market}:${t.symbol}`;
        if (!tradesByKey.has(key)) tradesByKey.set(key, []);
        tradesByKey.get(key).push({ T: new Date(t.event_time).getTime(), p: num(t.price), q: num(t.quantity), m: t.buyer_is_maker });
      }
    }

    const microSymbols = [];
    for (const m of measRes.rows) {
      const key = `${m.market}:${m.symbol}`;
      const askDepth = num(m.ask_quote_depth) || 0; const bidDepth = num(m.bid_quote_depth) || 0;
      microSymbols.push({
        market: m.market, symbol: m.symbol, observedAtMs: new Date(m.observed_at).getTime(), windowSec,
        // Computed at collection time from the raw data while it was in memory.
        // When present the consumer uses it as-is and never rebuilds from trades.
        absorb: m.absorb && typeof m.absorb === 'object' && !Array.isArray(m.absorb) ? m.absorb : null,
        spreadPct: num(m.spread_bps) === null ? null : num(m.spread_bps) / 100,
        depthUsdWithin1Pct: bidDepth + askDepth > 0 ? bidDepth + askDepth : null,
        bidQuoteDepthAfter: num(m.bid_quote_depth), bidQuoteDepthBefore: prevDepth.has(key) ? prevDepth.get(key) : null,
        takerBuyQuote: num(m.taker_buy_quote), takerSellQuote: num(m.taker_sell_quote),
        aggTrades: tradesByKey.get(key) || [],
        // [openMs, open, high, low, close, volume, closeMs] — element 6 (closeTime)
        // is required by the klines-snapshot candle normalizer; the absorb bridge
        // only reads [0],[3],[4], so the extra element is inert there.
        klines: klinesByKey.get(key) || [],
      });
    }
    return { ok: true, run: { id: latest.id, observedAt: latest.observed_at }, previousRun: prev ? { id: prev.id, observedAt: prev.observed_at } : null, windowSec, tickers: tickRes.rows, microSymbols };
  } catch (error) { dbError('radar_input_bundle_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

export async function insertRadarRunResult(db, payload = {}) {
  const runId = Number(payload.runId); if (!Number.isInteger(runId) || runId <= 0) return { ok: false, reason: 'INVALID_RUN' };
  const status = ['ready', 'pending', 'failed', 'unknown'].includes(payload.status) ? payload.status : 'unknown';
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  try {
    await db.query(
      `INSERT INTO radar_run_snapshots (run_id,status,source,computed_at,candidate_count,entry_ready_count,market_regime,pipeline,absorb_funnel,universe_diagnostics,provider_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (run_id) DO UPDATE SET status=EXCLUDED.status, source=EXCLUDED.source, computed_at=EXCLUDED.computed_at, candidate_count=EXCLUDED.candidate_count, entry_ready_count=EXCLUDED.entry_ready_count, market_regime=EXCLUDED.market_regime, pipeline=EXCLUDED.pipeline, absorb_funnel=EXCLUDED.absorb_funnel, universe_diagnostics=EXCLUDED.universe_diagnostics, provider_status=EXCLUDED.provider_status`,
      [runId, status, typeof payload.source === 'string' ? payload.source.slice(0, 64) : 'canonical_context', asDate(payload.computedAt), candidates.length, Number(payload.entryReadyCount) || 0, safeJson(payload.marketRegime || {}), safeJson(payload.pipeline || {}), safeJson(sanitizeDiagnostics(payload.absorbFunnel || {})), safeJson(sanitizeDiagnostics(payload.universeDiagnostics || {})), safeJson(sanitizeDiagnostics(payload.providerStatus || {}))],
    );
    await db.query(`DELETE FROM radar_run_candidates WHERE run_id=$1`, [runId]);
    for (const chunk of chunks(candidates)) {
      const values = [];
      for (const c of chunk) {
        const market = c.market === 'futures' ? 'futures' : 'spot';
        values.push(runId, market, upper(c.symbol || '', 32), c.stage ?? null, c.v1Status ?? c.entryStatus ?? c.status ?? null, c.ABSORB_STATUS ?? null, c.ABSORB_MODE ?? null, c.STRICT_ABSORB_STATUS ?? null, c.PROXY_ABSORB_STATUS ?? null, num(c.STRICT_ABSORB_SCORE), num(c.PROXY_ABSORB_SCORE), c.STRICT_ABSORB_CONFIRMED === true, c.RECLAIM_STATUS ?? c.reclaimStatus ?? null, ['ready', 'pending', 'unknown'].includes(c.dataStatus) ? c.dataStatus : 'ready', safeJson(sanitizeDiagnostics(c)));
      }
      await db.query(`INSERT INTO radar_run_candidates (run_id,market,symbol,stage,entry_status,absorb_status,absorb_mode,strict_absorb_status,proxy_absorb_status,strict_absorb_score,proxy_absorb_score,strict_absorb_confirmed,reclaim_status,data_status,payload) VALUES ${valuesSql(chunk.length, 15)} ON CONFLICT (run_id,market,symbol) DO NOTHING`, values);
    }
    return { ok: true, runId, candidateCount: candidates.length };
  } catch (error) { dbError('radar_result_insert_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

async function readRadarForRun(db, runId) {
  const snapRes = await db.query(`SELECT run_id,status,source,computed_at,candidate_count,entry_ready_count,market_regime,pipeline,absorb_funnel,universe_diagnostics,provider_status FROM radar_run_snapshots WHERE run_id=$1`, [runId]);
  const snap = snapRes.rows[0];
  if (!snap) return { status: 'PENDING', runId, candidates: [] };
  const candRes = await db.query(`SELECT market,symbol,stage,entry_status,absorb_status,absorb_mode,strict_absorb_status,proxy_absorb_status,strict_absorb_score,proxy_absorb_score,strict_absorb_confirmed,reclaim_status,data_status,payload FROM radar_run_candidates WHERE run_id=$1 ORDER BY strict_absorb_confirmed DESC, COALESCE(strict_absorb_score,0) DESC`, [runId]);
  return { status: String(snap.status).toUpperCase(), runId, source: snap.source, computedAt: snap.computed_at, candidateCount: Number(snap.candidate_count), entryReadyCount: Number(snap.entry_ready_count), marketRegime: snap.market_regime || {}, pipeline: snap.pipeline || {}, absorbFunnel: snap.absorb_funnel || {}, universeDiagnostics: snap.universe_diagnostics || {}, providerStatus: snap.provider_status || {}, candidates: candRes.rows };
}

export async function getPublishedRadar(db) {
  try {
    const runRes = await db.query(`SELECT id FROM market_collection_runs WHERE scope_id=$1 AND status='published' ORDER BY observed_at DESC LIMIT 1`, [CONTEXT_SCOPE_ID]);
    const run = runRes.rows[0]; if (!run) return { ok: true, radar: { status: 'PENDING', candidates: [] } };
    return { ok: true, radar: await readRadarForRun(db, run.id) };
  } catch (error) { dbError('radar_read_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

// Retention: deletes heavy atomic rows older than the cutoffs. It prunes CHILD
// rows only (never instruments, never run audit metadata) and always protects the
// latest published run so consumers can never lose the current context. Idempotent
// and safe to re-run; the caller decides the cutoffs and whether it runs at all.
export async function pruneCanonicalContext(db, options = {}) {
  const marketCutoff = asDate(options.marketCutoff, new Date(0));
  const radarCutoff = asDate(options.radarCutoff, new Date(0));
  try {
    const latest = await db.query(`SELECT id FROM market_collection_runs WHERE scope_id=$1 AND status='published' ORDER BY observed_at DESC LIMIT 1`, [CONTEXT_SCOPE_ID]);
    const protectId = latest.rows[0]?.id ?? -1;
    const del = async (sql, params) => (await db.query(sql, params)).rowCount || 0;
    const tickers = await del(`DELETE FROM market_ticker_observations WHERE observed_at < $1 AND run_id <> $2`, [marketCutoff, protectId]);
    const candles = await del(`DELETE FROM market_candles_1m WHERE open_time < $1 AND run_id <> $2`, [marketCutoff, protectId]);
    const levels = await del(`DELETE FROM market_order_book_levels WHERE observed_at < $1 AND run_id <> $2`, [marketCutoff, protectId]);
    const trades = await del(`DELETE FROM market_agg_trades WHERE event_time < $1 AND run_id <> $2`, [marketCutoff, protectId]);
    const measurements = await del(`DELETE FROM market_microstructure_measurements WHERE observed_at < $1 AND run_id <> $2`, [marketCutoff, protectId]);
    const radarCandidates = await del(`DELETE FROM radar_run_candidates c USING market_collection_runs r WHERE c.run_id = r.id AND r.observed_at < $1 AND c.run_id <> $2`, [radarCutoff, protectId]);
    const radarSnapshots = await del(`DELETE FROM radar_run_snapshots s USING market_collection_runs r WHERE s.run_id = r.id AND r.observed_at < $1 AND s.run_id <> $2`, [radarCutoff, protectId]);
    return { ok: true, protectedRunId: protectId, deleted: { tickers, candles, levels, trades, measurements, radarCandidates, radarSnapshots } };
  } catch (error) { dbError('retention_prune_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

// 24h / 7d Absorb funnel history: aggregates the stored per-run funnels by joining
// to each run's observed_at. Pure read; used by the diagnostics endpoint only.
export async function getRadarFunnelHistory(db, options = {}) {
  const sinceMs = Number(options.sinceMs) > 0 ? Number(options.sinceMs) : 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - sinceMs);
  try {
    const res = await db.query(`SELECT s.absorb_funnel, s.candidate_count, s.entry_ready_count FROM radar_run_snapshots s JOIN market_collection_runs r ON r.id=s.run_id WHERE r.observed_at >= $1`, [since]);
    const totals = { runs: res.rows.length, candidateCount: 0, entryReadyCount: 0, funnel: {} };
    for (const row of res.rows) {
      totals.candidateCount += Number(row.candidate_count) || 0;
      totals.entryReadyCount += Number(row.entry_ready_count) || 0;
      const funnel = row.absorb_funnel && typeof row.absorb_funnel === 'object' ? row.absorb_funnel : {};
      for (const [key, value] of Object.entries(funnel)) if (Number.isFinite(Number(value))) totals.funnel[key] = (totals.funnel[key] || 0) + Number(value);
    }
    return { ok: true, sinceMs, totals };
  } catch (error) { dbError('radar_funnel_read_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}