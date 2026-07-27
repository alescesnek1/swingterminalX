const DEFAULT_TIMEFRAME = '1h';
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_LIMIT = 120;
const MAX_TOP_N = 50;
const TIMEFRAME_MS = {
  '1m': 60 * 1000,
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

function clampPositiveInteger(value, fallback, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function normalizeTimeframe(value) {
  const timeframe = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_TIMEFRAME;
  return Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, timeframe) ? timeframe : DEFAULT_TIMEFRAME;
}

function normalizeUpdatedAtMs(input) {
  if (!input || typeof input !== 'object') return null;
  for (const key of ['updatedAtMs', 'receivedAtMs', 'generatedAtMs']) {
    const n = Number(input[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  for (const key of ['updatedAt', 'receivedAt', 'generatedAt']) {
    if (typeof input[key] !== 'string') continue;
    const t = Date.parse(input[key]);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function normalizeSymbol(raw) {
  const symbol = String(raw ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{1,24}$/.test(symbol) ? symbol : null;
}

// Same venue problem as the rolling microstructure snapshot: spot and futures candles
// for one symbol are different series, and keying by symbol alone let one replace the
// other — so a spot candidate's reclaim could be computed from futures candles.
// Keys may be venue-qualified ("spot:BTCUSDT") or bare ("BTCUSDT"); bare stays
// supported because the existing producers emit it.
const KLINES_VENUES = new Set(['spot', 'futures']);
function parseKlinesKey(raw) {
  const text = String(raw ?? '').trim();
  const separator = text.indexOf(':');
  if (separator < 0) { const symbol = normalizeSymbol(text); return symbol ? { key: symbol, symbol, market: null } : null; }
  const market = text.slice(0, separator).trim().toLowerCase();
  const symbol = normalizeSymbol(text.slice(separator + 1));
  if (!symbol || !KLINES_VENUES.has(market)) return null;
  return { key: `${market}:${symbol}`, symbol, market };
}
export function klinesKeyFor(market, symbol) {
  const safeSymbol = normalizeSymbol(symbol);
  if (!safeSymbol) return null;
  const venue = String(market ?? '').trim().toLowerCase();
  return KLINES_VENUES.has(venue) ? `${venue}:${safeSymbol}` : safeSymbol;
}
// Refuses to answer with another venue's series; null → UNKNOWN downstream.
function selectKlinesKey(normalized, symbol, market) {
  const safeSymbol = normalizeSymbol(symbol);
  if (!safeSymbol) return null;
  const requested = String(market ?? '').trim().toLowerCase();
  const venue = KLINES_VENUES.has(requested) ? requested : null;
  if (venue) {
    const exact = `${venue}:${safeSymbol}`;
    if (normalized.data[exact]) return exact;
    return normalized.data[safeSymbol] ? safeSymbol : null;
  }
  if (normalized.data[safeSymbol]) return safeSymbol;
  const matches = Object.keys(normalized.data).filter((key) => key.endsWith(`:${safeSymbol}`));
  return matches.length === 1 ? matches[0] : null;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCandle(raw) {
  if (!raw) return null;

  const source = Array.isArray(raw)
    ? {
        openTime: raw[0],
        open: raw[1],
        high: raw[2],
        low: raw[3],
        close: raw[4],
        volume: raw[5],
        closeTime: raw[6],
      }
    : raw;

  if (typeof source !== 'object') return null;

  const candle = {
    openTime: toFiniteNumber(source.openTime),
    open: toFiniteNumber(source.open),
    high: toFiniteNumber(source.high),
    low: toFiniteNumber(source.low),
    close: toFiniteNumber(source.close),
    volume: toFiniteNumber(source.volume),
    closeTime: toFiniteNumber(source.closeTime),
  };

  for (const value of Object.values(candle)) {
    if (!Number.isFinite(value)) return null;
  }
  if (candle.closeTime < candle.openTime) return null;
  return candle;
}

function sourceMapFromSnapshot(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.data && typeof input.data === 'object' && !Array.isArray(input.data)) return input.data;
  if (input.symbols && typeof input.symbols === 'object' && !Array.isArray(input.symbols)) return input.symbols;
  return null;
}

function candlesFromEntry(entry) {
  if (Array.isArray(entry)) return entry;
  if (entry && typeof entry === 'object') {
    if (Array.isArray(entry.klines)) return entry.klines;
    if (Array.isArray(entry.candles)) return entry.candles;
    if (Array.isArray(entry.data)) return entry.data;
  }
  return [];
}

function dropFormingLatestCandle(candles, nowMs, timeframe) {
  if (candles.length === 0) return candles;
  const last = candles[candles.length - 1];
  const intervalMs = TIMEFRAME_MS[timeframe] || TIMEFRAME_MS[DEFAULT_TIMEFRAME];
  const expectedCloseTime = last.openTime + intervalMs - 1;
  const definitelyClosed = last.closeTime <= nowMs && last.closeTime >= expectedCloseTime;
  return definitelyClosed ? candles : candles.slice(0, -1);
}

export function normalizeKlinesSnapshot(input, opts = {}) {
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const timeframe = normalizeTimeframe(opts.timeframe ?? input?.timeframe);
  const limit = clampPositiveInteger(opts.limit ?? input?.limit, MAX_LIMIT, MAX_LIMIT);
  const topN = clampPositiveInteger(opts.topN ?? input?.topN, MAX_TOP_N, MAX_TOP_N);
  const ttlMs = clampPositiveInteger(opts.ttlMs ?? input?.ttlMs, DEFAULT_TTL_MS, Number.MAX_SAFE_INTEGER);
  const updatedAtMs = normalizeUpdatedAtMs(input);
  const sourceMap = sourceMapFromSnapshot(input);
  const diagnostics = {
    requested: 0,
    stored: 0,
    skipped: 0,
    invalidSymbols: [],
    invalidCandles: 0,
  };
  const data = {};

  if (!sourceMap) {
    return {
      timeframe,
      limit,
      topN,
      ttlMs,
      updatedAtMs,
      stale: true,
      data,
      diagnostics,
    };
  }

  const entries = Object.entries(sourceMap);
  diagnostics.requested = entries.length;

  for (const [rawSymbol, entry] of entries.slice(0, topN)) {
    const parsed = parseKlinesKey(rawSymbol);
    if (!parsed) {
      diagnostics.invalidSymbols.push(String(rawSymbol));
      diagnostics.skipped += 1;
      continue;
    }
    const symbol = parsed.key;

    const candles = [];
    for (const rawCandle of candlesFromEntry(entry)) {
      const candle = normalizeCandle(rawCandle);
      if (candle) {
        candles.push(candle);
      } else {
        diagnostics.invalidCandles += 1;
      }
    }

    const closedCandles = dropFormingLatestCandle(candles, nowMs, timeframe).slice(-limit);
    if (closedCandles.length === 0) {
      diagnostics.skipped += 1;
      continue;
    }

    data[symbol] = closedCandles;
    diagnostics.stored += 1;
  }

  const stale = !Number.isFinite(updatedAtMs) || nowMs - updatedAtMs > ttlMs || updatedAtMs > nowMs;
  return {
    timeframe,
    limit,
    topN,
    ttlMs,
    updatedAtMs,
    stale,
    data,
    diagnostics,
  };
}

export function getFreshClosedKlinesForSymbol(snapshot, symbol, opts = {}) {
  const normalized = normalizeKlinesSnapshot(snapshot, opts);
  if (normalized.stale) return null;

  // `opts.market` scopes the lookup to a venue; omitted keeps the previous behaviour.
  const normalizedSymbol = selectKlinesKey(normalized, symbol, opts.market);
  if (!normalizedSymbol) return null;

  const candles = normalized.data[normalizedSymbol];
  const minCandles = clampPositiveInteger(opts.minCandles, 1, MAX_LIMIT);
  if (!Array.isArray(candles) || candles.length < minCandles) return null;
  return candles;
}
