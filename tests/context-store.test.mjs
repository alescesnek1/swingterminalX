import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRunKey, sanitizeDiagnostics, insertAtomicMarketRecords, getAtomizedMarketContext, getRadarInputBundle } from '../netlify/functions/_market-context-store.mjs';

// Runs that drifted closer together than the honest collector window (120s). Taking
// the immediately previous run as the depth baseline yielded windowSec ~40 and the
// STRICT validator then rejected every symbol of the run with 'window-invalid'.
function driftedRunsDb(capturedPrevIds) {
  const now = Date.parse('2026-07-26T17:48:00.000Z');
  const at = (secAgo) => new Date(now - secAgo * 1000).toISOString();
  return { query: async (sql, values = []) => {
    if (sql.includes('FROM market_collection_runs')) return { rows: [{ id: 40, observed_at: at(0) }, { id: 39, observed_at: at(40) }, { id: 38, observed_at: at(75) }, { id: 37, observed_at: at(200) }, { id: 36, observed_at: at(400) }] };
    if (sql.includes('FROM market_microstructure_measurements')) { if (values[0] !== 40) capturedPrevIds.push(values[0]); return { rows: [] }; }
    if (sql.includes('FROM market_ticker_observations')) return { rows: [] };
    return { rows: [] };
  } };
}

test('the depth baseline skips drifted runs and reports the true elapsed window', async () => {
  const prevIds = [];
  const bundle = await getRadarInputBundle(driftedRunsDb(prevIds), { topN: 5 });
  assert.equal(bundle.ok, true);
  // 40s and 75s are below the 120s floor; run 37 at 200s is the first honest baseline.
  assert.equal(bundle.previousRun.id, 37);
  assert.equal(bundle.windowSec, 200);
  assert.deepEqual(prevIds, [37], 'previous-depth lookup uses the chosen baseline run');
});

test('makeRunKey uses a deterministic UTC three-minute bucket', () => {
  assert.equal(makeRunKey(new Date('2026-07-24T12:04:59.999Z')), 'global:2026-07-24T12:03:00.000Z');
  assert.equal(makeRunKey(new Date('2026-07-24T12:06:00.000Z')), 'global:2026-07-24T12:06:00.000Z');
});

test('sanitizeDiagnostics strips secret-shaped values at every depth', () => {
  const clean = sanitizeDiagnostics({ count: 2, authorization: 'Bearer x', nested: { apiKey: 'no', status: 'ok' }, headers: { accept: 'x' }, rows: [{ token: 'x', code: 'PARTIAL' }] });
  assert.deepEqual(clean, { count: 2, nested: { status: 'ok' }, rows: [{ code: 'PARTIAL' }] });
});

test('atomic persistence writes ticker, candle, book level, trade and measurement rows without a revision or head', async () => {
  const calls = []; const db = { query: async (sql, values = []) => { calls.push({ sql, values }); return { rows: [] }; } };
  const result = await insertAtomicMarketRecords(db, { runId: 7, observedAt: new Date('2026-07-24T12:00:00.000Z'), rows: [{ market: 'spot', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', lastPrice: '100', quoteVolume: '500', dataStatus: 'complete' }], microstructure: [{ market: 'spot', symbol: 'BTCUSDT', dataStatus: 'complete', klines1m: [[1721822340000, '99', '101', '98', '100', '5', 1721822399999, '500', 7]], orderBook: { lastUpdateId: 4, bids: [['99', '1']], asks: [['101', '2']] }, aggTrades: [{ a: 11, p: '100', q: '1', m: false, T: 1721822399000, M: true }], depthSummary: { levels: { bids: 1, asks: 1 }, bestBid: 99, bestAsk: 101, spreadBps: 200, bidQuote: 99, askQuote: 202 }, tradesSummary: { count: 1, takerBuyQuote: 100, takerSellQuote: 0 } }] });
  assert.equal(result.ok, true); assert.equal(result.tickerCount, 1); assert.equal(result.candleCount, 1); assert.equal(result.orderBookLevelCount, 2); assert.equal(result.aggTradeCount, 1); assert.equal(result.measurementCount, 1);
  const sql = calls.map((call) => call.sql).join('\n');
  for (const table of ['market_instruments', 'market_ticker_observations', 'market_candles_1m', 'market_order_book_levels', 'market_agg_trades', 'market_microstructure_measurements']) assert.match(sql, new RegExp(table));
  assert.doesNotMatch(sql, /context_heads|market_context_snapshots|revision_id/i);
});

test('read returns the latest published run and atomized ticker and measurement rows', async () => {
  const db = { query: async (sql) => {
    if (sql.includes('FROM market_collection_runs')) return { rows: [{ id: 9, run_key: 'global:2026-07-24T12:00:00.000Z', observed_at: new Date().toISOString(), completed_at: new Date().toISOString(), diagnostics: { tickerCount: 1 } }] };
    if (sql.includes('FROM market_ticker_observations')) return { rows: [{ market: 'spot', symbol: 'BTCUSDT', last_price: '100', data_status: 'complete' }] };
    if (sql.includes('FROM market_microstructure_measurements')) return { rows: [{ market: 'spot', symbol: 'BTCUSDT', data_status: 'partial', missing_inputs: ['DEPTH'] }] };
    if (sql.includes('FROM radar_run_snapshots')) return { rows: [] };
    if (sql.includes('FROM radar_run_candidates')) return { rows: [] };
    throw new Error('unexpected query');
  } };
  const context = await getAtomizedMarketContext(db);
  assert.equal(context.ok, true); assert.equal(context.contextVersion, null); assert.equal(context.run.id, 9); assert.equal(context.market.freshness, 'FRESH'); assert.equal(context.market.tickers[0].symbol, 'BTCUSDT'); assert.equal(context.market.microstructure[0].data_status, 'partial');
  // A run with no computed RADAR result reads back as PENDING (never a fake ready).
  assert.equal(context.radar.status, 'PENDING');
});