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
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) {
      diagnostics.invalidSymbols.push(String(rawSymbol));
      diagnostics.skipped += 1;
      continue;
    }

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

  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return null;

  const candles = normalized.data[normalizedSymbol];
  const minCandles = clampPositiveInteger(opts.minCandles, 1, MAX_LIMIT);
  if (!Array.isArray(candles) || candles.length < minCandles) return null;
  return candles;
}
