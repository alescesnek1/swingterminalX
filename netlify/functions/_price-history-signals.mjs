// Pure reclaim / absorption analysis over stored market_price_points rows
// plus an optional live orderbook snapshot (the summarized shape produced
// by apps/edge/netlify/edge-functions/lib/binance.js summarizeOrderbook,
// or a raw { bids, asks } depth payload).
//
// SCOPE / SAFETY
//   - Pure functions only: no DB, no network, no env reads, no side effects.
//   - This is a terminal heuristic layer, NOT a trading signal. Nothing here
//     is imported by RADAR scoring, ENTRY_READY, alerts, or the bot — wiring
//     into those is a separate, later, reviewed phase.
//   - Missing/invalid data degrades to 'UNKNOWN' (never a bearish/SELL
//     default) per the repo's fail-closed observability rules.
//   - Orderbook input is optional; when absent or malformed the analysis
//     still runs history-only with lower confidence and orderbookUsed:false.
//     Orderbook data is never fabricated.

const CONFIDENCE = ['low', 'medium', 'high'];

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toTime(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'string' || typeof v === 'number') {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function boundInt(v, def, min, max) {
  const n = toNum(v);
  if (n === null) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function round(v, dp = 4) {
  return Number.isFinite(v) ? Number(v.toFixed(dp)) : null;
}

// Normalizes DB rows (pg numeric columns arrive as strings) into
// { t, price, volume } ascending by time, dropping invalid rows.
function normalizePoints(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const p of points) {
    if (!p || typeof p !== 'object') continue;
    const t = toTime(p.sampled_at ?? p.sampledAt);
    const price = toNum(p.price_usd ?? p.priceUsd);
    if (t === null || price === null || price <= 0) continue;
    out.push({
      t,
      price,
      volume: toNum(p.volume_24h_usd ?? p.volume24hUsd),
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Reclaim detection over stored price points.
 *
 * Level = the local high of the lookback window BEFORE the confirmation
 * segment (the last `confirmations` points). A bullish reclaim requires the
 * entire confirmation segment to hold above that level; a break that falls
 * back below it is a failed reclaim. Insufficient/invalid history returns
 * signal 'UNKNOWN' — never a directional guess.
 */
export function analyzeReclaimFromPoints({ symbol, points, options } = {}) {
  const sym = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  const opts = options && typeof options === 'object' ? options : {};
  const lookback = boundInt(opts.lookback, 20, 5, 200);
  const confirmations = boundInt(opts.confirmations, 2, 1, 10);

  const base = {
    ok: true,
    symbol: sym || null,
    signal: 'UNKNOWN',
    confidence: 'low',
    level: null,
    latestPrice: null,
    invalidBelow: null,
    pointsUsed: 0,
    reason: '',
  };

  const series = normalizePoints(points);
  const minPoints = confirmations + 3;
  if (series.length < minPoints) {
    return { ...base, status: 'INSUFFICIENT_HISTORY', reason: `need >= ${minPoints} valid points, have ${series.length}` };
  }

  const confirmSeg = series.slice(-confirmations);
  const priorSeg = series.slice(0, series.length - confirmations).slice(-lookback);
  if (priorSeg.length < 3) {
    return { ...base, status: 'INSUFFICIENT_HISTORY', pointsUsed: series.length, reason: 'prior window too small to define a level' };
  }

  const level = Math.max(...priorSeg.map((p) => p.price));
  const latest = series[series.length - 1].price;
  const maxRecent = Math.max(...confirmSeg.map((p) => p.price));
  const allAbove = confirmSeg.every((p) => p.price > level);
  const distancePct = level > 0 ? ((latest - level) / level) * 100 : 0;

  const result = {
    ...base,
    status: 'OK',
    level: round(level, 8),
    latestPrice: round(latest, 8),
    invalidBelow: round(level, 8),
    pointsUsed: priorSeg.length + confirmSeg.length,
  };

  if (allAbove) {
    let conf = 'low';
    if (confirmations >= 3 && distancePct >= 1) conf = 'high';
    else if (confirmations >= 2 && distancePct >= 0.3) conf = 'medium';
    return {
      ...result,
      signal: 'BULLISH_RECLAIM',
      confidence: conf,
      reason: `held above ${round(level, 8)} for ${confirmations} consecutive points (+${round(distancePct, 2)}%)`,
    };
  }

  if (maxRecent > level && latest <= level) {
    return {
      ...result,
      signal: 'FAILED_RECLAIM',
      confidence: 'medium',
      reason: `broke above ${round(level, 8)} but fell back below it`,
    };
  }

  if (latest > level) {
    return {
      ...result,
      signal: 'NO_RECLAIM',
      confidence: 'low',
      reason: 'fresh break above level not yet confirmed by enough points',
    };
  }

  return { ...result, signal: 'NO_RECLAIM', confidence: 'low', reason: 'price below prior local high' };
}

// Accepts either the summarized book from lib/binance.js summarizeOrderbook
// ({ imbalance, spread_bps, best_bid, best_ask, ... }) or a raw depth
// payload ({ bids: [[price, qty], ...], asks: [[price, qty], ...] }).
// Returns { imbalance, spreadPct, bidQty, askQty } or null when the shape
// is unusable — never a fabricated book.
function parseOrderbook(orderbook) {
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

/**
 * First absorption proxy: rolling volume vs. baseline + price behavior in
 * the recent window + (optional) live orderbook bid/ask balance.
 *
 * Heuristic, honestly labeled: a volume spike into a prior downtrend where
 * price stops falling (with bid-side book support) reads as bullish
 * absorption; a spike into a prior uptrend where price stalls (with
 * ask-side pressure) reads as bearish absorption. Anything ambiguous is
 * NO_ABSORPTION / UNKNOWN — never a fabricated conviction.
 */
export function analyzeAbsorptionFromPointsAndOrderbook({ symbol, points, orderbook, options } = {}) {
  const sym = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  const opts = options && typeof options === 'object' ? options : {};
  const recentWindow = boundInt(opts.recentWindow, 5, 2, 50);
  const volumeSpikeRatio = Math.min(Math.max(toNum(opts.volumeSpikeRatio) ?? 1.15, 1.01), 10);
  const holdDropPct = -Math.abs(toNum(opts.holdDropPct) ?? 1);
  const dumpPct = -Math.abs(toNum(opts.dumpPct) ?? 2);
  const stallRisePct = Math.abs(toNum(opts.stallRisePct) ?? 0.5);
  const priorMovePct = Math.abs(toNum(opts.priorMovePct) ?? 1);

  const book = parseOrderbook(orderbook);
  const orderbookUsed = book !== null;
  const orderbookSupport = !orderbookUsed
    ? null
    : (book.imbalance >= 0.15 ? 'bid' : (book.imbalance <= -0.15 ? 'ask' : 'neutral'));

  const base = {
    ok: true,
    symbol: sym || null,
    signal: 'UNKNOWN',
    confidence: 'low',
    volumeRatio: null,
    priceChangeAfterVolume: null,
    orderbookUsed,
    orderbookSupport,
    bidAskImbalance: orderbookUsed ? round(book.imbalance, 4) : null,
    spreadPct: orderbookUsed ? round(book.spreadPct, 4) : null,
    pointsUsed: 0,
    reason: '',
  };

  const series = normalizePoints(points);
  const minPoints = recentWindow + 3;
  if (series.length < minPoints) {
    return { ...base, status: 'INSUFFICIENT_HISTORY', reason: `need >= ${minPoints} valid points, have ${series.length}` };
  }

  const recentSeg = series.slice(-recentWindow);
  const baselineSeg = series.slice(0, series.length - recentWindow);

  const vols = (seg) => seg.map((p) => p.volume).filter((v) => v !== null && v > 0);
  const recentVols = vols(recentSeg);
  const baselineVols = vols(baselineSeg);
  if (recentVols.length < 2 || baselineVols.length < 2) {
    return { ...base, status: 'OK', pointsUsed: series.length, reason: 'not enough volume data for an absorption read' };
  }

  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const baseAvg = avg(baselineVols);
  const volumeRatio = baseAvg > 0 ? avg(recentVols) / baseAvg : null;

  const recentStart = recentSeg[0].price;
  const latest = recentSeg[recentSeg.length - 1].price;
  const priceChangeAfterVolume = recentStart > 0 ? ((latest - recentStart) / recentStart) * 100 : null;
  const baselineStart = baselineSeg[0].price;
  const priorTrendPct = baselineStart > 0 ? ((recentStart - baselineStart) / baselineStart) * 100 : 0;

  const result = {
    ...base,
    status: 'OK',
    volumeRatio: round(volumeRatio, 3),
    priceChangeAfterVolume: round(priceChangeAfterVolume, 3),
    pointsUsed: series.length,
  };

  if (volumeRatio === null || priceChangeAfterVolume === null) {
    return { ...result, reason: 'volume/price baselines unusable' };
  }

  // Confidence: aligned live book and a strong spike each add a step;
  // a book that actively contradicts the read pins confidence to low.
  const grade = (signal) => {
    const aligned = (signal === 'BULLISH_ABSORPTION' && orderbookSupport === 'bid')
      || (signal === 'BEARISH_ABSORPTION' && orderbookSupport === 'ask');
    const contradicted = (signal === 'BULLISH_ABSORPTION' && orderbookSupport === 'ask')
      || (signal === 'BEARISH_ABSORPTION' && orderbookSupport === 'bid');
    if (contradicted) return 'low';
    let steps = 0;
    if (aligned) steps += 1;
    if (volumeRatio >= volumeSpikeRatio * 1.3) steps += 1;
    return CONFIDENCE[Math.min(steps, 2)];
  };

  if (volumeRatio < volumeSpikeRatio) {
    return { ...result, signal: 'NO_ABSORPTION', reason: `no volume spike (ratio ${round(volumeRatio, 3)} < ${volumeSpikeRatio})` };
  }

  if (priceChangeAfterVolume <= dumpPct) {
    return { ...result, signal: 'NO_ABSORPTION', reason: 'volume spiked but price continued falling — selling not absorbed' };
  }

  if (priorTrendPct <= -priorMovePct && priceChangeAfterVolume >= holdDropPct) {
    const conf = grade('BULLISH_ABSORPTION');
    return {
      ...result,
      signal: 'BULLISH_ABSORPTION',
      confidence: conf,
      reason: `elevated volume into a prior downtrend while price held${orderbookSupport === 'bid' ? ' with live bid-side book support' : (orderbookUsed ? '' : ' (no live book — history-only proxy)')}`,
    };
  }

  if (priorTrendPct >= priorMovePct && priceChangeAfterVolume <= stallRisePct) {
    const conf = grade('BEARISH_ABSORPTION');
    return {
      ...result,
      signal: 'BEARISH_ABSORPTION',
      confidence: conf,
      reason: `elevated volume into a prior uptrend while price stalled${orderbookSupport === 'ask' ? ' with live ask-side book pressure' : (orderbookUsed ? '' : ' (no live book — history-only proxy)')}`,
    };
  }

  return { ...result, signal: 'NO_ABSORPTION', reason: 'volume elevated but no clear absorption pattern' };
}
