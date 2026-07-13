import { POSITIONING_STALE_TTL_MS } from './positioning-context.mjs';

const DEFAULT_TOP_N = 20;
const MAX_TOP_N = 20;
const DEFAULT_PERIOD = '5m';
const SUPPORTED_PERIODS = new Set(['5m', '15m', '30m', '1h']);
const STABLE_PAIR_RE = /^[A-Z0-9]{2,24}(USDT|USDC)$/;
const INTERPRETATIONS = new Set(['crowded long', 'crowded short', 'balanced', 'unavailable']);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPositiveInteger(value, fallback, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function cleanSymbol(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,24}$/.test(symbol)) return null;
  return STABLE_PAIR_RE.test(symbol) ? symbol : null;
}

function cleanPeriod(value) {
  const period = String(value || '').trim();
  return SUPPORTED_PERIODS.has(period) ? period : DEFAULT_PERIOD;
}

function cleanIso(value) {
  if (typeof value !== 'string' || !value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function cleanStringArray(value, max = 12) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .map((v) => v.slice(0, 80))
    .slice(0, max);
}

export function normalizeLongShortContextRow(row, opts = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const symbol = cleanSymbol(row.symbol ?? opts.symbol);
  if (!symbol) return null;
  const period = cleanPeriod(row.period ?? opts.period);
  const updatedAt = cleanIso(row.updatedAt);
  const stale = row.stale === true || (updatedAt ? (Number(opts.nowMs ?? Date.now()) - new Date(updatedAt).getTime()) > POSITIONING_STALE_TTL_MS : false);
  const interpretation = INTERPRETATIONS.has(row.interpretation) ? row.interpretation : 'unavailable';
  const out = {
    contextOnly: true,
    source: 'binance-futures-data',
    symbol,
    period,
    updatedAt,
    stale,
    available: row.available === true && stale !== true,
    topTraderPositionRatio: num(row.topTraderPositionRatio),
    globalAccountRatio: num(row.globalAccountRatio),
    takerBuySellRatio: num(row.takerBuySellRatio),
    interpretation,
    warnings: cleanStringArray(row.warnings),
    missing: cleanStringArray(row.missing),
  };
  if (!out.available) {
    out.topTraderPositionRatio = null;
    out.globalAccountRatio = null;
    out.takerBuySellRatio = null;
    out.interpretation = 'unavailable';
    if (stale && out.warnings.length === 0) out.warnings = ['long/short snapshot stale'];
  }
  return out;
}

export function normalizeLongShortSnapshot(input, opts = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const rawSymbols = input.symbols && typeof input.symbols === 'object' && !Array.isArray(input.symbols)
    ? input.symbols
    : null;
  if (!rawSymbols) return null;
  const period = cleanPeriod(input.period ?? opts.period);
  const topN = clampPositiveInteger(input.topN, DEFAULT_TOP_N, MAX_TOP_N);
  const symbols = {};
  const diagnostics = { requested: 0, stored: 0, skipped: 0, invalidSymbols: [] };
  for (const [rawSymbol, rawRow] of Object.entries(rawSymbols)) {
    diagnostics.requested += 1;
    const symbol = cleanSymbol(rawSymbol);
    const row = normalizeLongShortContextRow(rawRow, { symbol, period, nowMs: opts.nowMs });
    if (!symbol || !row) {
      diagnostics.skipped += 1;
      diagnostics.invalidSymbols.push(String(rawSymbol).slice(0, 40));
      continue;
    }
    if (Object.keys(symbols).length >= topN) {
      diagnostics.skipped += 1;
      continue;
    }
    symbols[symbol] = row;
    diagnostics.stored += 1;
  }
  return {
    source: 'binance-futures-data',
    contextOnly: true,
    updatedAt: cleanIso(input.updatedAt) || new Date(Number(opts.nowMs ?? Date.now())).toISOString(),
    period,
    topN,
    symbols,
    diagnostics,
  };
}

export function getFreshLongShortContextForSymbol(snapshot, symbol, opts = {}) {
  const normalized = normalizeLongShortSnapshot(snapshot, opts);
  const clean = cleanSymbol(symbol);
  if (!normalized || !clean) return null;
  const row = normalized.symbols[clean];
  if (!row || row.stale === true || row.available !== true) return null;
  return row;
}
