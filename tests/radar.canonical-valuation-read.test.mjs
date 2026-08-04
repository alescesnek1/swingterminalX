// Hotfix coverage: the canonical RADAR read (getPublishedRadar →
// readCanonicalRadar in netlify/functions/_market-context-store.mjs) must serve
// a radar the valuation UI can render honestly:
//
//   1. `radar.valuationSummary` is ALWAYS attached — the run/state tables never
//      persisted one, which is why production showed "the server sent no
//      valuation summary" on every cycle.
//   2. A state row whose stored payload predates the valuation feature (no
//      `valuation` block) gets a momentum-only band backfilled AT READ TIME from
//      that row's own momentum fields — the "Value UNKNOWN on every coin" bug.
//   3. A payload with no momentum fields at all stays honestly UNKNOWN.
//   4. The attach touches nothing but payload.valuation / radar.valuationSummary.
import test from 'node:test';
import assert from 'node:assert/strict';

import { getPublishedRadar } from '../netlify/functions/_market-context-store.mjs';

// Minimal fake db: answers the two readCanonicalRadar queries by table name.
function fakeDb({ stateRows = [], snapshots = [] } = {}) {
  return {
    query: async (sql) => {
      if (/FROM radar_candidate_state/.test(sql)) return { rows: stateRows, rowCount: stateRows.length };
      if (/FROM radar_run_snapshots/.test(sql)) return { rows: snapshots, rowCount: snapshots.length };
      if (/FROM radar_run_candidates/.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
}

function stateRow(symbol, payload) {
  return {
    market: 'spot', symbol, computed_at: new Date('2026-08-04T10:00:00Z'), observed_at: new Date('2026-08-04T10:00:00Z'),
    run_id: 7, source: 'canonical_context', status: 'WATCH', entry_type: null, entry_ready: false,
    setup_score: 40, execution_score: 50, confidence: 45,
    payload,
  };
}

test('canonical read always attaches valuationSummary, even on stale pre-valuation payloads', async () => {
  const rows = [
    // Pre-valuation payload with momentum fields → must be backfilled OVERSOLD.
    stateRow('AAAUSDT', { symbol: 'AAAUSDT', STATUS: 'WATCH', diagnostics: { change24hPct: -14 } }),
    // Pre-valuation payload with NO momentum anywhere → must stay UNKNOWN.
    stateRow('BBBUSDT', { symbol: 'BBBUSDT', STATUS: 'WATCH', diagnostics: {} }),
    // Post-valuation payload → its own server band must be preserved, not recomputed.
    stateRow('CCCUSDT', {
      symbol: 'CCCUSDT', STATUS: 'WATCH', diagnostics: { change24hPct: 2 },
      valuation: { VALUATION_BAND: 'OVERBOUGHT', VALUATION_SCORE: 41, isEntrySignal: false, affectsGate: false, affectsTelegram: false },
    }),
  ];
  const result = await getPublishedRadar(fakeDb({ stateRows: rows }));
  assert.equal(result.ok, true);
  const radar = result.radar;
  assert.equal(radar.status, 'READY');

  assert.ok(radar.valuationSummary && typeof radar.valuationSummary === 'object', 'summary must be attached');
  assert.equal(radar.valuationSummary.historyAvailable, false);
  assert.equal(radar.valuationSummary.historyUnavailableReason, 'CANONICAL_READ_MOMENTUM_ONLY');
  assert.equal(radar.valuationSummary.affectsGate, false);
  assert.equal(radar.valuationSummary.affectsTelegram, false);
  assert.equal(radar.valuationSummary.total, 3);
  assert.equal(radar.valuationSummary.oversoldTotal, 1);
  assert.equal(radar.valuationSummary.overboughtTotal, 1);
  assert.equal(radar.valuationSummary.unknown, 1);

  const bySym = new Map(radar.candidates.map((r) => [r.symbol, r.payload]));
  const backfilled = bySym.get('AAAUSDT').valuation;
  assert.equal(backfilled.VALUATION_DIRECTION, 'OVERSOLD', 'stale payload with momentum must gain a band');
  assert.equal(backfilled.VALUATION_BASIS, 'momentum_only');
  assert.equal(backfilled.isEntrySignal, false);
  assert.equal(bySym.get('BBBUSDT').valuation.VALUATION_BAND, 'UNKNOWN', 'no momentum stays UNKNOWN — nothing is invented');
  assert.equal(bySym.get('CCCUSDT').valuation.VALUATION_SCORE, 41, 'a server-written band is preserved, never recomputed');
});

test('the read-time attach changes nothing except payload.valuation and the summary', async () => {
  const payload = { symbol: 'DDDUSDT', STATUS: 'WATCH', telegramEligible: false, SETUP_SCORE: 61, diagnostics: { change24hPct: -9 } };
  const row = stateRow('DDDUSDT', payload);
  const before = JSON.stringify({ ...row, payload: { ...payload, valuation: undefined } });
  const result = await getPublishedRadar(fakeDb({ stateRows: [row] }));
  assert.equal(result.ok, true);
  const served = result.radar.candidates[0];
  const after = JSON.stringify({ ...served, payload: { ...served.payload, valuation: undefined } });
  assert.equal(after, before, 'typed columns, status, gates and scores must be byte-identical');
});

test('an empty state table with no snapshot still returns a PENDING radar WITH a summary', async () => {
  const result = await getPublishedRadar(fakeDb({ stateRows: [], snapshots: [] }));
  assert.equal(result.ok, true);
  assert.equal(result.radar.status, 'PENDING');
  assert.ok(result.radar.valuationSummary, 'even a pending radar carries the summary shape');
  assert.equal(result.radar.valuationSummary.total, 0);
  assert.equal(result.radar.valuationSummary.historyAvailable, false);
});
