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
// Same USD-stable quote set the collector ranks by and the RADAR universe accepts
// (scripts/radar/trading-radar.mjs QUOTES). Kept here so the read path cannot
// drift from what is actually measurable and scoreable.
export const RANKABLE_QUOTE_ASSETS = ['USDT', 'USDC'];
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

// How many symbols keep their RAW agg trades and order-book levels. Every measured
// symbol always stores its derived measurement row (including the absorb row);
// this bound applies only to the raw audit sample kept alongside it.
//
// Raw retention is what does NOT scale: 500 trades x 100 book levels per symbol is
// ~350k rows per cycle across a full universe, while the derived rows are one per
// symbol. Since absorption is now computed at collection time, nothing READS the
// raw rows on the hot path — they exist so a signal can be audited after the fact.
export const DEFAULT_RAW_SAMPLE_TOP_N = 10;

export async function insertAtomicMarketRecords(db, payload = {}) {
  const runId = Number(payload.runId); if (!Number.isInteger(runId) || runId <= 0) return { ok: false, reason: 'INVALID_RUN' };
  const observedAt = asDate(payload.observedAt); const tickers = (payload.rows || []).map((row) => normalizeTicker(row, observedAt)).filter(Boolean); const micro = (payload.microstructure || []).map((row) => normalizedMicro(row, observedAt)).filter(Boolean);
  const rawSampleTopN = Number.isFinite(Number(payload.rawSampleTopN)) && Number(payload.rawSampleTopN) >= 0 ? Math.trunc(Number(payload.rawSampleTopN)) : DEFAULT_RAW_SAMPLE_TOP_N;
  // Busiest venues first, so the audit sample is the symbols most likely to be
  // questioned. Ranking uses taker quote flow, which is already comparable here
  // because the measured universe is USD-stable quoted only.
  const takerTotal = (row) => (numberOrNull(row.tradesSummary?.takerBuyQuote) || 0) + (numberOrNull(row.tradesSummary?.takerSellQuote) || 0);
  const rawSample = new Set([...micro].sort((a, b) => takerTotal(b) - takerTotal(a)).slice(0, rawSampleTopN).map((row) => `${row.market}:${row.symbol}`));
  const sampled = micro.filter((row) => rawSample.has(`${row.market}:${row.symbol}`));
  try {
    await upsertInstruments(db, tickers); await insertTickers(db, runId, tickers);
    // Candles are kept for EVERY measured symbol: structural reclaim reads them and
    // they are deduplicated by (market,symbol,open_time), so successive runs add
    // only the few newly closed minutes rather than the whole window again.
    const candles = micro.flatMap((row) => row.klines.map((kline) => normalKline(row, kline)).filter(Boolean));
    const levels = sampled.flatMap((row) => [...normalLevels(row, 'bid', row.bids), ...normalLevels(row, 'ask', row.asks)]);
    const trades = sampled.flatMap(normalTrades);
    await insertCandles(db, runId, candles); await insertLevels(db, runId, levels); await insertTrades(db, runId, trades); await insertMeasurements(db, runId, micro);
    return { ok: true, tickerCount: tickers.length, candleCount: candles.length, orderBookLevelCount: levels.length, aggTradeCount: trades.length, measurementCount: micro.length, rawSampleCount: sampled.length, droppedTickerCount: (payload.rows || []).length - tickers.length, droppedMicrostructureCount: (payload.microstructure || []).length - micro.length };
  } catch (error) { dbError('atomic_insert_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

export async function completeCollectionRun(db, payload = {}) {
  const runId = Number(payload.runId); if (!Number.isInteger(runId) || runId <= 0) return { ok: false, reason: 'INVALID_RUN' };
  try { await db.query(`UPDATE market_collection_runs SET status='published', reason_code=NULL, diagnostics=$2, completed_at=$3, updated_at=now() WHERE id=$1`, [runId,safeJson(sanitizeDiagnostics(payload.diagnostics || {})),asDate(payload.completedAt)]); return { ok: true }; }
  catch (error) { dbError('run_complete_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

export async function getAtomizedMarketContext(db, options = {}) {
  const tickerLimit = Math.min(Math.max(Number(options.tickerLimit) || 500, 1), 2000); const microLimit = Math.min(Math.max(Number(options.microLimit) || 50, 1), 600);
  try {
    const runRes = await db.query(`SELECT id,run_key,observed_at,completed_at,diagnostics FROM market_collection_runs WHERE scope_id=$1 AND status='published' ORDER BY observed_at DESC LIMIT 1`, [CONTEXT_SCOPE_ID]); const run = runRes.rows[0];
    // No published collection run at all — the COLLECTOR is the missing stage here,
    // not the RADAR publisher. Naming it distinguishes "collector not running" from
    // "collector fine, RADAR not scoring", which otherwise both surfaced as a bare
    // PENDING and sent the owner looking in the wrong place.
    if (!run) return { ok: true, contextVersion: null, run: null, market: null, radar: { status: 'PENDING', candidates: [], pendingReason: 'NO_PUBLISHED_RUN' } };
    const [tickers, micro] = await Promise.all([
      // Joined to the instrument so every row carries its base/quote asset, and
      // restricted to USD-stable quotes.
      //
      // Both matter for what the terminal shows. `quote_volume` is denominated in
      // the QUOTE asset, so ordering it across mixed quotes ranks by exchange rate:
      // IDR (~16k/USD) and TRY pairs filled the top of the list and pushed every
      // real major out of it. And without base_asset the reader cannot tell that
      // "BTCUSDT" is BTC, so it treated every canonical row as an unknown
      // off-Binance asset. Restricting to the quotes RADAR accepts fixes both and
      // matches the universe RADAR can actually score.
      db.query(`SELECT t.market,t.symbol,i.base_asset,i.quote_asset,t.last_price,t.price_change_percent,t.high_price,t.low_price,t.base_volume,t.quote_volume,t.trade_count,t.change_1h_pct,t.change_4h_pct,t.change_12h_pct,t.change_7d_pct,t.observed_at,t.data_status,t.diagnostics
           FROM market_ticker_observations t
           JOIN market_instruments i ON i.market = t.market AND i.symbol = t.symbol
          WHERE t.run_id=$1 AND i.quote_asset = ANY($3)
          ORDER BY t.quote_volume DESC NULLS LAST LIMIT $2`, [run.id,tickerLimit,RANKABLE_QUOTE_ASSETS]),
      db.query(`SELECT market,symbol,observed_at,window_start,window_end,data_status,failure_code,missing_inputs,candle_count,order_book_bid_levels,order_book_ask_levels,best_bid,best_ask,spread_bps,bid_quote_depth,ask_quote_depth,agg_trade_count,taker_buy_quote,taker_sell_quote FROM market_microstructure_measurements WHERE run_id=$1 ORDER BY market,symbol LIMIT $2`, [run.id,microLimit]),
    ]);
    const ageMs = Date.now() - new Date(run.observed_at).getTime(); const freshness = !Number.isFinite(ageMs) ? 'MISSING' : ageMs <= 6 * 60 * 1000 ? 'FRESH' : 'STALE';
    const radar = await readCanonicalRadar(db, { limit: tickerLimit });
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
  const topN = Math.min(Math.max(Number(options.topN) || 8, 1), 600);
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
      // One row per (market, symbol), busiest first. This used to collapse to
      // DISTINCT ON (symbol) because the rolling snapshot was keyed by symbol alone,
      // so both venues of one symbol would land on a single key and one would be
      // silently dropped at merge time. The snapshot is now keyed "market:symbol"
      // (scripts/radar/rolling-microstructure-snapshot.mjs rollingKeyFor), so spot
      // and futures are distinct measurements and neither has to be discarded.
      // topN therefore bounds MEASUREMENTS, not symbols — which is what the
      // collector's per-venue budgets already produced.
      db.query(`SELECT market,symbol,observed_at,window_start,window_end,data_status,spread_bps,bid_quote_depth,ask_quote_depth,taker_buy_quote,taker_sell_quote,best_bid,best_ask,agg_trade_count,absorb FROM market_microstructure_measurements WHERE run_id=$1 ORDER BY (COALESCE(taker_buy_quote,0)+COALESCE(taker_sell_quote,0)) DESC LIMIT $2`, [latest.id, topN]),
    ]);
    let prevDepth = new Map();
    if (prev) { const prevRes = await db.query(`SELECT market,symbol,bid_quote_depth FROM market_microstructure_measurements WHERE run_id=$1`, [prev.id]); prevDepth = new Map(prevRes.rows.map((r) => [`${r.market}:${r.symbol}`, num(r.bid_quote_depth)])); }

    // Candles for EVERY measured symbol in one windowed query. The previous
    // per-symbol query cost one round trip per symbol, which caps the universe at
    // a handful; a per-partition ROW_NUMBER returns the same rows in a single
    // trip regardless of how many symbols were measured.
    // Tuple membership, NOT a concatenated key: `market || ':' || symbol = ANY(...)`
    // is not sargable, so it would ignore the (market,symbol,open_time) index and
    // scan the whole candle table on every cycle — survivable for five symbols,
    // ruinous once the universe and 48h of history are in there.
    const markets = measRes.rows.map((m) => m.market);
    const symbols = measRes.rows.map((m) => m.symbol);
    const klinesByKey = new Map();
    if (symbols.length) {
      const klRes = await db.query(
        `SELECT market,symbol,open_time,close_time,open_price,high_price,low_price,close_price,base_volume FROM (
           SELECT market,symbol,open_time,close_time,open_price,high_price,low_price,close_price,base_volume,
                  ROW_NUMBER() OVER (PARTITION BY market,symbol ORDER BY open_time DESC) AS rn
             FROM market_candles_1m
            WHERE (market, symbol) IN (SELECT m, s FROM unnest($1::text[], $2::text[]) AS t(m, s))
         ) c WHERE c.rn <= $3 ORDER BY market,symbol,open_time`,
        [markets, symbols, candleLimit],
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
      const tradeRes = await db.query(`SELECT market,symbol,event_time,price,quantity,buyer_is_maker FROM market_agg_trades WHERE run_id=$1 AND (market, symbol) IN (SELECT m, s FROM unnest($2::text[], $3::text[]) AS t(m, s)) ORDER BY market,symbol,event_time`, [latest.id, legacy.map((m) => m.market), legacy.map((m) => m.symbol)]);
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

// ── Atomized per-symbol RADAR state ─────────────────────────────────────────
// The CURRENT RADAR verdict per coin, upserted on (market, symbol). Unlike the
// run-keyed tables above, a read here never depends on which market run was most
// recently published, so it cannot return PENDING for a run that has not been
// scored yet — the race that made the terminal fall back to its legacy path and
// flip Strict Absorb between a real verdict and "DATA OFF".

// A status the V1 state machine did not produce is stored as 'UNKNOWN' rather than
// rejected: dropping the row would lose the whole coin, and coercing it into a
// neighbouring state would invent a verdict. UNKNOWN is neither actionable nor
// mistakable for one.
const RADAR_V1_STATES = new Set(['IGNORE', 'WATCH', 'SETUP_CONFIRMED', 'DISLOCATION_CONFIRMED', 'LONG_FLUSH_CONFIRMED', 'STABILIZATION', 'RECLAIM_DETECTED', 'EARLY_ENTRY_READY', 'STANDARD_ENTRY_READY', 'AGGRESSIVE_ENTRY_READY', 'WAIT_FOR_PULLBACK', 'WAIT_FOR_RECLAIM', 'EXTENDED_ENTRY', 'CHASE_RISK', 'RISK_OFF_BLOCKED', 'INVALIDATED']);
const RADAR_DATA_STATUS = new Set(['ready', 'pending', 'degraded', 'unknown']);

// POSITION_SIZE_GUIDANCE is a human string ("25-40% planned position", "0% planned
// position - confidence too low"). An unparseable value yields NULLs, never zeros:
// 0% is itself a real verdict here, so a parse failure must not be storable as one.
function parsePositionSizePct(guidance) {
  if (typeof guidance !== 'string') return { low: null, high: null };
  const match = guidance.match(/(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*%/);
  if (!match) return { low: null, high: null };
  const low = numberOrNull(match[1]);
  const high = match[2] === undefined ? low : numberOrNull(match[2]);
  return { low, high };
}
function tpLevel(candidate, index) {
  const list = Array.isArray(candidate?.TAKE_PROFIT_LEVELS) ? candidate.TAKE_PROFIT_LEVELS : [];
  return numberOrNull(list[index]?.level);
}
function stringOrNull(value, max = 64) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null; }
function missingInputsOf(candidate) {
  const raw = candidate?.dataQuality?.missingData ?? candidate?.missingData;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 40).map((entry) => entry.trim().slice(0, 64));
}

// Must equal the column count in the INSERT below; a mismatch is a bind error, not
// silent corruption, but keeping it named makes the two easy to check against.
const RADAR_STATE_COLUMNS = 43;

export async function upsertRadarCandidateStates(db, payload = {}) {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const computedAt = asDate(payload.computedAt);
  const observedAt = asDate(payload.observedAt, computedAt);
  const runId = Number.isInteger(Number(payload.runId)) && Number(payload.runId) > 0 ? Number(payload.runId) : null;
  const source = typeof payload.source === 'string' ? payload.source.slice(0, 64) : 'canonical_context';
  if (!candidates.length) return { ok: true, written: 0 };
  try {
    let written = 0;
    for (const chunk of chunks(candidates)) {
      const values = [];
      for (const c of chunk) {
        const market = c.market === 'futures' ? 'futures' : 'spot';
        const status = RADAR_V1_STATES.has(c.STATUS) ? c.STATUS : 'UNKNOWN';
        const size = parsePositionSizePct(c.POSITION_SIZE_GUIDANCE);
        values.push(
          market, upper(c.symbol || '', 32), computedAt, observedAt, runId, source,
          status, stringOrNull(c.ENTRY_TYPE), c.allRadarConditionsPassed === true,
          numberOrNull(c.SETUP_SCORE), numberOrNull(c.EXECUTION_SCORE), numberOrNull(c.RISK_REWARD_SCORE),
          numberOrNull(c.MARKET_REGIME_SCORE), numberOrNull(c.FINAL_CONFIDENCE ?? c.CONFIDENCE),
          numberOrNull(c.DISLOCATION_SCORE), numberOrNull(c.FLUSH_SCORE), numberOrNull(c.STABILIZATION_SCORE),
          numberOrNull(c.RECLAIM_SCORE), numberOrNull(c.ORDER_BOOK_SUPPORT_SCORE), numberOrNull(c.FLOW_CONFIRMATION_SCORE),
          numberOrNull(c.DERIVATIVES_RISK_SCORE),
          stringOrNull(c.RECLAIM_STATUS), stringOrNull(c.ABSORB_STATUS), stringOrNull(c.ABSORB_MODE),
          stringOrNull(c.STRICT_ABSORB_STATUS), numberOrNull(c.STRICT_ABSORB_SCORE), c.STRICT_ABSORB_CONFIRMED === true,
          numberOrNull(c.ENTRY_ZONE?.low), numberOrNull(c.ENTRY_ZONE?.high),
          numberOrNull(c.STOP_LOSS_LEVEL), numberOrNull(c.HARD_INVALIDATION),
          tpLevel(c, 0), tpLevel(c, 1), tpLevel(c, 2),
          size.low, size.high, stringOrNull(c.POSITION_SIZE_GUIDANCE, 128),
          stringOrNull(c.TIMEFRAME_CONTEXT, 128), stringOrNull(c.TIME_VALIDITY, 160),
          RADAR_DATA_STATUS.has(c.dataStatus) ? c.dataStatus : 'unknown',
          missingInputsOf(c), safeJson(sanitizeDiagnostics(c.dataQuality || {})), safeJson(sanitizeDiagnostics(c)),
        );
      }
      await db.query(
        `INSERT INTO radar_candidate_state (
           market,symbol,computed_at,observed_at,run_id,source,
           status,entry_type,entry_ready,
           setup_score,execution_score,risk_reward_score,market_regime_score,confidence,
           dislocation_score,flush_score,stabilization_score,reclaim_score,
           order_book_support_score,flow_confirmation_score,derivatives_risk_score,
           reclaim_status,absorb_status,absorb_mode,strict_absorb_status,strict_absorb_score,strict_absorb_confirmed,
           entry_zone_low,entry_zone_high,stop_loss,hard_invalidation,
           tp1_level,tp2_level,tp3_level,
           position_size_pct_low,position_size_pct_high,position_size_guidance,
           timeframe_context,time_validity,
           data_status,missing_inputs,data_quality,payload
         ) VALUES ${valuesSql(chunk.length, RADAR_STATE_COLUMNS)}
         ON CONFLICT (market,symbol) DO UPDATE SET
           computed_at=EXCLUDED.computed_at, observed_at=EXCLUDED.observed_at, run_id=EXCLUDED.run_id, source=EXCLUDED.source,
           status=EXCLUDED.status, entry_type=EXCLUDED.entry_type, entry_ready=EXCLUDED.entry_ready,
           setup_score=EXCLUDED.setup_score, execution_score=EXCLUDED.execution_score, risk_reward_score=EXCLUDED.risk_reward_score,
           market_regime_score=EXCLUDED.market_regime_score, confidence=EXCLUDED.confidence,
           dislocation_score=EXCLUDED.dislocation_score, flush_score=EXCLUDED.flush_score,
           stabilization_score=EXCLUDED.stabilization_score, reclaim_score=EXCLUDED.reclaim_score,
           order_book_support_score=EXCLUDED.order_book_support_score, flow_confirmation_score=EXCLUDED.flow_confirmation_score,
           derivatives_risk_score=EXCLUDED.derivatives_risk_score,
           reclaim_status=EXCLUDED.reclaim_status, absorb_status=EXCLUDED.absorb_status, absorb_mode=EXCLUDED.absorb_mode,
           strict_absorb_status=EXCLUDED.strict_absorb_status, strict_absorb_score=EXCLUDED.strict_absorb_score,
           strict_absorb_confirmed=EXCLUDED.strict_absorb_confirmed,
           entry_zone_low=EXCLUDED.entry_zone_low, entry_zone_high=EXCLUDED.entry_zone_high,
           stop_loss=EXCLUDED.stop_loss, hard_invalidation=EXCLUDED.hard_invalidation,
           tp1_level=EXCLUDED.tp1_level, tp2_level=EXCLUDED.tp2_level, tp3_level=EXCLUDED.tp3_level,
           position_size_pct_low=EXCLUDED.position_size_pct_low, position_size_pct_high=EXCLUDED.position_size_pct_high,
           position_size_guidance=EXCLUDED.position_size_guidance,
           timeframe_context=EXCLUDED.timeframe_context, time_validity=EXCLUDED.time_validity,
           data_status=EXCLUDED.data_status, missing_inputs=EXCLUDED.missing_inputs,
           data_quality=EXCLUDED.data_quality, payload=EXCLUDED.payload, updated_at=now()`,
        values,
      );
      written += chunk.length;
    }
    return { ok: true, written };
  } catch (error) { dbError('radar_state_upsert_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

const RADAR_STATE_SELECT = `market,symbol,computed_at,observed_at,run_id,source,status,entry_type,entry_ready,
  setup_score,execution_score,risk_reward_score,market_regime_score,confidence,
  dislocation_score,flush_score,stabilization_score,reclaim_score,
  order_book_support_score,flow_confirmation_score,derivatives_risk_score,
  reclaim_status,absorb_status,absorb_mode,strict_absorb_status,strict_absorb_score,strict_absorb_confirmed,
  entry_zone_low,entry_zone_high,stop_loss,hard_invalidation,tp1_level,tp2_level,tp3_level,
  position_size_pct_low,position_size_pct_high,position_size_guidance,timeframe_context,time_validity,
  data_status,missing_inputs,data_quality,payload`;

// Current RADAR state for the whole universe, best setup first. Carries its own
// computed_at so the caller can judge freshness per row instead of inheriting a
// single run-level verdict.
export async function getRadarCandidateStates(db, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 500, 1), 2000);
  try {
    const params = [limit];
    let filter = '';
    if (options.entryReadyOnly === true) filter = 'WHERE entry_ready';
    else if (typeof options.status === 'string' && RADAR_V1_STATES.has(options.status)) { filter = 'WHERE status=$2'; params.push(options.status); }
    const result = await db.query(`SELECT ${RADAR_STATE_SELECT} FROM radar_candidate_state ${filter} ORDER BY setup_score DESC NULLS LAST, execution_score DESC NULLS LAST, symbol ASC LIMIT $1`, params);
    return { ok: true, states: result.rows };
  } catch (error) { dbError('radar_state_read_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

// Single-coin read for the Cockpit. Deepest venue first when a symbol trades on
// both, so one coin resolves to one verdict without the caller guessing a venue.
export async function getRadarCandidateState(db, symbol, options = {}) {
  const safeSymbol = upper(symbol || '', 32);
  // Validate the shape, not just emptiness: a junk symbol must be refused before it
  // reaches the database rather than travelling as a bound parameter.
  if (!/^[A-Z0-9]{2,32}$/.test(safeSymbol)) return { ok: false, reason: 'INVALID_SYMBOL' };
  try {
    const params = [safeSymbol];
    let venue = '';
    if (options.market === 'spot' || options.market === 'futures') { venue = ' AND market=$2'; params.push(options.market); }
    const result = await db.query(`SELECT ${RADAR_STATE_SELECT} FROM radar_candidate_state WHERE symbol=$1${venue} ORDER BY (market='spot') DESC LIMIT 1`, params);
    return { ok: true, state: result.rows[0] || null };
  } catch (error) { dbError('radar_state_symbol_read_failed', error); return { ok: false, reason: 'DB_UNAVAILABLE' }; }
}

// The canonical RADAR read. Candidates and freshness come from the atomized
// per-symbol state; the aggregate diagnostics (pipeline / funnel / provider status /
// regime) still come from the most recent run snapshot, because those are
// genuinely per-run figures.
//
// The snapshot may belong to an earlier run than the newest published market run —
// that is reported (`diagnosticsRunId`) rather than hidden, and it no longer forces
// the whole read to PENDING. Candidates existing at all is what makes the read
// READY, so a market run that has just been published but not yet scored serves the
// previous verdicts, correctly labelled with their own computed_at, instead of
// collapsing the terminal onto its legacy browser path.
async function readCanonicalRadar(db, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 2000);
  const [stateRes, snapRes] = await Promise.all([
    db.query(`SELECT ${RADAR_STATE_SELECT} FROM radar_candidate_state ORDER BY setup_score DESC NULLS LAST, execution_score DESC NULLS LAST, symbol ASC LIMIT $1`, [limit]),
    db.query(`SELECT run_id,status,source,computed_at,candidate_count,entry_ready_count,market_regime,pipeline,absorb_funnel,universe_diagnostics,provider_status FROM radar_run_snapshots ORDER BY computed_at DESC LIMIT 1`),
  ]);
  const rows = stateRes.rows;
  const snap = snapRes.rows[0] || null;
  const meta = {
    source: snap?.source || 'canonical_context',
    marketRegime: snap?.market_regime || {},
    pipeline: snap?.pipeline || {},
    absorbFunnel: snap?.absorb_funnel || {},
    universeDiagnostics: snap?.universe_diagnostics || {},
    providerStatus: snap?.provider_status || {},
    diagnosticsRunId: snap ? Number(snap.run_id) : null,
    diagnosticsComputedAt: snap?.computed_at || null,
  };
  if (!rows.length) {
    // The state table starts EMPTY: it is only filled by the first publisher cycle
    // after it is created. Reading PENDING in that window would discard a perfectly
    // good verdict already sitting in the run-keyed history — and would keep doing so
    // for as long as the publisher stays disabled or failing. So fall back to the
    // per-run snapshot when one exists.
    //
    // This is a LABELLED fallback, never a silent one: readSource says which table
    // answered, computedAt is the snapshot's own time (never "now"), and
    // stateBackfillPending tells the caller the atomized table has not been written
    // yet. A stale verdict the user can identify beats a blank panel; a stale verdict
    // posing as current would not.
    if (snap) {
      const legacy = await readRadarForRun(db, Number(snap.run_id));
      if (legacy.status === 'READY' && legacy.candidates.length) {
        return { ...legacy, readSource: 'run_snapshot_fallback', stateBackfillPending: true, pendingReason: 'RADAR_STATE_EMPTY', ...meta, status: 'READY', computedAt: snap.computed_at };
      }
    }
    // Nothing anywhere. Name which stage is missing so the UI can say whether the
    // collector or the publisher is the thing that is not running.
    return { status: 'PENDING', candidates: [], readSource: 'atomized_state', pendingReason: snap ? 'RADAR_RESULT_EMPTY' : 'NO_RADAR_RESULT', ...meta };
  }
  // Freshness of the set is its newest row; every row also carries its own
  // computed_at so a caller can judge any single coin independently.
  const newest = rows.reduce((max, row) => {
    const t = row.computed_at instanceof Date ? row.computed_at.getTime() : Date.parse(row.computed_at);
    return Number.isFinite(t) && t > max ? t : max;
  }, 0);
  return {
    status: 'READY',
    readSource: 'atomized_state',
    computedAt: newest > 0 ? new Date(newest) : null,
    candidateCount: rows.length,
    entryReadyCount: rows.filter((row) => row.entry_ready === true).length,
    candidates: rows,
    ...meta,
  };
}

async function readRadarForRun(db, runId) {
  const snapRes = await db.query(`SELECT run_id,status,source,computed_at,candidate_count,entry_ready_count,market_regime,pipeline,absorb_funnel,universe_diagnostics,provider_status FROM radar_run_snapshots WHERE run_id=$1`, [runId]);
  const snap = snapRes.rows[0];
  if (!snap) return { status: 'PENDING', runId, candidates: [] };
  const candRes = await db.query(`SELECT market,symbol,stage,entry_status,absorb_status,absorb_mode,strict_absorb_status,proxy_absorb_status,strict_absorb_score,proxy_absorb_score,strict_absorb_confirmed,reclaim_status,data_status,payload FROM radar_run_candidates WHERE run_id=$1 ORDER BY strict_absorb_confirmed DESC, COALESCE(strict_absorb_score,0) DESC`, [runId]);
  return { status: String(snap.status).toUpperCase(), runId, source: snap.source, computedAt: snap.computed_at, candidateCount: Number(snap.candidate_count), entryReadyCount: Number(snap.entry_ready_count), marketRegime: snap.market_regime || {}, pipeline: snap.pipeline || {}, absorbFunnel: snap.absorb_funnel || {}, universeDiagnostics: snap.universe_diagnostics || {}, providerStatus: snap.provider_status || {}, candidates: candRes.rows };
}

// Reads the atomized state, not a run: the alert path must not go blind for the
// stretch between a market run being published and that run being scored. Freshness
// is unchanged in kind — `computedAt` is still the verdict's own time, now taken
// from the newest state row rather than a run snapshot — and every candidate also
// carries its own `computed_at` for per-coin checks.
export async function getPublishedRadar(db) {
  try {
    return { ok: true, radar: await readCanonicalRadar(db, { limit: 2000 }) };
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