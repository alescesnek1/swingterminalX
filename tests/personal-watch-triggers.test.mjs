import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateWatchTriggers,
  markTriggerSent,
  buildTriggerMessage,
  TRIGGER_TYPES,
  DEFAULT_BIG_MOVE_PCT,
} from '../netlify/functions/_personal-watch-triggers.mjs';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const candidate = {
  symbol: 'SOL',
  takeProfitCheckpoints: [110, 120, 135],
  suggestedStop: 92,
  invalidationLevel: 88,
};

test('a move beyond the threshold fires once, and the shortest window wins', () => {
  const t = evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW, ticker: { lastPrice: 100, change1hPct: -11, priceChangePercent: -3 } });
  assert.equal(t.length, 1);
  assert.equal(t[0].type, TRIGGER_TYPES.BIG_MOVE);
  assert.equal(t[0].window, '1h', 'a sharp 1h move must not be diluted by a flat 24h');
  assert.equal(t[0].direction, 'DOWN');
});

test('an absent window is skipped, never read as a 0% move', () => {
  const t = evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW, ticker: { lastPrice: 100, change1hPct: null, priceChangePercent: -12 } });
  assert.equal(t[0].window, '24h');
  // No windows at all → no movement claim can be made.
  assert.deepEqual(evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW, ticker: { lastPrice: 100 } }), []);
});

test('a quiet coin produces nothing', () => {
  assert.deepEqual(evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW, ticker: { lastPrice: 100, change1hPct: 1, priceChangePercent: 2 } }), []);
});

test('take profit reports the HIGHEST level reached, not one message per level', () => {
  const t = evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW, candidate, ticker: { lastPrice: 125 } });
  const tp = t.find((x) => x.type === TRIGGER_TYPES.TAKE_PROFIT);
  assert.equal(tp.level, 120, 'price gapped past TP1 and TP2 — report TP2 only');
  assert.equal(tp.index, 2);
  assert.equal(tp.total, 3);
});

test('the same take-profit level never resends; a higher one does', () => {
  let state = {};
  const first = evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW, candidate, state, ticker: { lastPrice: 112 } });
  state = markTriggerSent(state, first.find((x) => x.type === TRIGGER_TYPES.TAKE_PROFIT), new Date(NOW).toISOString());

  // Same level again, cooldown expired: still silent.
  const later = NOW + 3 * 60 * 60 * 1000;
  const repeat = evaluateWatchTriggers({ symbol: 'SOL', nowMs: later, candidate, state, ticker: { lastPrice: 113 } });
  assert.equal(repeat.some((x) => x.type === TRIGGER_TYPES.TAKE_PROFIT), false);

  // A higher level is genuinely new.
  const higher = evaluateWatchTriggers({ symbol: 'SOL', nowMs: later, candidate, state, ticker: { lastPrice: 136 } });
  assert.equal(higher.find((x) => x.type === TRIGGER_TYPES.TAKE_PROFIT).level, 135);
});

test('the stop uses the more decisive hard invalidation when both exist', () => {
  // 90 is below the 92 stop but above the 88 invalidation — the invalidation is
  // the level that actually decides, so nothing fires yet.
  assert.equal(evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW, candidate, ticker: { lastPrice: 90 } }).some((x) => x.type === TRIGGER_TYPES.STOP_LOSS), false);
  const broken = evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW, candidate, ticker: { lastPrice: 87 } });
  const sl = broken.find((x) => x.type === TRIGGER_TYPES.STOP_LOSS);
  assert.equal(sl.level, 88);
  assert.equal(sl.isInvalidation, true);
});

test('missing price or missing levels produce no TP/SL trigger', () => {
  // No price: nothing can be compared.
  assert.equal(evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW, candidate, ticker: {} }).length, 0);
  // Price but no candidate: no published level to claim.
  assert.equal(evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW, ticker: { lastPrice: 1 } }).length, 0);
  // A candidate with no usable levels.
  assert.equal(evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW, candidate: { takeProfitCheckpoints: ['x'], suggestedStop: null }, ticker: { lastPrice: 1 } }).length, 0);
});

test('the cooldown suppresses a repeat within the window', () => {
  const state = markTriggerSent({}, { symbol: 'SOL', type: TRIGGER_TYPES.BIG_MOVE, level: null }, new Date(NOW).toISOString());
  const soon = evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW + 60_000, state, ticker: { lastPrice: 100, change1hPct: -20 } });
  assert.equal(soon.length, 0);
  const after = evaluateWatchTriggers({ symbol: 'SOL', nowMs: NOW + 2 * 60 * 60 * 1000, state, ticker: { lastPrice: 100, change1hPct: -20 } });
  assert.equal(after.length, 1);
});

test('the default threshold is conservative enough not to be muted', () => {
  assert.ok(DEFAULT_BIG_MOVE_PCT >= 5);
});

// The watch record holds no entry price, so the message must not claim one.
test('messages never claim the user holds a position', () => {
  const tp = buildTriggerMessage({ type: TRIGGER_TYPES.TAKE_PROFIT, symbol: 'SOL', level: 120, price: 125, index: 2, total: 3 });
  assert.match(tp, /published by RADAR/);
  assert.doesNotMatch(tp, /your position|you bought|profit of/i);
  const move = buildTriggerMessage({ type: TRIGGER_TYPES.BIG_MOVE, symbol: 'SOL', changePct: -11, window: '1h', price: 100, direction: 'DOWN' });
  assert.match(move, /not an entry signal/);
});
