const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TOP_N = 50;
const EXPECTED_WINDOW_SEC = 300;
// Additive second trusted provider: the Netlify 3-minute atomic collector. It is
// spot, and its rolling window is the REAL elapsed time between two consecutive
// stored depth observations (N-1 → N), which is ~3-6 min rather than the futures
// feed's fixed 300s. Every other trust bar below (freshness, sample counts,
// validation flags, all TRUSTED_ROLLING_FIELDS, static measurements) applies to
// BOTH sources identically — the collector is not held to a weaker standard, only
// a truthfully different window. See scripts/radar/collector-absorb-bridge.mjs.
const COLLECTOR_ROLLING_SOURCE = 'netlify-atomic-collector';
const COLLECTOR_WINDOW_MIN_SEC = 120;
const COLLECTOR_WINDOW_MAX_SEC = 900;
const MIN_TRADE_SAMPLES = 10;
const MIN_DEPTH_SNAPSHOTS = 2;
const MIN_KLINE_SAMPLES = 30;
const OPTIONAL_NUMERIC_FIELDS = Object.freeze(['absorptionScore', 'deltaImprovementPct', 'marketBuyVolumeDominance', 'rollingWindowSec', 'spreadPct', 'depthUsdWithin1Pct']);
const OPTIONAL_BOOLEAN_FIELDS = Object.freeze(['aggressiveSellsFailed', 'supportRetestHeld', 'supportRetested', 'spreadAndSlippageHealthy']);
export const REQUIRED_ROLLING_FIELDS = Object.freeze(['bidDepthRebuildPct', 'marketSellRatio', 'openInterestChangePct', 'longLiquidationSpike', 'flow.takerBuySellRatio', 'flow.cumulativeDeltaPct', 'flow.aggressiveSellExhaustion']);
export const TRUSTED_ROLLING_FIELDS = Object.freeze(['absorptionScore', 'bidDepthRebuildPct', 'aggressiveSellsFailed', 'deltaImprovementPct', 'marketBuyVolumeDominance', 'supportRetestHeld', 'spreadAndSlippageHealthy']);

function clampPositiveInteger(value, fallback, max) { const n = Math.trunc(Number(value)); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback; }
function normalizeSymbol(raw) { const symbol = String(raw ?? '').trim().toUpperCase(); return /^[A-Z0-9]{1,24}$/.test(symbol) ? symbol : null; }
function finiteNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function boolValue(value) { if (value === true || value === false) return value; if (typeof value === 'string' && value.trim().toLowerCase() === 'true') return true; if (typeof value === 'string' && value.trim().toLowerCase() === 'false') return false; return undefined; }
function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function updatedAtMsOf(input) {
  if (!input || typeof input !== 'object') return null;
  for (const key of ['updatedAtMs', 'receivedAtMs', 'generatedAtMs', 'rollingMeasuredAtMs']) { const n = finiteNumber(input[key]); if (n && n > 0) return n; }
  for (const key of ['updatedAt', 'receivedAt', 'generatedAt', 'rollingMeasuredAt']) { if (typeof input[key] === 'string') { const t = Date.parse(input[key]); if (Number.isFinite(t)) return t; } }
  return null;
}
function normalizeFlow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const flow = {};
  for (const key of ['takerBuySellRatio', 'cumulativeDeltaPct']) { if (hasOwn(raw, key)) { const n = finiteNumber(raw[key]); if (n !== null) flow[key] = n; } }
  if (hasOwn(raw, 'aggressiveSellExhaustion')) { const b = boolValue(raw.aggressiveSellExhaustion); if (b !== undefined) flow.aggressiveSellExhaustion = b; }
  return Object.keys(flow).length ? flow : undefined;
}
function foundationPayload(raw) { return hasOwn(raw, 'rollingMeasuredAt') || hasOwn(raw, 'rollingMeasuredAtMs') || hasOwn(raw, 'rollingWindowSec') || hasOwn(raw, 'samples') || hasOwn(raw, 'source') || hasOwn(raw, 'validation'); }
function missingLegacyFields(row) { return REQUIRED_ROLLING_FIELDS.filter((field) => field.startsWith('flow.') ? !hasOwn(row.flow || {}, field.slice(5)) : !hasOwn(row, field)); }
function normalizeValidation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const validation = {};
  for (const key of ['makerFlagsValid', 'tradesValidated', 'tradesSorted', 'klinesValidated']) { const value = boolValue(raw[key]); if (value !== undefined) validation[key] = value; }
  return Object.keys(validation).length ? validation : undefined;
}

export function validateTrustedRollingRow(row, { nowMs = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!row || typeof row !== 'object') return fail('row-invalid');
  if (row.source === 'binance-futures-public') {
    if (Number(row.rollingWindowSec) !== EXPECTED_WINDOW_SEC) return fail('window-invalid');
  } else if (row.source === COLLECTOR_ROLLING_SOURCE) {
    const windowSec = Number(row.rollingWindowSec);
    if (!(Number.isFinite(windowSec) && windowSec >= COLLECTOR_WINDOW_MIN_SEC && windowSec <= COLLECTOR_WINDOW_MAX_SEC)) return fail('window-invalid');
  } else {
    return fail('source-invalid');
  }
  const measuredAtMs = Number(row.rollingMeasuredAtMs);
  if (!Number.isFinite(measuredAtMs) || measuredAtMs > nowMs + 60_000 || nowMs - measuredAtMs > ttlMs) return fail('measurement-stale');
  // Both rejections name the exact floor / flag that failed. A bare
  // 'samples-thin' cannot be acted on: it hides whether the symbol lacked trades,
  // a second depth snapshot, or candle history — three different causes.
  const samples = row.samples || {};
  const thin = [];
  if (!(Number(samples.aggTrades) >= MIN_TRADE_SAMPLES)) thin.push('aggTrades');
  if (!(Number(samples.depthSnapshots) >= MIN_DEPTH_SNAPSHOTS)) thin.push('depthSnapshots');
  if (!(Number(samples.klines) >= MIN_KLINE_SAMPLES)) thin.push('klines');
  if (thin.length) return fail(`samples-thin:${thin.join('+')}`);
  const validation = row.validation || {};
  const invalid = ['makerFlagsValid', 'tradesValidated', 'tradesSorted', 'klinesValidated'].filter((key) => validation[key] !== true);
  if (invalid.length) return fail(`validation-incomplete:${invalid.join('+')}`);
  for (const field of TRUSTED_ROLLING_FIELDS) {
    if (!hasOwn(row, field)) return fail(`missing-${field}`);
    if (field === 'marketBuyVolumeDominance') { if (!(Number.isFinite(row[field]) && row[field] >= 0 && row[field] <= 1)) return fail('buy-dominance-invalid'); }
    else if (field === 'aggressiveSellsFailed' || field === 'supportRetestHeld' || field === 'spreadAndSlippageHealthy') { if (typeof row[field] !== 'boolean') return fail(`invalid-${field}`); }
    else if (!Number.isFinite(row[field])) return fail(`invalid-${field}`);
  }
  if (!(Number.isFinite(row.spreadPct) && row.spreadPct >= 0 && Number.isFinite(row.depthUsdWithin1Pct) && row.depthUsdWithin1Pct > 0)) return fail('static-measurements-missing');
  return { ok: true };
}

function normalizeRow(raw, opts) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = {};
  for (const key of ['bidDepthRebuildPct', 'marketSellRatio', 'openInterestChangePct', 'longLiquidationSpike', ...OPTIONAL_NUMERIC_FIELDS]) { if (hasOwn(raw, key)) { const n = finiteNumber(raw[key]); if (n !== null) row[key] = n; } }
  const flow = normalizeFlow(raw.flow); if (flow) row.flow = flow;
  for (const key of OPTIONAL_BOOLEAN_FIELDS) { if (hasOwn(raw, key)) { const value = boolValue(raw[key]); if (value !== undefined) row[key] = value; } }
  const measuredAt = updatedAtMsOf({ rollingMeasuredAt: raw.rollingMeasuredAt, rollingMeasuredAtMs: raw.rollingMeasuredAtMs }); if (measuredAt !== null) row.rollingMeasuredAtMs = measuredAt;
  if (raw.samples && typeof raw.samples === 'object' && !Array.isArray(raw.samples)) { const samples = {}; for (const key of ['aggTrades', 'depthSnapshots', 'klines']) { const n = finiteNumber(raw.samples[key]); if (n !== null && n >= 0) samples[key] = Math.trunc(n); } if (Object.keys(samples).length) row.samples = samples; }
  if (typeof raw.source === 'string' && raw.source) row.source = raw.source.slice(0, 64);
  const validation = normalizeValidation(raw.validation); if (validation) row.validation = validation;
  const isFoundation = foundationPayload(raw);
  if (isFoundation) {
    const verdict = validateTrustedRollingRow(row, opts);
    row.foundationRejected = !verdict.ok;
    row.foundationReason = verdict.reason || undefined;
    if (!verdict.ok) { for (const key of [...TRUSTED_ROLLING_FIELDS, 'marketSellRatio', 'flow', 'spreadPct', 'depthUsdWithin1Pct']) delete row[key]; }
    row.strictReady = verdict.ok;
    row.missingFields = verdict.ok ? [] : TRUSTED_ROLLING_FIELDS.filter((field) => !hasOwn(row, field));
  } else {
    row.missingFields = missingLegacyFields(row); row.strictReady = row.missingFields.length === 0;
  }
  if (raw.diagnostics && typeof raw.diagnostics === 'object' && !Array.isArray(raw.diagnostics)) row.diagnostics = { ...raw.diagnostics };
  return row;
}
function sourceMap(input) { return input?.data && typeof input.data === 'object' && !Array.isArray(input.data) ? input.data : input?.symbols && typeof input.symbols === 'object' && !Array.isArray(input.symbols) ? input.symbols : null; }

export function normalizeRollingMicrostructureSnapshot(input, opts = {}) {
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now(); const ttlMs = clampPositiveInteger(opts.ttlMs ?? input?.ttlMs, DEFAULT_TTL_MS, Number.MAX_SAFE_INTEGER); const topN = clampPositiveInteger(opts.topN ?? input?.topN, MAX_TOP_N, MAX_TOP_N); const updatedAtMs = updatedAtMsOf(input);
  const data = {}; const diagnostics = { requested: 0, stored: 0, skipped: 0, invalidSymbols: [], missingFieldsBySymbol: {}, ...(input?.diagnostics && typeof input.diagnostics === 'object' && !Array.isArray(input.diagnostics) ? input.diagnostics : {}) };
  const src = sourceMap(input);
  if (src) for (const [rawSymbol, rawRow] of Object.entries(src).slice(0, topN)) { const symbol = normalizeSymbol(rawSymbol); if (!symbol) { diagnostics.invalidSymbols.push(String(rawSymbol)); diagnostics.skipped += 1; continue; } const row = normalizeRow(rawRow, { nowMs, ttlMs }); if (!row) { diagnostics.skipped += 1; continue; } data[symbol] = row; diagnostics.stored += 1; if (row.missingFields.length) diagnostics.missingFieldsBySymbol[symbol] = row.missingFields; }
  const stale = !Number.isFinite(updatedAtMs) || updatedAtMs > nowMs + 60_000 || nowMs - updatedAtMs > ttlMs;
  const suppliedTrusted = boolValue(input?.trusted) === true;
  const foundationRows = Object.values(data).filter((row) => foundationPayload(row));
  const trusted = suppliedTrusted && !stale && (foundationRows.length ? foundationRows.every((row) => row.strictReady === true) : true);
  return { provider: typeof input?.provider === 'string' ? input.provider.slice(0, 64) : 'unknown', updatedAtMs, timeframe: typeof input?.timeframe === 'string' && input.timeframe ? input.timeframe.slice(0, 32) : 'rolling', windows: input?.windows && typeof input.windows === 'object' && !Array.isArray(input.windows) ? { ...input.windows } : {}, ttlMs, trusted, stale, data, diagnostics };
}
export function getFreshRollingMicrostructureForSymbol(snapshot, symbol, opts = {}) { const normalized = normalizeRollingMicrostructureSnapshot(snapshot, opts); if (normalized.stale || normalized.trusted !== true) return null; const safeSymbol = normalizeSymbol(symbol); const row = safeSymbol && normalized.data[safeSymbol]; return row ? { ...row, missingFields: [...row.missingFields] } : null; }