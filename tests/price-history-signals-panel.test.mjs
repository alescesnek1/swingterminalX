// Pure render-model tests for the ADMIN-ONLY, read-only price-history
// reclaim/absorption diagnostics panel (Phase 1, BTC/ETH only). No DOM, no
// fetch — this module never invents a signal, only shapes/validates the
// already-safe backend response. Confirms: fail-closed on bad input, no
// crash on malformed shapes, and no buy/sell/long/short wording anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  priceHistorySignalRenderModel,
  priceHistorySignalErrorModel,
  priceHistorySignalSignedOutModel,
} from '../apps/edge/public/js/price-history-signals-panel.js';

const FORBIDDEN_WORDS = /\b(buy|sell|long|short)\b/i;

function assertNoTradingWords(model) {
  const flat = JSON.stringify(model);
  assert.doesNotMatch(flat, FORBIDDEN_WORDS, `render model must never contain trading-action wording: ${flat}`);
}

test('ok:true response with healthy reclaim/absorption shapes cleanly', () => {
  const api = {
    ok: true,
    symbol: 'BTC',
    points: 12,
    orderbookMode: 'external_browser_required',
    orderbookReason: 'ORDERBOOK_AUTH_REQUIRED',
    reclaim: { status: 'OK', signal: 'BULLISH_RECLAIM', reason: 'held above level', confidence: 'high' },
    absorption: { status: 'OK', signal: 'NO_ABSORPTION', reason: 'no volume spike', confidence: 'low' },
  };
  const m = priceHistorySignalRenderModel(api);
  assert.equal(m.ok, true);
  assert.equal(m.symbol, 'BTC');
  assert.equal(m.points, 12);
  assert.equal(m.statusText, '12 history points');
  assert.equal(m.reclaim.signal, 'BULLISH_RECLAIM');
  assert.equal(m.absorption.signal, 'NO_ABSORPTION');
  assert.equal(m.orderbookModeText, 'External browser required');
  assertNoTradingWords(m);
});

test('insufficient history fails closed to UNKNOWN, never a directional guess', () => {
  const api = {
    ok: true,
    symbol: 'ETH',
    points: 2,
    reclaim: { status: 'INSUFFICIENT_HISTORY', signal: 'UNKNOWN', reason: 'need >= 5 valid points, have 2', confidence: 'low' },
    absorption: { status: 'INSUFFICIENT_HISTORY', signal: 'UNKNOWN', reason: 'need >= 8 valid points, have 2', confidence: 'low' },
  };
  const m = priceHistorySignalRenderModel(api);
  assert.equal(m.reclaim.signal, 'UNKNOWN');
  assert.equal(m.absorption.signal, 'UNKNOWN');
  assert.equal(m.reclaim.status, 'INSUFFICIENT_HISTORY');
  assertNoTradingWords(m);
});

test('ok:false response degrades to an explicit error model, not a crash', () => {
  const m = priceHistorySignalRenderModel({ ok: false, reason: 'DB_UNAVAILABLE' });
  assert.equal(m.ok, false);
  assert.equal(m.error, true);
  assert.equal(m.status, 'DB_UNAVAILABLE');
  assert.equal(m.statusText, 'Unavailable');
  assert.equal(m.reasonText, 'Price-history database unavailable in this environment.');
  assert.equal(m.reclaim.signal, 'UNKNOWN');
  assertNoTradingWords(m);
});

test('malformed/garbage input never throws and always degrades safely', () => {
  for (const bad of [null, undefined, {}, [], 42, 'nope', { ok: true, reclaim: 'garbage', absorption: 5 }]) {
    assert.doesNotThrow(() => priceHistorySignalRenderModel(bad));
    const m = priceHistorySignalRenderModel(bad);
    assert.equal(m.reclaim.signal, 'UNKNOWN');
    assert.equal(m.absorption.signal, 'UNKNOWN');
    assertNoTradingWords(m);
  }
});

test('points=0 renders as insufficient history, not a fabricated zero reading', () => {
  const m = priceHistorySignalRenderModel({ ok: true, symbol: 'BTC', points: 0, reclaim: {}, absorption: {} });
  assert.equal(m.statusText, 'Insufficient history');
});

test('symbolFallback is used only when the API response omits symbol', () => {
  assert.equal(priceHistorySignalRenderModel({ ok: true, points: 1 }, 'ETH').symbol, 'ETH');
  assert.equal(priceHistorySignalRenderModel({ ok: true, points: 1, symbol: 'BTC' }, 'ETH').symbol, 'BTC');
});

test('errorModel and signedOutModel never throw and carry no trading wording', () => {
  const e = priceHistorySignalErrorModel('Could not load BTC signals.');
  assert.equal(e.error, true);
  assert.equal(e.statusText, 'Could not load BTC signals.');
  assertNoTradingWords(e);

  const s = priceHistorySignalSignedOutModel();
  assert.equal(s.error, true);
  assert.match(s.statusText, /sign in/i);
  assertNoTradingWords(s);
});

test('window.__priceHistorySignalsPanel is exposed for the plain-script terminal.js to consume', async () => {
  // Simulate the browser global before importing a fresh copy of the module.
  const originalWindow = globalThis.window;
  globalThis.window = {};
  try {
    await import(`../apps/edge/public/js/price-history-signals-panel.js?cachebust=${Date.now()}`);
    assert.equal(typeof globalThis.window.__priceHistorySignalsPanel.toRenderModel, 'function');
    assert.equal(typeof globalThis.window.__priceHistorySignalsPanel.errorModel, 'function');
    assert.equal(typeof globalThis.window.__priceHistorySignalsPanel.signedOutModel, 'function');
  } finally {
    globalThis.window = originalWindow;
  }
});


test('NO_HISTORY response stays successful and renders as waiting/degraded text', () => {
  const m = priceHistorySignalRenderModel({
    ok: true, status: 'NO_HISTORY', symbol: 'HOME', points: 0,
    reclaim: { status: 'INSUFFICIENT_HISTORY', signal: 'UNKNOWN', reason: 'No scheduled history yet.' },
    absorption: { status: 'INSUFFICIENT_HISTORY', signal: 'UNKNOWN', reason: 'No scheduled history yet.' },
    orderbookUsed: false, orderbookReason: 'NO_HISTORY',
  });
  assert.equal(m.ok, true);
  assert.equal(m.status, 'NO_HISTORY');
  assert.equal(m.error, false);
  assert.equal(m.statusText, 'No scheduled history yet.');
});
