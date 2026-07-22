// Browser-safe helper that merges the server's history-only price-history
// signal response with a LIVE order book the browser fetched itself.
//
// WHY THIS EXISTS
//   Netlify's Node runtime cannot reach a Binance book: the Node->Edge
//   bridge answers ORDERBOOK_HTTP_502 and a direct public-depth call answers
//   ORDERBOOK_BINANCE_HTTP_451 (Binance geo-blocks the cloud egress IP). The
//   very same /api/orderbook route succeeds from the BROWSER, because the
//   browser egresses from the user's own network. So the split is:
//     • Node  -> price history + reclaim + history-only absorption (DB work)
//     • Browser -> GET /api/orderbook, then merge here for book context
//   That is the whole architecture. Do not reintroduce Node->Binance calls.
//
// SCOPE / SAFETY
//   - Pure functions only: no fetch, no DOM, no storage, no globals, no env.
//     The caller performs the authenticated /api/orderbook GET; this module
//     never sees a token, header, or cookie and never returns one.
//   - Never throws: malformed input degrades to orderbookUsed:false, and the
//     server's own history-only result is passed through untouched.
//   - Never fabricates a book and never invents a directional signal. The
//     order book only supplies context and adjusts CONFIDENCE — it can never
//     flip UNKNOWN into a directional call, matching the server helper.
//   - Not a trading signal. Nothing here is imported by RADAR, ENTRY_READY,
//     alerts, or the bot.
//
// DELIBERATE DUPLICATION
//   The grading/parsing rules below mirror
//   netlify/functions/_price-history-signals.mjs. That module is pure and
//   would be safe to run in a browser, but it lives in netlify/functions/
//   which is never served to the client, so it cannot be imported here.
//   tests/price-history-orderbook-browser.test.mjs cross-checks this module
//   against the server helper over a matrix of inputs so the two cannot
//   silently drift apart.
//
//   WIRED INTO RADAR: terminal.js is a classic <script>, so it cannot
//   `import` this ESM module directly. It is loaded as its own
//   <script type="module"> in index.html and exposes its pure functions on
//   window.__priceHistoryOrderbook — the same global-exposure pattern the
//   admin diagnostics panel module already uses for its own window global
//   (see that module's own file for the mirrored convention). terminal.js's
//   _radarPhEnrichWithBrowserOrderbook() is the only caller.

const CONFIDENCE = ['low', 'medium', 'high'];

// Mirrors _price-history-signals.mjs: ±0.15 imbalance is the bid/ask support
// threshold, and 1.15 is the default volume-spike ratio used for grading.
const SUPPORT_THRESHOLD = 0.15;
const DEFAULT_VOLUME_SPIKE_RATIO = 1.15;

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, dp = 4) {
  return Number.isFinite(v) ? Number(v.toFixed(dp)) : null;
}

/**
 * Normalizes an order book into { imbalance, spreadPct, bidQty, askQty }.
 * Accepts either the summarized book from /api/orderbook
 * ({ imbalance, spread_bps, best_bid, best_ask, ... }) or a raw depth
 * payload ({ bids: [[price, qty]], asks: [[price, qty]] }).
 * Returns null when the shape is unusable — never a fabricated book.
 */
export function summarizeBrowserOrderbook(orderbook) {
  if (!orderbook || typeof orderbook !== 'object') return null;

  const imb = toNum(orderbook.imbalance);
  const bb = toNum(orderbook.best_bid);
  const ba = toNum(orderbook.best_ask);
  if (imb !== null && bb !== null && ba !== null && bb > 0 && ba > 0) {
    const spreadBps = toNum(orderbook.spread_bps);
    return {
      imbalance: imb,
      spreadPct: spreadBps !== null ? spreadBps / 100 : round(((ba - bb) / ((ba + bb) / 2)) * 100, 4),
      bidQty: toNum(orderbook.cumulative_bid_qty),
      askQty: toNum(orderbook.cumulative_ask_qty),
    };
  }

  if (Array.isArray(orderbook.bids) && Array.isArray(orderbook.asks)) {
    const side = (rows) => rows
      .map((r) => (Array.isArray(r) ? [toNum(r[0]), toNum(r[1])] : null))
      .filter((r) => r && r[0] !== null && r[1] !== null && r[0] > 0 && r[1] >= 0);
    const bids = side(orderbook.bids);
    const asks = side(orderbook.asks);
    if (!bids.length || !asks.length) return null;
    const bidQty = bids.reduce((s, [, q]) => s + q, 0);
    const askQty = asks.reduce((s, [, q]) => s + q, 0);
    const total = bidQty + askQty;
    const bestBid = bids[0][0];
    const bestAsk = asks[0][0];
    const mid = (bestBid + bestAsk) / 2;
    return {
      imbalance: total > 0 ? (bidQty - askQty) / total : 0,
      spreadPct: mid > 0 ? round(((bestAsk - bestBid) / mid) * 100, 4) : null,
      bidQty: round(bidQty, 4),
      askQty: round(askQty, 4),
    };
  }

  return null;
}

/** 'bid' | 'ask' | 'neutral' — mirrors the server helper's thresholds. */
export function orderbookSupportFrom(imbalance) {
  if (imbalance >= SUPPORT_THRESHOLD) return 'bid';
  if (imbalance <= -SUPPORT_THRESHOLD) return 'ask';
  return 'neutral';
}

/**
 * Confidence grading, mirroring _price-history-signals.mjs: a book that
 * contradicts the read pins confidence to low; an aligned book and a strong
 * spike each add one step.
 */
export function gradeAbsorptionConfidence({ signal, orderbookSupport, volumeRatio, volumeSpikeRatio } = {}) {
  const spike = toNum(volumeSpikeRatio) ?? DEFAULT_VOLUME_SPIKE_RATIO;
  const ratio = toNum(volumeRatio);

  const aligned = (signal === 'BULLISH_ABSORPTION' && orderbookSupport === 'bid')
    || (signal === 'BEARISH_ABSORPTION' && orderbookSupport === 'ask');
  const contradicted = (signal === 'BULLISH_ABSORPTION' && orderbookSupport === 'ask')
    || (signal === 'BEARISH_ABSORPTION' && orderbookSupport === 'bid');

  if (contradicted) return 'low';
  let steps = 0;
  if (aligned) steps += 1;
  if (ratio !== null && ratio >= spike * 1.3) steps += 1;
  return CONFIDENCE[Math.min(steps, 2)];
}

/**
 * Merges a server signal response with a browser-fetched order book.
 *
 * @param signals   the parsed JSON from /api/admin-price-history-signals
 * @param orderbook the `orderbook` object from /api/orderbook, OR the whole
 *                  response body (the `orderbook` property is unwrapped).
 *
 * Returns a NEW object; the input is never mutated. On any unusable input
 * the server's own history-only result is preserved verbatim with
 * orderbookUsed:false — the caller can always render something honest.
 */
export function combinePriceHistorySignalsWithOrderbook({ signals, orderbook, options } = {}) {
  const base = signals && typeof signals === 'object' ? signals : null;
  if (!base || base.ok !== true) {
    return {
      ok: false,
      orderbookUsed: false,
      orderbookSource: null,
      orderbookReason: 'INVALID_SIGNALS_RESPONSE',
      reclaim: base && base.reclaim ? base.reclaim : null,
      absorption: base && base.absorption ? base.absorption : null,
      points: base && Number.isFinite(base.points) ? base.points : 0,
      symbol: base && base.symbol ? base.symbol : null,
    };
  }

  // The server already used a book (only possible if a future runtime can
  // reach one) — nothing to add, report it as-is rather than double-applying.
  if (base.orderbookUsed === true) {
    return {
      ...base,
      orderbookSource: base.orderbookSource || 'server',
      orderbookReason: 'OK',
    };
  }

  const rawBook = orderbook && typeof orderbook === 'object' && orderbook.orderbook
    ? orderbook.orderbook
    : orderbook;
  const book = summarizeBrowserOrderbook(rawBook);

  if (!book) {
    // No usable browser book either — keep the server's honest diagnostics
    // instead of inventing context.
    return {
      ...base,
      orderbookUsed: false,
      orderbookSource: null,
      orderbookReason: base.orderbookReason || 'ORDERBOOK_UNAVAILABLE',
    };
  }

  const support = orderbookSupportFrom(book.imbalance);
  const serverAbsorption = base.absorption && typeof base.absorption === 'object' ? base.absorption : null;

  // Attach book context. The signal itself is history-derived and is NEVER
  // changed here — only confidence is re-graded, exactly as the server would
  // have done had it been able to fetch the book.
  const absorption = serverAbsorption
    ? {
      ...serverAbsorption,
      orderbookUsed: true,
      orderbookSupport: support,
      bidAskImbalance: round(book.imbalance, 4),
      spreadPct: round(book.spreadPct, 4),
      confidence: serverAbsorption.signal === 'BULLISH_ABSORPTION' || serverAbsorption.signal === 'BEARISH_ABSORPTION'
        ? gradeAbsorptionConfidence({
          signal: serverAbsorption.signal,
          orderbookSupport: support,
          volumeRatio: serverAbsorption.volumeRatio,
          volumeSpikeRatio: options && options.volumeSpikeRatio,
        })
        : serverAbsorption.confidence,
    }
    : null;

  return {
    ...base,
    orderbookUsed: true,
    orderbookSource: 'browser_api_orderbook',
    orderbookReason: 'OK',
    reclaim: base.reclaim,
    absorption,
  };
}

if (typeof window !== 'undefined') {
  window.__priceHistoryOrderbook = {
    summarizeBrowserOrderbook,
    orderbookSupportFrom,
    gradeAbsorptionConfidence,
    combine: combinePriceHistorySignalsWithOrderbook,
  };
}
