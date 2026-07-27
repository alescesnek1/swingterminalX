import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRunKey, sanitizeDiagnostics, insertAtomicMarketRecords, getAtomizedMarketContext, getRadarInputBundle, upsertRadarCandidateStates, getRadarCandidateState } from '../netlify/functions/_market-context-store.mjs';

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

// Derived rows scale with the universe; raw trades and book levels do not. Every
// measured symbol keeps its measurement, only the raw audit sample is bounded.
test('raw trades and book levels are bounded to the busiest symbols; measurements are not', async () => {
  const calls = []; const db = { query: async (sql, values = []) => { calls.push({ sql, values }); return { rows: [] }; } };
  const micro = (symbol, takerBuyQuote) => ({ market: 'spot', symbol, dataStatus: 'complete', klines1m: [[1721822340000, '99', '101', '98', '100', '5', 1721822399999, '500', 7]], orderBook: { lastUpdateId: 4, bids: [['99', '1']], asks: [['101', '2']] }, aggTrades: [{ a: 11, p: '100', q: '1', m: false, T: 1721822399000, M: true }], depthSummary: { levels: { bids: 1, asks: 1 }, bestBid: 99, bestAsk: 101, spreadBps: 200, bidQuote: 99, askQuote: 202 }, tradesSummary: { count: 1, takerBuyQuote, takerSellQuote: 0 } });
  const result = await insertAtomicMarketRecords(db, { runId: 7, observedAt: new Date('2026-07-24T12:00:00.000Z'), rows: [], rawSampleTopN: 2, microstructure: [micro('AUSDT', 10), micro('BUSDT', 300), micro('CUSDT', 200)] });
  assert.equal(result.ok, true);
  assert.equal(result.measurementCount, 3, 'every measured symbol keeps its derived row');
  assert.equal(result.candleCount, 3, 'candles are kept for every symbol (structural reclaim reads them)');
  assert.equal(result.rawSampleCount, 2);
  assert.equal(result.aggTradeCount, 2, 'raw trades only for the busiest two');
  assert.equal(result.orderBookLevelCount, 4, 'two levels each for the busiest two');
  // The thinnest symbol is the one dropped from the raw sample, not an arbitrary one.
  const rawSql = calls.filter((c) => /market_agg_trades|market_order_book_levels/.test(c.sql)).map((c) => c.values.join(',')).join('|');
  assert.doesNotMatch(rawSql, /AUSDT/);
  assert.match(rawSql, /BUSDT/);
});

test('read returns the latest published run and atomized ticker and measurement rows', async () => {
  const db = { query: async (sql) => {
    if (sql.includes('FROM market_collection_runs')) return { rows: [{ id: 9, run_key: 'global:2026-07-24T12:00:00.000Z', observed_at: new Date().toISOString(), completed_at: new Date().toISOString(), diagnostics: { tickerCount: 1 } }] };
    if (sql.includes('FROM market_ticker_observations')) return { rows: [{ market: 'spot', symbol: 'BTCUSDT', last_price: '100', data_status: 'complete' }] };
    if (sql.includes('FROM market_microstructure_measurements')) return { rows: [{ market: 'spot', symbol: 'BTCUSDT', data_status: 'partial', missing_inputs: ['DEPTH'] }] };
    if (sql.includes('FROM radar_candidate_state')) return { rows: [] };
    if (sql.includes('FROM radar_run_snapshots')) return { rows: [] };
    if (sql.includes('FROM radar_run_candidates')) return { rows: [] };
    throw new Error('unexpected query');
  } };
  const context = await getAtomizedMarketContext(db);
  assert.equal(context.ok, true); assert.equal(context.contextVersion, null); assert.equal(context.run.id, 9); assert.equal(context.market.freshness, 'FRESH'); assert.equal(context.market.tickers[0].symbol, 'BTCUSDT'); assert.equal(context.market.microstructure[0].data_status, 'partial');
  // No RADAR state at all reads back as PENDING (never a fake ready).
  assert.equal(context.radar.status, 'PENDING');
});

// ── atomized RADAR state decouples the verdict from the run pointer ──────────
// The collector marks a run published at the END of collection and scores it only
// afterwards, so the run-keyed read returned PENDING for the newest run every cycle
// and the terminal silently fell back to its legacy browser radar — Strict Absorb
// flipped between a real verdict and "DATA OFF". State keyed by (market, symbol)
// removes the window: there is always a current row.
function stateRow(overrides = {}) {
  return { market: 'spot', symbol: 'BTCUSDT', computed_at: new Date('2026-07-27T09:00:00.000Z'), observed_at: new Date('2026-07-27T08:59:00.000Z'), status: 'WATCH', entry_ready: false, setup_score: 71, execution_score: 40, strict_absorb_confirmed: true, absorb_status: 'ABSORB_CONFIRMED', payload: { STATUS: 'WATCH' }, ...overrides };
}
function stateDb(rows, { snapshot = null } = {}) {
  return { query: async (sql) => {
    if (sql.includes('FROM market_collection_runs')) return { rows: [{ id: 9, run_key: 'k', observed_at: new Date().toISOString(), completed_at: new Date().toISOString(), diagnostics: {} }] };
    if (sql.includes('FROM market_ticker_observations')) return { rows: [] };
    if (sql.includes('FROM market_microstructure_measurements')) return { rows: [] };
    if (sql.includes('FROM radar_candidate_state')) return { rows };
    if (sql.includes('FROM radar_run_snapshots')) return { rows: snapshot ? [snapshot] : [] };
    throw new Error('unexpected query');
  } };
}

test('a freshly published run with no snapshot of its own still reads READY from state', async () => {
  const context = await getAtomizedMarketContext(stateDb([stateRow()]));
  assert.equal(context.ok, true);
  assert.equal(context.radar.status, 'READY', 'state exists, so the read is not PENDING');
  assert.equal(context.radar.readSource, 'atomized_state');
  assert.equal(context.radar.candidates[0].symbol, 'BTCUSDT');
  // The verdict carries its own clock, not the run's.
  assert.equal(context.radar.computedAt.toISOString(), '2026-07-27T09:00:00.000Z');
});

test('state read reports entry-ready count and per-row freshness, newest row wins', async () => {
  const rows = [
    stateRow({ symbol: 'AAAUSDT', entry_ready: true, computed_at: new Date('2026-07-27T09:05:00.000Z') }),
    stateRow({ symbol: 'BBBUSDT', entry_ready: false, computed_at: new Date('2026-07-27T09:00:00.000Z') }),
  ];
  const context = await getAtomizedMarketContext(stateDb(rows));
  assert.equal(context.radar.candidateCount, 2);
  assert.equal(context.radar.entryReadyCount, 1);
  assert.equal(context.radar.computedAt.toISOString(), '2026-07-27T09:05:00.000Z');
  // Each row keeps its own computed_at so a single stale coin stays identifiable.
  assert.equal(context.radar.candidates[1].computed_at.toISOString(), '2026-07-27T09:00:00.000Z');
});

test('aggregate diagnostics come from the newest snapshot and name the run they describe', async () => {
  const snapshot = { run_id: 8, status: 'ready', source: 'canonical_context', computed_at: new Date('2026-07-27T08:57:00.000Z'), candidate_count: 1, entry_ready_count: 0, market_regime: { status: 'NEUTRAL' }, pipeline: {}, absorb_funnel: {}, universe_diagnostics: {}, provider_status: { ABSORB_MODE: 'STRICT' } };
  const context = await getAtomizedMarketContext(stateDb([stateRow()], { snapshot }));
  assert.equal(context.radar.status, 'READY');
  assert.equal(context.radar.providerStatus.ABSORB_MODE, 'STRICT');
  // Run 8's diagnostics against run 9's market data is reported, not hidden.
  assert.equal(context.radar.diagnosticsRunId, 8);
});
// ── atomized RADAR state writer ──────────────────────────────────────────────
const COMPUTED = new Date('2026-07-27T09:00:00.000Z');
function captureDb() {
  const calls = [];
  return { calls, query: async (sql, values = []) => { calls.push({ sql, values }); return { rows: [] }; } };
}
function candidate(overrides = {}) {
  return {
    market: 'spot', symbol: 'BTCUSDT', STATUS: 'EARLY_ENTRY_READY', ENTRY_TYPE: 'EARLY_REVERSAL',
    allRadarConditionsPassed: true, SETUP_SCORE: 74, EXECUTION_SCORE: 68, RISK_REWARD_SCORE: 72,
    MARKET_REGIME_SCORE: 61, FINAL_CONFIDENCE: 69, DISLOCATION_SCORE: 80, FLUSH_SCORE: 70,
    STABILIZATION_SCORE: 60, RECLAIM_SCORE: 65, ORDER_BOOK_SUPPORT_SCORE: 70,
    FLOW_CONFIRMATION_SCORE: 66, DERIVATIVES_RISK_SCORE: 55,
    RECLAIM_STATUS: 'RECLAIM_CONFIRMED', ABSORB_STATUS: 'ABSORB_CONFIRMED', ABSORB_MODE: 'STRICT',
    STRICT_ABSORB_STATUS: 'ABSORB_CONFIRMED', STRICT_ABSORB_SCORE: 71, STRICT_ABSORB_CONFIRMED: true,
    ENTRY_ZONE: { low: 0.285, high: 0.315 }, STOP_LOSS_LEVEL: 0.238, HARD_INVALIDATION: 0.22,
    TAKE_PROFIT_LEVELS: [{ label: 'TP1', level: 0.4 }, { label: 'TP2', level: 0.53 }, { label: 'TP3', level: 0.71 }],
    POSITION_SIZE_GUIDANCE: '25-40% planned position',
    TIMEFRAME_CONTEXT: '1D setup, 1H/15M execution', TIME_VALIDITY: 'valid until next 1H close',
    dataStatus: 'ready', dataQuality: { missingData: ['OPEN_INTEREST'] },
    ...overrides,
  };
}
function valuesFor(db) { return db.calls.find((c) => /INSERT INTO radar_candidate_state/.test(c.sql))?.values || []; }

test('state writer upserts on (market, symbol) and never inserts a second row per coin', async () => {
  const db = captureDb();
  const result = await upsertRadarCandidateStates(db, { candidates: [candidate()], runId: 9, computedAt: COMPUTED, observedAt: COMPUTED });
  assert.equal(result.ok, true);
  assert.equal(result.written, 1);
  const call = db.calls.find((c) => /INSERT INTO radar_candidate_state/.test(c.sql));
  assert.match(call.sql, /ON CONFLICT \(market,symbol\) DO UPDATE/);
  // Not a snapshot: no run_id in the key, so a new run replaces the coin's verdict.
  assert.doesNotMatch(call.sql, /ON CONFLICT \([^)]*run_id/);
});

test('state writer stores the full trade plan the spec requires', async () => {
  const db = captureDb();
  await upsertRadarCandidateStates(db, { candidates: [candidate()], runId: 9, computedAt: COMPUTED, observedAt: COMPUTED });
  const values = valuesFor(db);
  for (const expected of [0.285, 0.315, 0.238, 0.22, 0.4, 0.53, 0.71, 25, 40]) {
    assert.ok(values.includes(expected), `trade plan value ${expected} is persisted`);
  }
  assert.ok(values.includes('EARLY_ENTRY_READY'));
  assert.ok(values.includes('EARLY_REVERSAL'));
});

test('an unparseable position size stores NULL, never 0 — 0% is itself a real verdict', async () => {
  const db = captureDb();
  await upsertRadarCandidateStates(db, { candidates: [candidate({ POSITION_SIZE_GUIDANCE: 'see strategy notes' })], runId: 9, computedAt: COMPUTED, observedAt: COMPUTED });
  const values = valuesFor(db);
  // The guidance text is kept verbatim; the numeric columns stay unknown.
  assert.ok(values.includes('see strategy notes'));
  assert.equal(values.filter((v) => v === 0).length, 0, 'no parsed zero is invented from an unreadable guidance string');
});

test('a real 0% verdict is stored as 0, and a single-bound guidance sets both bounds', async () => {
  const zero = captureDb();
  await upsertRadarCandidateStates(zero, { candidates: [candidate({ STATUS: 'RISK_OFF_BLOCKED', POSITION_SIZE_GUIDANCE: '0% planned position' })], runId: 9, computedAt: COMPUTED, observedAt: COMPUTED });
  assert.ok(valuesFor(zero).includes(0), 'an explicit 0% guidance is a value, not a gap');
  const single = captureDb();
  await upsertRadarCandidateStates(single, { candidates: [candidate({ POSITION_SIZE_GUIDANCE: '30% planned position' })], runId: 9, computedAt: COMPUTED, observedAt: COMPUTED });
  assert.equal(valuesFor(single).filter((v) => v === 30).length, 2, 'low and high both take the single bound');
});

test('a status the V1 machine never produced is stored as UNKNOWN, not coerced or dropped', async () => {
  const db = captureDb();
  const result = await upsertRadarCandidateStates(db, { candidates: [candidate({ STATUS: 'TOTALLY_MADE_UP' })], runId: 9, computedAt: COMPUTED, observedAt: COMPUTED });
  assert.equal(result.written, 1, 'the coin is still stored');
  const values = valuesFor(db);
  assert.ok(values.includes('UNKNOWN'));
  assert.equal(values.includes('TOTALLY_MADE_UP'), false, 'an unrecognised state never reaches the status column');
});

test('missing scores stay NULL so they read as UNKNOWN, never as a zero score', async () => {
  const db = captureDb();
  const bare = { market: 'spot', symbol: 'XYZUSDT', STATUS: 'WATCH' };
  await upsertRadarCandidateStates(db, { candidates: [bare], runId: 9, computedAt: COMPUTED, observedAt: COMPUTED });
  const values = valuesFor(db);
  assert.equal(values.filter((v) => v === 0).length, 0, 'an absent score is never written as 0');
  assert.ok(values.includes(null), 'absent scores are explicit NULLs');
});

test('a DB failure returns a reason and never throws into the publisher', async () => {
  const db = { query: async () => { throw Object.assign(new Error('nope'), { code: '42P01' }); } };
  const result = await upsertRadarCandidateStates(db, { candidates: [candidate()], runId: 9, computedAt: COMPUTED, observedAt: COMPUTED });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'DB_UNAVAILABLE');
});

test('an empty candidate set writes nothing rather than clearing the table', async () => {
  const db = captureDb();
  const result = await upsertRadarCandidateStates(db, { candidates: [], runId: 9, computedAt: COMPUTED, observedAt: COMPUTED });
  assert.deepEqual(result, { ok: true, written: 0 });
  assert.equal(db.calls.length, 0);
  // Nothing resembling a DELETE: a cycle that scored no candidate must not wipe
  // the verdicts the previous cycle legitimately produced.
});

test('Cockpit single-coin read resolves one verdict and rejects a junk symbol', async () => {
  const db = { query: async (sql, values) => { assert.match(sql, /FROM radar_candidate_state WHERE symbol=\$1/); assert.equal(values[0], 'BTCUSDT'); return { rows: [stateRow()] }; } };
  const found = await getRadarCandidateState(db, ' btcusdt ');
  assert.equal(found.ok, true);
  assert.equal(found.state.symbol, 'BTCUSDT');
  const bad = await getRadarCandidateState(db, '!!!');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'INVALID_SYMBOL');
});
