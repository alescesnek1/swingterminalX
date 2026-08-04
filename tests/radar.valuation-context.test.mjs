// Tests for netlify/functions/_radar-valuation-context.mjs — the bounded,
// fail-closed stored-history enrichment of the RADAR oversold/overbought read.
//
// The rules pinned here are the ones that matter operationally:
//   - the read is BOUNDED (top-N candidates, one batched call, no fan-out);
//   - a DB failure is distinguishable from "no history yet", stays visible in
//     radar.valuationSummary, and never removes the momentum-only band;
//   - enrichment touches ONLY candidate.valuation — no score, gate, status, or
//     Telegram field may move.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RADAR_VALUATION_POINTS_PER_SYMBOL,
  RADAR_VALUATION_TOP_N,
  applyValuationHistoryToRadar,
  loadValuationHistoryForCandidates,
  valuationSymbolsForCandidates,
} from '../netlify/functions/_radar-valuation-context.mjs';
import { buildValuationContext } from '../scripts/radar/valuation-bands.mjs';

const HOUR = 3600000;
const T0 = Date.parse('2026-08-01T00:00:00.000Z');

function storedPoints(symbol, from, to, n, stepMs = HOUR) {
  const start = T0 - (n - 1) * stepMs;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      symbol,
      price_usd: String(from + ((to - from) * (i / (n - 1)))),
      change_1h_pct: null,
      change_24h_pct: null,
      change_7d_pct: null,
      volume_24h_usd: 1_000_000,
      sampled_at: new Date(start + i * stepMs).toISOString(),
    });
  }
  return out;
}

function candidate(symbol, market) {
  return {
    symbol,
    STATUS: 'WATCH',
    SETUP_SCORE: 41,
    EXECUTION_SCORE: 55,
    FINAL_CONFIDENCE: 48,
    actionability: 'WATCH_ONLY',
    telegramEligible: false,
    valuation: buildValuationContext({ market: market || {} }),
  };
}

// ── symbol selection / bounding ─────────────────────────────────────────────

test('symbols are base assets, deduped, in rank order, and capped at the top-N', () => {
  const candidates = [
    { symbol: 'BTCUSDT' }, { symbol: 'BTCUSDC' }, { symbol: 'ETHUSDT' },
    { symbol: '' }, null, { symbol: 'SOLUSDT' },
  ];
  assert.deepEqual(valuationSymbolsForCandidates(candidates), ['BTC', 'ETH', 'SOL']);

  const many = Array.from({ length: 120 }, (_, i) => ({ symbol: `SYM${i}USDT` }));
  assert.equal(valuationSymbolsForCandidates(many).length, RADAR_VALUATION_TOP_N);
  assert.equal(valuationSymbolsForCandidates(many, 3).length, 3);
  assert.deepEqual(valuationSymbolsForCandidates(null), []);
});

test('the loader issues exactly ONE batched read for the whole candidate slice', async () => {
  const calls = [];
  const reader = async (args) => {
    calls.push(args);
    return { ok: true, bySymbol: new Map(), pointsPerSymbol: args.pointsPerSymbol };
  };
  const candidates = Array.from({ length: 60 }, (_, i) => ({ symbol: `S${i}USDT` }));
  const loaded = await loadValuationHistoryForCandidates(candidates, reader);
  assert.equal(calls.length, 1, 'must never fan out one query per symbol');
  assert.equal(calls[0].symbols.length, RADAR_VALUATION_TOP_N);
  assert.equal(calls[0].pointsPerSymbol, RADAR_VALUATION_POINTS_PER_SYMBOL);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.symbolsWithHistory, 0);
});

test('an empty candidate list reads nothing at all and is still ok', async () => {
  let called = false;
  const loaded = await loadValuationHistoryForCandidates([], async () => { called = true; return { ok: true, bySymbol: new Map() }; });
  assert.equal(called, false);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.symbolsRequested, 0);
});

// ── fail-closed behaviour ───────────────────────────────────────────────────

test('a missing reader, a failing reader, and a throwing reader each fail closed with a named reason', async () => {
  const candidates = [{ symbol: 'BTCUSDT' }];

  const noReader = await loadValuationHistoryForCandidates(candidates, null);
  assert.equal(noReader.ok, false);
  assert.equal(noReader.reason, 'PRICE_HISTORY_READER_UNAVAILABLE');
  assert.equal(noReader.layers.size, 0);

  const failing = await loadValuationHistoryForCandidates(candidates, async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }));
  assert.equal(failing.ok, false);
  assert.equal(failing.reason, 'DB_UNAVAILABLE');

  const throwing = await loadValuationHistoryForCandidates(candidates, async () => { throw new Error('socket hang up'); });
  assert.equal(throwing.ok, false);
  assert.equal(throwing.reason, 'DB_UNAVAILABLE');

  const malformed = await loadValuationHistoryForCandidates(candidates, async () => ({ ok: true, bySymbol: { BTC: [] } }));
  assert.equal(malformed.ok, false, 'a non-Map bySymbol is a broken read, not an empty one');
});

test('"database unavailable" and "no history yet" are distinguishable in the summary', async () => {
  const broken = { candidates: [candidate('BTCUSDT', { change24hPct: -20 })] };
  applyValuationHistoryToRadar(broken, await loadValuationHistoryForCandidates(broken.candidates, null));
  assert.equal(broken.valuationSummary.historyAvailable, false);
  assert.equal(broken.valuationSummary.historyUnavailableReason, 'PRICE_HISTORY_READER_UNAVAILABLE');
  assert.equal(broken.valuationSummary.historyEnrichedCandidates, 0);
  assert.equal(broken.candidates[0].valuation.VALUATION_BASIS, 'momentum_only', 'the momentum band must survive a DB failure');

  const emptyDb = { candidates: [candidate('BTCUSDT', { change24hPct: -20 })] };
  const loaded = await loadValuationHistoryForCandidates(emptyDb.candidates, async () => ({ ok: true, bySymbol: new Map() }));
  applyValuationHistoryToRadar(emptyDb, loaded);
  assert.equal(emptyDb.valuationSummary.historyAvailable, true, 'a reachable but empty DB is not a failure');
  assert.equal(emptyDb.valuationSummary.historyUnavailableReason, null);
  assert.equal(emptyDb.valuationSummary.historySymbolsWithData, 0);
  assert.equal(emptyDb.candidates[0].valuation.history.status, 'NO_HISTORY');
});

test('a radar state with no valuation summary at all still gets one, never silently nothing', () => {
  const radar = { candidates: [] };
  applyValuationHistoryToRadar(radar, { ok: false, reason: 'PRICE_HISTORY_MODULE_UNAVAILABLE', layers: new Map() });
  assert.equal(radar.valuationSummary.historyAvailable, false);
  assert.equal(radar.valuationSummary.historyUnavailableReason, 'PRICE_HISTORY_MODULE_UNAVAILABLE');
  assert.equal(applyValuationHistoryToRadar(null, {}), null);
  assert.doesNotThrow(() => applyValuationHistoryToRadar({ candidates: 'nope' }, 'nope'));
});

// ── enrichment ──────────────────────────────────────────────────────────────

test('a candidate with stored history is deepened to a history-backed band', async () => {
  const radar = { candidates: [candidate('BTCUSDT', { change24hPct: -19, change12hPct: -13, atrPct: 5 })] };
  const reader = async () => ({
    ok: true,
    bySymbol: new Map([['BTC', storedPoints('BTC', 100, 61, 40)]]),
    pointsPerSymbol: 60,
  });
  const loaded = await loadValuationHistoryForCandidates(radar.candidates, reader, { now: T0 });
  applyValuationHistoryToRadar(radar, loaded);

  const v = radar.candidates[0].valuation;
  assert.equal(v.VALUATION_BASIS, 'momentum+history');
  assert.equal(v.VALUATION_DIRECTION, 'OVERSOLD');
  assert.equal(v.history.available, true);
  assert.equal(v.history.rangePercentile, 0);
  assert.equal(v.isEntrySignal, false);
  assert.equal(v.affectsGate, false);
  assert.equal(v.affectsTelegram, false);
  assert.equal(radar.valuationSummary.historyEnrichedCandidates, 1);
  assert.equal(radar.valuationSummary.historySymbolsWithData, 1);
  assert.equal(radar.valuationSummary.oversoldTotal, 1);
  assert.equal(radar.valuationSummary.affectsGate, false);
  assert.equal(radar.valuationSummary.affectsTelegram, false);
});

test('enrichment touches ONLY candidate.valuation — every gate/score/status field is byte-identical', async () => {
  const before = candidate('ETHUSDT', { change24hPct: -22 });
  const snapshot = JSON.stringify({ ...before, valuation: undefined });
  const radar = { candidates: [before] };
  const reader = async () => ({ ok: true, bySymbol: new Map([['ETH', storedPoints('ETH', 100, 55, 40)]]) });
  applyValuationHistoryToRadar(radar, await loadValuationHistoryForCandidates(radar.candidates, reader, { now: T0 }));

  const after = JSON.stringify({ ...radar.candidates[0], valuation: undefined });
  assert.equal(after, snapshot, 'no field other than valuation may change');
  assert.equal(radar.candidates[0].telegramEligible, false);
  assert.equal(radar.candidates[0].SETUP_SCORE, 41);
  assert.equal(radar.candidates[0].STATUS, 'WATCH');
});

test('a symbol whose stored series is too thin keeps the momentum band and reports INSUFFICIENT_HISTORY', async () => {
  const radar = { candidates: [candidate('SOLUSDT', { change24hPct: -30, change12hPct: -20 })] };
  const reader = async () => ({ ok: true, bySymbol: new Map([['SOL', storedPoints('SOL', 100, 90, 4)]]) });
  applyValuationHistoryToRadar(radar, await loadValuationHistoryForCandidates(radar.candidates, reader, { now: T0 }));

  const v = radar.candidates[0].valuation;
  assert.equal(v.history.status, 'INSUFFICIENT_HISTORY');
  assert.equal(v.VALUATION_BASIS, 'momentum_only');
  assert.equal(v.VALUATION_DIRECTION, 'OVERSOLD', 'the momentum read must still stand on its own');
  assert.equal(radar.valuationSummary.historySymbolsWithData, 0);
  assert.equal(radar.valuationSummary.historyAvailable, true);
});

test('candidates outside the enriched top-N keep their momentum-only band without being marked broken', async () => {
  const candidates = Array.from({ length: 45 }, (_, i) => candidate(`S${i}USDT`, { change24hPct: -8 }));
  const radar = { candidates };
  const reader = async (args) => ({
    ok: true,
    bySymbol: new Map(args.symbols.map((s) => [s, storedPoints(s, 100, 70, 40)])),
  });
  applyValuationHistoryToRadar(radar, await loadValuationHistoryForCandidates(candidates, reader, { now: T0 }));

  assert.equal(radar.valuationSummary.historyEnrichedCandidates, RADAR_VALUATION_TOP_N);
  assert.equal(candidates[0].valuation.VALUATION_BASIS, 'momentum+history');
  assert.equal(candidates[44].valuation.VALUATION_BASIS, 'momentum_only');
  assert.equal(radar.valuationSummary.total, 45);
  assert.equal(radar.valuationSummary.momentumOnly + radar.valuationSummary.historyBacked, 45);
});
