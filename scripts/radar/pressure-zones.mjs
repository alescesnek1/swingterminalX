/**
 * Pressure Zones — derived PROXY only (pure math).
 *
 * Derives candidate "pressure" price levels from CLOSED candles alone:
 *   • confirmed swing highs / lows (structural pivots), and
 *   • high-volume traded price nodes.
 *
 * IMPORTANT — this is a PROXY built from public OHLCV. It is NOT liquidation
 * data and NOT order-book data. It performs no network I/O, imports nothing, and
 * never touches any trading gate, score, or alert path. Its only job is to
 * suggest where prior structure and traded volume clustered, for manual context.
 * Every result carries `proxy: true` and an explicit disclaimer.
 *
 * Fail-closed: returns `null` when there are too few closed candles. It never
 * fabricates a level and never emits a zone from the still-forming candle
 * (excluded by default, matching computeStructuralReclaimLevels).
 */

// Local, dependency-free kline normaliser (mirrors structural-reclaim.mjs). Kept
// inline on purpose so this module imports nothing.
function normalizeKlines(klines) {
  if (!Array.isArray(klines)) return [];
  const out = [];
  for (const k of klines) {
    if (!k) continue;
    let open, high, low, close, volume;
    if (Array.isArray(k)) {
      // Binance array: [openTime, open, high, low, close, volume, ...]
      open = parseFloat(k[1]);
      high = parseFloat(k[2]);
      low = parseFloat(k[3]);
      close = parseFloat(k[4]);
      volume = parseFloat(k[5]);
    } else {
      open = parseFloat(k.open);
      high = parseFloat(k.high);
      low = parseFloat(k.low);
      close = parseFloat(k.close);
      volume = parseFloat(k.volume);
    }
    if (Number.isFinite(open) && Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close)) {
      out.push({ open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
    }
  }
  return out;
}

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
}

function round(v, digits) {
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// Side of a level relative to the current reference price. A level below price
// reads as support, above as resistance, at price as a pivot.
function sideFor(price, reference, epsPct) {
  if (!(reference > 0)) return 'pivot';
  const diffPct = ((price - reference) / reference) * 100;
  if (diffPct <= -epsPct) return 'support';
  if (diffPct >= epsPct) return 'resistance';
  return 'pivot';
}

/**
 * @param {Array} rawKlines  Binance-array or {open,high,low,close,volume} candles.
 * @param {object} [opts]
 *   includeLastCandle {boolean=false}  include the still-forming candle
 *   minCandles        {number=30}      minimum CLOSED candles required
 *   swingWindow       {number=3}       bars each side for a confirmed pivot
 *   volumeBins        {number=20}      price bins for volume-node detection
 *   volumeNodeRatio   {number=1.8}     bin volume ≥ ratio × mean → node
 *   maxVolumeNodes    {number=3}       cap on emitted volume nodes
 *   maxZones          {number=10}      cap on emitted zones
 *   mergePct          {number=0.25}    merge levels within this % of each other
 *   sidePct           {number=0.05}    support/resistance vs pivot threshold
 *   timeframe         {string='1h'}
 * @returns {null | { proxy:true, label, basis, disclaimer, timeframe,
 *                    referencePrice, candlesUsed, zones, counts }}
 */
export function computePressureZones(rawKlines, opts = {}) {
  const includeLastCandle = opts.includeLastCandle === true;
  const minCandles = Number.isFinite(opts.minCandles) ? opts.minCandles : 30;
  const swingWindow = Number.isFinite(opts.swingWindow) ? opts.swingWindow : 3;
  const volumeBins = Number.isFinite(opts.volumeBins) ? Math.max(4, Math.trunc(opts.volumeBins)) : 20;
  const volumeNodeRatio = Number.isFinite(opts.volumeNodeRatio) ? opts.volumeNodeRatio : 1.8;
  const maxVolumeNodes = Number.isFinite(opts.maxVolumeNodes) ? Math.max(0, Math.trunc(opts.maxVolumeNodes)) : 3;
  const maxZones = Number.isFinite(opts.maxZones) ? Math.max(1, Math.trunc(opts.maxZones)) : 10;
  const mergePct = Number.isFinite(opts.mergePct) ? opts.mergePct : 0.25;
  const sidePct = Number.isFinite(opts.sidePct) ? opts.sidePct : 0.05;
  const timeframe = typeof opts.timeframe === 'string' && opts.timeframe ? opts.timeframe : '1h';

  const klines = normalizeKlines(rawKlines);
  if (!includeLastCandle && klines.length > 0) klines.pop(); // drop still-forming candle
  if (klines.length < minCandles) return null;

  const referencePrice = klines[klines.length - 1].close;
  if (!(referencePrice > 0)) return null;

  const volumes = klines.map((k) => k.volume).filter((v) => v > 0);
  const maxVol = volumes.length ? Math.max(...volumes) : 0;

  // ── 1. Confirmed swing highs / lows (structural pivots) ──
  const raw = []; // { price, kind: 'swing-high'|'swing-low'|'volume-node', weight }
  for (let i = swingWindow; i < klines.length - swingWindow; i++) {
    const hi = klines[i].high;
    const lo = klines[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= swingWindow; j++) {
      if (klines[i - j].high >= hi || klines[i + j].high >= hi) isHigh = false;
      if (klines[i - j].low <= lo || klines[i + j].low <= lo) isLow = false;
      if (!isHigh && !isLow) break;
    }
    // recency weight: more recent pivots are more relevant
    const recency = i / (klines.length - 1);
    if (isHigh) raw.push({ price: hi, kind: 'swing-high', weight: 55 + Math.round(recency * 20) });
    if (isLow) raw.push({ price: lo, kind: 'swing-low', weight: 55 + Math.round(recency * 20) });
  }

  // ── 2. High-volume traded price nodes ──
  if (maxVolumeNodes > 0 && maxVol > 0) {
    let priceMin = Infinity;
    let priceMax = -Infinity;
    for (const k of klines) {
      if (k.low < priceMin) priceMin = k.low;
      if (k.high > priceMax) priceMax = k.high;
    }
    const span = priceMax - priceMin;
    if (span > 0) {
      const binSize = span / volumeBins;
      const binVol = new Array(volumeBins).fill(0);
      for (const k of klines) {
        const typical = (k.high + k.low + k.close) / 3;
        let bin = Math.floor((typical - priceMin) / binSize);
        if (bin < 0) bin = 0;
        if (bin >= volumeBins) bin = volumeBins - 1;
        binVol[bin] += k.volume;
      }
      const totalVol = binVol.reduce((s, v) => s + v, 0);
      const meanVol = totalVol / volumeBins;
      const nodes = [];
      for (let b = 0; b < volumeBins; b++) {
        if (meanVol > 0 && binVol[b] >= meanVol * volumeNodeRatio) {
          const center = priceMin + (b + 0.5) * binSize;
          const strength = clamp(45 + Math.round((binVol[b] / (maxVol * swingWindow + 1)) * 30));
          nodes.push({ price: center, kind: 'volume-node', weight: strength, vol: binVol[b] });
        }
      }
      nodes.sort((a, b) => b.vol - a.vol);
      for (const n of nodes.slice(0, maxVolumeNodes)) raw.push({ price: n.price, kind: n.kind, weight: n.weight });
    }
  }

  if (!raw.length) {
    return {
      proxy: true,
      label: 'PRESSURE ZONES',
      basis: 'derived proxy — not liquidation data',
      disclaimer: 'Derived from closed-candle swing highs/lows and traded-volume nodes (public OHLCV). NOT liquidation data, NOT order-book data.',
      timeframe,
      referencePrice: round(referencePrice, 8),
      candlesUsed: klines.length,
      zones: [],
      counts: { support: 0, resistance: 0, volumeNode: 0 },
    };
  }

  // ── 3. Merge nearby levels, combining basis + strength ──
  raw.sort((a, b) => a.price - b.price);
  const merged = [];
  for (const item of raw) {
    const last = merged[merged.length - 1];
    if (last && Math.abs((item.price - last.price) / last.price) * 100 <= mergePct) {
      last.priceSum += item.price;
      last.count += 1;
      last.price = last.priceSum / last.count;
      if (!last.basis.includes(item.kind)) last.basis.push(item.kind);
      last.strength = clamp(Math.max(last.strength, item.weight) + 6); // confluence bonus
    } else {
      merged.push({ price: item.price, priceSum: item.price, count: 1, basis: [item.kind], strength: clamp(item.weight) });
    }
  }

  // ── 4. Shape, classify side, sort by proximity to reference, cap ──
  const zones = merged
    .map((m) => ({
      price: round(m.price, 8),
      side: sideFor(m.price, referencePrice, sidePct),
      basis: m.basis.slice(),
      strength: Math.round(m.strength),
      distancePct: round(((m.price - referencePrice) / referencePrice) * 100, 2),
      proxy: true,
    }))
    .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
    .slice(0, maxZones);

  const counts = { support: 0, resistance: 0, volumeNode: 0 };
  for (const z of zones) {
    if (z.side === 'support') counts.support += 1;
    else if (z.side === 'resistance') counts.resistance += 1;
    if (z.basis.includes('volume-node')) counts.volumeNode += 1;
  }

  return {
    proxy: true,
    label: 'PRESSURE ZONES',
    basis: 'derived proxy — not liquidation data',
    disclaimer: 'Derived from closed-candle swing highs/lows and traded-volume nodes (public OHLCV). NOT liquidation data, NOT order-book data.',
    timeframe,
    referencePrice: round(referencePrice, 8),
    candlesUsed: klines.length,
    zones,
    counts,
  };
}
