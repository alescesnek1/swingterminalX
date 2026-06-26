const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TOP_N = 50;

export const REQUIRED_ROLLING_FIELDS = Object.freeze([
  'bidDepthRebuildPct',
  'marketSellRatio',
  'openInterestChangePct',
  'longLiquidationSpike',
  'flow.takerBuySellRatio',
  'flow.cumulativeDeltaPct',
  'flow.aggressiveSellExhaustion',
]);

function clampPositiveInteger(value, fallback, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function normalizeSymbol(raw) {
  const symbol = String(raw ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{1,24}$/.test(symbol) ? symbol : null;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolValue(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined;
}

function updatedAtMsOf(input) {
  if (!input || typeof input !== 'object') return null;
  for (const key of ['updatedAtMs', 'receivedAtMs', 'generatedAtMs']) {
    const n = finiteNumber(input[key]);
    if (n && n > 0) return n;
  }
  for (const key of ['updatedAt', 'receivedAt', 'generatedAt']) {
    if (typeof input[key] !== 'string') continue;
    const t = Date.parse(input[key]);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeFlow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const flow = {};
  for (const key of ['takerBuySellRatio', 'cumulativeDeltaPct']) {
    if (!hasOwn(raw, key)) continue;
    const n = finiteNumber(raw[key]);
    if (n !== null) flow[key] = n;
  }
  if (hasOwn(raw, 'aggressiveSellExhaustion')) {
    const b = boolValue(raw.aggressiveSellExhaustion);
    if (b !== undefined) flow.aggressiveSellExhaustion = b;
  }
  return Object.keys(flow).length ? flow : undefined;
}

function missingFieldsFor(row) {
  const missing = [];
  for (const field of REQUIRED_ROLLING_FIELDS) {
    if (field.startsWith('flow.')) {
      const key = field.slice(5);
      if (!row.flow || !hasOwn(row.flow, key)) missing.push(field);
    } else if (!hasOwn(row, field)) {
      missing.push(field);
    }
  }
  return missing;
}

function normalizeRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = {};
  for (const key of ['bidDepthRebuildPct', 'marketSellRatio', 'openInterestChangePct', 'longLiquidationSpike']) {
    if (!hasOwn(raw, key)) continue;
    const n = finiteNumber(raw[key]);
    if (n !== null) row[key] = n;
  }
  const flow = normalizeFlow(raw.flow);
  if (flow) row.flow = flow;
  if (raw.diagnostics && typeof raw.diagnostics === 'object' && !Array.isArray(raw.diagnostics)) {
    row.diagnostics = { ...raw.diagnostics };
  }
  const missingFields = missingFieldsFor(row);
  row.missingFields = missingFields;
  row.strictReady = missingFields.length === 0;
  return row;
}

function sourceMap(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.data && typeof input.data === 'object' && !Array.isArray(input.data)) return input.data;
  if (input.symbols && typeof input.symbols === 'object' && !Array.isArray(input.symbols)) return input.symbols;
  return null;
}

export function normalizeRollingMicrostructureSnapshot(input, opts = {}) {
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const ttlMs = clampPositiveInteger(opts.ttlMs ?? input?.ttlMs, DEFAULT_TTL_MS, Number.MAX_SAFE_INTEGER);
  const topN = clampPositiveInteger(opts.topN ?? input?.topN, MAX_TOP_N, MAX_TOP_N);
  const updatedAtMs = updatedAtMsOf(input);
  const trusted = boolValue(input?.trusted) === true;
  const data = {};
  const diagnostics = {
    requested: 0,
    stored: 0,
    skipped: 0,
    invalidSymbols: [],
    missingFieldsBySymbol: {},
    ...(input && input.diagnostics && typeof input.diagnostics === 'object' && !Array.isArray(input.diagnostics) ? input.diagnostics : {}),
  };

  const src = sourceMap(input);
  if (src) {
    const entries = Object.entries(src);
    diagnostics.requested = entries.length;
    for (const [rawSymbol, rawRow] of entries.slice(0, topN)) {
      const symbol = normalizeSymbol(rawSymbol);
      if (!symbol) {
        diagnostics.invalidSymbols.push(String(rawSymbol));
        diagnostics.skipped += 1;
        continue;
      }
      const row = normalizeRow(rawRow);
      if (!row) {
        diagnostics.skipped += 1;
        continue;
      }
      data[symbol] = row;
      diagnostics.stored += 1;
      if (row.missingFields.length) diagnostics.missingFieldsBySymbol[symbol] = row.missingFields;
    }
  }

  const stale = !Number.isFinite(updatedAtMs) || updatedAtMs > nowMs + 60000 || nowMs - updatedAtMs > ttlMs;
  return {
    provider: typeof input?.provider === 'string' ? input.provider.slice(0, 64) : 'unknown',
    updatedAtMs,
    timeframe: typeof input?.timeframe === 'string' && input.timeframe ? input.timeframe.slice(0, 32) : 'rolling',
    windows: input && input.windows && typeof input.windows === 'object' && !Array.isArray(input.windows) ? { ...input.windows } : {},
    ttlMs,
    trusted,
    stale,
    data,
    diagnostics,
  };
}

export function getFreshRollingMicrostructureForSymbol(snapshot, symbol, opts = {}) {
  const normalized = normalizeRollingMicrostructureSnapshot(snapshot, opts);
  if (normalized.stale || normalized.trusted !== true) return null;
  const safeSymbol = normalizeSymbol(symbol);
  if (!safeSymbol) return null;
  const row = normalized.data[safeSymbol];
  if (!row) return null;
  return {
    ...row,
    strictReady: row.missingFields.length === 0,
    missingFields: [...row.missingFields],
  };
}