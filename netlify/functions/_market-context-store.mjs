import { getDb } from './_db.mjs';

export const CONTEXT_SCOPE_ID = 'global';
const RUN_BUCKET_MS = 3 * 60 * 1000;
const INSERT_CHUNK = 100;
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
  return { market, symbol, baseAsset, quoteAsset, observedAt: asDate(observedAt), lastPrice: numberOrNull(raw.lastPrice), priceChangePercent: numberOrNull(raw.priceChangePercent), highPrice: numberOrNull(raw.highPrice), lowPrice: numberOrNull(raw.lowPrice), baseVolume: numberOrNull(raw.baseVolume), quoteVolume: numberOrNull(raw.quoteVolume), tradeCount: integerOrNull(raw.tradeCount), dataStatus: safeStatus(raw.dataStatus, 'complete'), diagnostics: sanitizeDiagnostics(raw.diagnostics || {}) };
}
function normalizedMicro(raw, observedAt) {
  const market = raw?.market === 'futures' ? 'futures' : raw?.market === 'spot' ? 'spot' : null; const symbol = upper(raw?.symbol || raw?.pair);
  if (!market || !symbol) return null;
  const depth = raw.orderBook && typeof raw.orderBook === 'object' ? raw.orderBook : {};
  return { market, symbol, observedAt: asDate(observedAt), windowStart: raw.windowStart ? asDate(raw.windowStart) : null, windowEnd: raw.windowEnd ? asDate(raw.windowEnd) : null, dataStatus: safeStatus(raw.dataStatus, 'partial'), failureCode: typeof raw.failureCode === 'string' ? upper(raw.failureCode, 80) || null : null, missingInputs: Array.isArray(raw.missingInputs) ? raw.missingInputs.map((v) => upper(v, 80)).filter(Boolean).slice(0, 20) : [], klines: Array.isArray(raw.klines1m) ? raw.klines1m.slice(0, 120) : [], bids: Array.isArray(depth.bids) ? depth.bids.slice(0, 100) : [], asks: Array.isArray(depth.asks) ? depth.asks.slice(0, 100) : [], depthUpdateId: integerOrNull(depth.lastUpdateId), aggTrades: Array.isArray(raw.aggTrades) ? raw.aggTrades.slice(0, 500) : [], depthSummary: raw.depthSummary || {}, tradesSummary: raw.tradesSummary || {} };
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
  for (const chunk of chunks(rows)) { const values = []; for (const row of chunk) values.push(runId,row.market,row.symbol,row.observedAt,row.lastPrice,row.priceChangePercent,row.highPrice,row.lowPrice,row.baseVolume,row.quoteVolume,row.tradeCount,row.dataStatus,safeJson(row.diagnostics)); await db.query(`INSERT INTO market_ticker_observations (run_id,market,symbol,observed_at,last_price,price_change_percent,high_price,low_price,base_volume,quote_volume,trade_count,data_status,diagnostics) VALUES ${valuesSql(chunk.length,13)} ON CONFLICT (run_id,market,symbol) DO NOTHING`, values); }
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
  for (const chunk of chunks(rows)) { const values=[]; for (const row of chunk) { const depth=row.depthSummary||{}; const trades=row.tradesSummary||{}; values.push(runId,row.market,row.symbol,row.observedAt,row.windowStart,row.windowEnd,row.dataStatus,row.failureCode,row.missingInputs,row.klines.length,integerOrNull(depth?.levels?.bids)||0,integerOrNull(depth?.levels?.asks)||0,numberOrNull(depth.bestBid),numberOrNull(depth.bestAsk),numberOrNull(depth.spreadBps),numberOrNull(depth.bidQuote),numberOrNull(depth.askQuote),integerOrNull(trades.count)||0,numberOrNull(trades.takerBuyQuote),numberOrNull(trades.takerSellQuote)); } await db.query(`INSERT INTO market_microstructure_measurements (run_id,market,symbol,observed_at,window_start,window_end,data_status,failure_code,missing_inputs,candle_count,order_book_bid_levels,order_book_ask_levels,best_bid,best_ask,spread_bps,bid_quote_depth,ask_quote_depth,agg_trade_count,taker_buy_quote,taker_sell_quote) VALUES ${valuesSql(chunk.length,20)} ON CONFLICT (run_id,market,symbol) DO NOTHING`, values); }
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
      db.query(`SELECT market,symbol,last_price,price_change_percent,high_price,low_price,base_volume,quote_volume,trade_count,observed_at,data_status,diagnostics FROM market_ticker_observations WHERE run_id=$1 ORDER BY quote_volume DESC NULLS LAST LIMIT $2`, [run.id,tickerLimit]),
      db.query(`SELECT market,symbol,observed_at,window_start,window_end,data_status,failure_code,missing_inputs,candle_count,order_book_bid_levels,order_book_ask_levels,best_bid,best_ask,spread_bps,bid_quote_depth,ask_quote_depth,agg_trade_count,taker_buy_quote,taker_sell_quote FROM market_microstructure_measurements WHERE run_id=$1 ORDER BY market,symbol LIMIT $2`, [run.id,microLimit]),
    ]);
    const ageMs = Date.now() - new Date(run.observed_at).getTime(); const freshness = !Number.isFinite(ageMs) ? 'MISSING' : ageMs <= 6 * 60 * 1000 ? 'FRESH' : 'STALE';
    return { ok: true, contextVersion: null, run: { id: run.id, key: run.run_key, observedAt: run.observed_at, completedAt: run.completed_at }, market: { observedAt: run.observed_at, freshness, tickers: tickers.rows, microstructure: micro.rows, dataQuality: sanitizeDiagnostics(run.diagnostics || {}) }, radar: { status: 'PENDING' } };
  } catch (error) { dbError('atomic_context_read_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

export async function getContextDiagnostics(db) {
  try { const result = await db.query(`SELECT id,run_key,observed_at,completed_at,(SELECT count(*) FROM market_ticker_observations t WHERE t.run_id=r.id) AS ticker_count,(SELECT count(*) FROM market_microstructure_measurements m WHERE m.run_id=r.id) AS measurement_count FROM market_collection_runs r WHERE scope_id=$1 AND status='published' ORDER BY observed_at DESC LIMIT 1`, [CONTEXT_SCOPE_ID]); const row=result.rows[0]; return { ok:true, diagnostics: row ? { runId:row.id,runKey:row.run_key,observedAt:row.observed_at,completedAt:row.completed_at,tickerCount:Number(row.ticker_count),measurementCount:Number(row.measurement_count) } : { runId:null, tickerCount:0, measurementCount:0 } }; }
  catch (error) { dbError('diagnostics_read_failed', error); return { ok:false, reason:'DB_UNAVAILABLE' }; }
}