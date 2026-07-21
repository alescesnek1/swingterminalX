// Tests for apps/edge/public/js/price-history-orderbook.js — the browser-safe
// helper that merges the server's history-only signal response with an order
// book the BROWSER fetched from /api/orderbook.
//
// Context: Netlify's Node runtime cannot obtain a Binance book (Node->Edge
// bridge => ORDERBOOK_HTTP_502, direct public depth => ORDERBOOK_BINANCE_HTTP_451
// geo-block). The browser can, so book context is merged client-side. These
// tests are pure — no fetch, no DOM, no network.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  combinePriceHistorySignalsWithOrderbook,
  summarizeBrowserOrderbook,
  orderbookSupportFrom,
  gradeAbsorptionConfidence,
} from '../apps/edge/public/js/price-history-orderbook.js';

import { analyzeAbsorptionFromPointsAndOrderbook } from '../netlify/functions/_price-history-signals.mjs';

const BID_BOOK = { best_bid: 100, best_ask: 100.1, spread_bps: 10, imbalance: 0.35, cumulative_bid_qty: 5, cumulative_ask_qty: 3 };
const ASK_BOOK = { best_bid: 100, best_ask: 100.1, spread_bps: 10, imbalance: -0.35, cumulative_bid_qty: 3, cumulative_ask_qty: 5 };
const FLAT_BOOK = { best_bid: 100, best_ask: 100.1, spread_bps: 10, imbalance: 0.02, cumulative_bid_qty: 4, cumulative_ask_qty: 4 };

// A realistic history-only server response: Node could not get a book, so it
// reported the failure honestly and degraded absorption to history-only.
function serverResponse(overrides = {}) {
  return {
    ok: true,
    symbol: 'BTC',
    points: 12,
    orderbookUsed: false,
    orderbookReason: 'ORDERBOOK_UNAVAILABLE',
    orderbookBridgeReason: 'ORDERBOOK_HTTP_502',
    orderbookFallbackReason: 'ORDERBOOK_BINANCE_HTTP_451',
    orderbookSource: null,
    serverOrderbookAvailable: false,
    orderbookMode: 'external_browser_required',
    reclaim: { ok: true, symbol: 'BTC', signal: 'BULLISH_RECLAIM', confidence: 'medium', status: 'OK', level: 104, pointsUsed: 12 },
    absorption: {
      ok: true, symbol: 'BTC', signal: 'BULLISH_ABSORPTION', confidence: 'low', status: 'OK',
      volumeRatio: 1.3, priceChangeAfterVolume: 0.5, orderbookUsed: false, orderbookSupport: null,
      bidAskImbalance: null, spreadPct: null, pointsUsed: 12, reason: 'history-only proxy',
    },
    ...overrides,
  };
}

test('summarizeBrowserOrderbook accepts the /api/orderbook summarized shape', () => {
  const book = summarizeBrowserOrderbook(BID_BOOK);
  assert.equal(book.imbalance, 0.35);
  assert.equal(book.spreadPct, 0.1);
  assert.equal(book.bidQty, 5);
  assert.equal(book.askQty, 3);
});

test('summarizeBrowserOrderbook accepts a raw depth payload and rejects unusable shapes', () => {
  const raw = summarizeBrowserOrderbook({ bids: [['100', '2']], asks: [['100.1', '1']] });
  assert.ok(raw.imbalance > 0);
  for (const bad of [null, undefined, 'nope', 42, {}, { bids: [], asks: [] }, { imbalance: 'x' }]) {
    assert.equal(summarizeBrowserOrderbook(bad), null);
  }
});

test('orderbookSupportFrom mirrors the server helper thresholds', () => {
  assert.equal(orderbookSupportFrom(0.35), 'bid');
  assert.equal(orderbookSupportFrom(0.15), 'bid');
  assert.equal(orderbookSupportFrom(0.02), 'neutral');
  assert.equal(orderbookSupportFrom(-0.15), 'ask');
  assert.equal(orderbookSupportFrom(-0.35), 'ask');
});

test('a browser order book drives absorption context and re-grades confidence', () => {
  const merged = combinePriceHistorySignalsWithOrderbook({ signals: serverResponse(), orderbook: BID_BOOK });
  assert.equal(merged.ok, true);
  assert.equal(merged.orderbookUsed, true);
  assert.equal(merged.orderbookSource, 'browser_api_orderbook');
  assert.equal(merged.orderbookReason, 'OK');
  assert.equal(merged.absorption.orderbookUsed, true);
  assert.equal(merged.absorption.orderbookSupport, 'bid');
  assert.equal(merged.absorption.bidAskImbalance, 0.35);
  // Aligned bid book on a bullish read lifts confidence above the
  // history-only 'low'.
  assert.equal(merged.absorption.confidence, 'medium');
  // The history-derived signal itself is never altered by the book.
  assert.equal(merged.absorption.signal, 'BULLISH_ABSORPTION');
});

test('a contradicting book pins confidence to low but never flips the signal', () => {
  const merged = combinePriceHistorySignalsWithOrderbook({ signals: serverResponse(), orderbook: ASK_BOOK });
  assert.equal(merged.absorption.signal, 'BULLISH_ABSORPTION', 'signal must remain history-derived');
  assert.equal(merged.absorption.orderbookSupport, 'ask');
  assert.equal(merged.absorption.confidence, 'low');
});

test('accepts the whole /api/orderbook response body, unwrapping .orderbook', () => {
  const body = { pair: 'BTCUSDT', market: 'spot', exchange: 'BIN', source: 'binance', orderbook: BID_BOOK };
  const merged = combinePriceHistorySignalsWithOrderbook({ signals: serverResponse(), orderbook: body });
  assert.equal(merged.orderbookUsed, true);
  assert.equal(merged.absorption.orderbookSupport, 'bid');
});

test('reclaim is pure history and passes through the merge untouched', () => {
  const server = serverResponse();
  const merged = combinePriceHistorySignalsWithOrderbook({ signals: server, orderbook: BID_BOOK });
  assert.deepEqual(merged.reclaim, server.reclaim);
});

test('insufficient history stays UNKNOWN with its counts intact even with a live book', () => {
  const server = serverResponse({
    points: 1,
    reclaim: { ok: true, signal: 'UNKNOWN', confidence: 'low', status: 'INSUFFICIENT_HISTORY', reason: 'need >= 5 valid points, have 1' },
    absorption: { ok: true, signal: 'UNKNOWN', confidence: 'low', status: 'INSUFFICIENT_HISTORY', volumeRatio: null, orderbookUsed: false, reason: 'need >= 8 valid points, have 1' },
  });
  const merged = combinePriceHistorySignalsWithOrderbook({ signals: server, orderbook: BID_BOOK });
  assert.equal(merged.points, 1);
  assert.equal(merged.reclaim.reason, 'need >= 5 valid points, have 1');
  assert.equal(merged.absorption.signal, 'UNKNOWN', 'a book must never manufacture a directional call');
  assert.equal(merged.absorption.status, 'INSUFFICIENT_HISTORY');
  assert.equal(merged.absorption.reason, 'need >= 8 valid points, have 1');
  assert.equal(merged.absorption.confidence, 'low');
  // Book context is still attached for display, without changing the verdict.
  assert.equal(merged.absorption.orderbookUsed, true);
});

test('an unusable or missing book preserves the server history-only result and its honest diagnostics', () => {
  for (const bad of [null, undefined, {}, { bids: [], asks: [] }, 'nope']) {
    const merged = combinePriceHistorySignalsWithOrderbook({ signals: serverResponse(), orderbook: bad });
    assert.equal(merged.orderbookUsed, false);
    assert.equal(merged.orderbookSource, null);
    assert.equal(merged.orderbookReason, 'ORDERBOOK_UNAVAILABLE');
    assert.equal(merged.orderbookBridgeReason, 'ORDERBOOK_HTTP_502');
    assert.equal(merged.orderbookFallbackReason, 'ORDERBOOK_BINANCE_HTTP_451');
    assert.equal(merged.absorption.signal, 'BULLISH_ABSORPTION');
  }
});

test('an errored or malformed signals response degrades safely without throwing', () => {
  for (const bad of [null, undefined, {}, { ok: false, reason: 'DB_UNAVAILABLE' }, 'nope']) {
    const merged = combinePriceHistorySignalsWithOrderbook({ signals: bad, orderbook: BID_BOOK });
    assert.equal(merged.ok, false);
    assert.equal(merged.orderbookUsed, false);
    assert.equal(merged.orderbookReason, 'INVALID_SIGNALS_RESPONSE');
  }
  assert.doesNotThrow(() => combinePriceHistorySignalsWithOrderbook());
  assert.doesNotThrow(() => combinePriceHistorySignalsWithOrderbook({}));
});

test('the merge never mutates the server response it was given', () => {
  const server = serverResponse();
  const snapshot = JSON.parse(JSON.stringify(server));
  combinePriceHistorySignalsWithOrderbook({ signals: server, orderbook: BID_BOOK });
  assert.deepEqual(server, snapshot);
});

test('a server that already supplied a book is reported as-is, not double-applied', () => {
  const server = serverResponse({ orderbookUsed: true, orderbookSource: 'api_orderbook', serverOrderbookAvailable: true, orderbookMode: 'server' });
  const merged = combinePriceHistorySignalsWithOrderbook({ signals: server, orderbook: ASK_BOOK });
  assert.equal(merged.orderbookSource, 'api_orderbook');
  assert.equal(merged.orderbookUsed, true);
});

test('the merged result never carries a token, header, cookie, or raw depth dump', () => {
  const merged = combinePriceHistorySignalsWithOrderbook({
    signals: serverResponse(),
    orderbook: { ...BID_BOOK, top5_bids: [[100, 1]], top5_asks: [[100.1, 1]], walls: { bids: [], asks: [] } },
  });
  const raw = JSON.stringify(merged).toLowerCase();
  for (const forbidden of ['token', 'authorization', 'bearer', 'cookie', 'secret', 'password', 'top5_bids', 'top5_asks', 'walls']) {
    assert.equal(raw.includes(forbidden), false, forbidden);
  }
});

// ── Anti-drift: this module deliberately duplicates the server helper's
// grading rules (netlify/functions/_price-history-signals.mjs cannot be
// imported by the browser). These assertions fail if the two diverge.
test('DRIFT GUARD: browser grading matches the server helper across bid/ask/neutral books', () => {
  const prices = [110, 108, 106, 104, 104, 104.2, 104.4, 104.6];
  const volumes = [100, 100, 100, 100, 130, 130, 130, 130];
  const points = prices.map((price_usd, i) => ({
    symbol: 'BTC',
    sampled_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    price_usd,
    volume_24h_usd: volumes[i],
  }));
  const options = { recentWindow: 4 };

  for (const book of [BID_BOOK, ASK_BOOK, FLAT_BOOK]) {
    // What the server WOULD have produced if it could reach the book.
    const serverWithBook = analyzeAbsorptionFromPointsAndOrderbook({ symbol: 'BTC', points, orderbook: book, options });
    // What we actually produce: server history-only result + browser book.
    const serverHistoryOnly = analyzeAbsorptionFromPointsAndOrderbook({ symbol: 'BTC', points, options });
    const merged = combinePriceHistorySignalsWithOrderbook({
      signals: serverResponse({ absorption: serverHistoryOnly, points: points.length }),
      orderbook: book,
    });

    assert.equal(merged.absorption.signal, serverWithBook.signal, 'signal must match the server');
    assert.equal(merged.absorption.confidence, serverWithBook.confidence, 'confidence grading must match the server');
    assert.equal(merged.absorption.orderbookSupport, serverWithBook.orderbookSupport, 'support must match the server');
    assert.equal(merged.absorption.bidAskImbalance, serverWithBook.bidAskImbalance, 'imbalance must match the server');
    assert.equal(merged.absorption.spreadPct, serverWithBook.spreadPct, 'spread must match the server');
  }
});

test('DRIFT GUARD: gradeAbsorptionConfidence matches the server rules for alignment and spikes', () => {
  assert.equal(gradeAbsorptionConfidence({ signal: 'BULLISH_ABSORPTION', orderbookSupport: 'ask', volumeRatio: 5 }), 'low', 'contradiction pins to low');
  assert.equal(gradeAbsorptionConfidence({ signal: 'BEARISH_ABSORPTION', orderbookSupport: 'bid', volumeRatio: 5 }), 'low', 'contradiction pins to low');
  assert.equal(gradeAbsorptionConfidence({ signal: 'BULLISH_ABSORPTION', orderbookSupport: 'neutral', volumeRatio: 1.2 }), 'low');
  assert.equal(gradeAbsorptionConfidence({ signal: 'BULLISH_ABSORPTION', orderbookSupport: 'bid', volumeRatio: 1.2 }), 'medium');
  assert.equal(gradeAbsorptionConfidence({ signal: 'BULLISH_ABSORPTION', orderbookSupport: 'bid', volumeRatio: 99 }), 'high');
  assert.equal(gradeAbsorptionConfidence({ signal: 'BULLISH_ABSORPTION', orderbookSupport: 'neutral', volumeRatio: 99 }), 'medium');
});
