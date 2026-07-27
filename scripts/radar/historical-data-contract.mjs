export const HISTORICAL_MARKET_DATA_SCHEMA_VERSION = 'historical-market-data/v1';

const PRODUCTS = new Set(['spot', 'futures']);
const QUOTES = new Set(['USDT', 'USDC']);
const INTERVALS = Object.freeze({ '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 });

function record(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function add(values, value) { if (!values.includes(value)) values.push(value); }
function number(value) { return typeof value === 'number' && Number.isFinite(value); }
function utc(value) { const ms = typeof value === 'string' && value.endsWith('Z') ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms : null; }
function required(value, fields, reasons) {
  let ok = true;
  for (const field of fields) if (value[field] == null || value[field] === '') { add(reasons, 'missing_required_field'); ok = false; }
  return ok;
}

function summary(dataset, depthStatus, futuresStatus) {
  const p = record(dataset?.provenance) ? dataset.provenance : {};
  const r = record(dataset?.range) ? dataset.range : {};
  return {
    provider: typeof p.provider === 'string' ? p.provider : null,
    venue: typeof p.venue === 'string' ? p.venue : null,
    product: typeof p.product === 'string' ? p.product : null,
    quote: typeof p.quote === 'string' ? p.quote : null,
    symbol: typeof p.symbol === 'string' ? p.symbol.toUpperCase() : null,
    sourceType: typeof p.sourceType === 'string' ? p.sourceType : null,
    interval: typeof dataset?.interval === 'string' ? dataset.interval : null,
    candleCount: Array.isArray(dataset?.candles) ? dataset.candles.length : 0,
    rangeStart: typeof r.start === 'string' ? r.start : null,
    rangeEnd: typeof r.end === 'string' ? r.end : null,
    timezone: typeof r.timezone === 'string' ? r.timezone : null,
    depthStatus,
    futuresStatus,
  };
}

function validateDepth(depth, reasons, warnings) {
  if (!record(depth) || depth.status !== 'AVAILABLE') { add(warnings, 'depth_unavailable'); return 'UNKNOWN'; }
  if (typeof depth.sourceFreshness !== 'string' || !depth.sourceFreshness || !Array.isArray(depth.snapshots) || !depth.snapshots.length) { add(reasons, 'unknown_state'); add(warnings, 'depth_unavailable'); return 'UNKNOWN'; }
  for (const snapshot of depth.snapshots) {
    if (!record(snapshot) || utc(snapshot.snapshotTime) == null || !Array.isArray(snapshot.bids) || !snapshot.bids.length || !Array.isArray(snapshot.asks) || !snapshot.asks.length || !number(snapshot.spread) || snapshot.spread < 0 || !record(snapshot.depthSummary)) {
      add(reasons, 'unknown_state'); return 'UNKNOWN';
    }
  }
  return 'AVAILABLE';
}

function validateFutures(product, futures, reasons, warnings) {
  if (product !== 'futures') return 'NOT_APPLICABLE';
  if (!record(futures) || futures.status !== 'AVAILABLE' || !number(futures.fundingRate) || !number(futures.markPrice) || !number(futures.indexPrice) || !record(futures.leverageMarginAssumptions)) {
    add(warnings, 'futures_field_missing'); return 'UNKNOWN';
  }
  if (futures.markPrice <= 0 || futures.indexPrice <= 0) { add(reasons, 'unknown_state'); return 'UNKNOWN'; }
  return 'AVAILABLE';
}

export function assessRadarHistoricalReconstruction(dataset, options = {}) {
  const hasCandles = Array.isArray(dataset?.candles) && dataset.candles.length > 0;
  const depthAvailable = record(dataset?.depth) && dataset.depth.status === 'AVAILABLE' && typeof dataset.depth.sourceFreshness === 'string' && Boolean(dataset.depth.sourceFreshness) && Array.isArray(dataset.depth.snapshots) && dataset.depth.snapshots.length > 0;
  const candidate = options?.historicalCandidateFixture;
  const storedCandidate = record(candidate) && candidate.source === 'trading-radar-v1' && record(candidate.candidate);
  const states = {
    candle_structure: hasCandles ? 'PARTIAL' : 'UNKNOWN',
    reclaim: hasCandles ? 'PARTIAL' : 'UNKNOWN',
    levels_risk_reward: hasCandles ? 'PARTIAL' : 'UNKNOWN',
    execution_score: depthAvailable ? 'PARTIAL' : 'UNKNOWN',
    strict_absorb: storedCandidate ? 'AVAILABLE_FROM_HISTORICAL_CANDIDATE' : 'NOT_RECONSTRUCTABLE',
    actionability: storedCandidate ? 'AVAILABLE_FROM_HISTORICAL_CANDIDATE' : 'NOT_RECONSTRUCTABLE',
    notification_eligibility: storedCandidate ? 'AVAILABLE_FROM_HISTORICAL_CANDIDATE' : 'NOT_RECONSTRUCTABLE',
  };
  return {
    states,
    notReconstructable: Object.entries(states).filter(([, value]) => value === 'NOT_RECONSTRUCTABLE').map(([field]) => field),
    source: storedCandidate ? 'historical-radar-candidate' : 'historical-market-data-only',
  };
}

export function validateHistoricalMarketDataset(dataset, options = {}) {
  const reasonCodes = [];
  const warnings = [];
  if (!record(dataset)) return { ok: false, reasonCodes: ['missing_dataset'], warnings, normalizedSummary: summary(null, 'UNKNOWN', 'UNKNOWN'), schemaVersion: HISTORICAL_MARKET_DATA_SCHEMA_VERSION, datasetVersion: null };

  const p = record(dataset.provenance) ? dataset.provenance : {};
  const intervalMs = INTERVALS[dataset.interval];
  const depthStatus = validateDepth(dataset.depth, reasonCodes, warnings);
  const futuresStatus = validateFutures(p.product, dataset.futures, reasonCodes, warnings);
  if (dataset.schemaVersion !== HISTORICAL_MARKET_DATA_SCHEMA_VERSION) add(reasonCodes, 'unsupported_schema_version');
  if (typeof dataset.datasetVersion !== 'string' || !dataset.datasetVersion.trim()) add(reasonCodes, 'missing_required_field');
  if (!PRODUCTS.has(p.product)) add(reasonCodes, 'unsupported_product');
  if (!QUOTES.has(p.quote)) add(reasonCodes, 'unsupported_quote');
  if (typeof p.symbol !== 'string' || !/^[A-Z0-9]{2,20}(?:[/-][A-Z0-9]{2,10})?$/.test(p.symbol)) add(reasonCodes, 'invalid_symbol');
  if (!intervalMs) add(reasonCodes, 'invalid_interval');
  if (!required(p, ['provider', 'venue', 'product', 'quote', 'symbol', 'sourceType', 'sourceUrl', 'fetchedAt', 'importedAt'], reasonCodes)) add(reasonCodes, 'unknown_state');
  if (utc(p.fetchedAt) == null || utc(p.importedAt) == null) add(reasonCodes, 'non_utc_time');

  const range = record(dataset.range) ? dataset.range : {};
  if (!required(range, ['start', 'end', 'timezone'], reasonCodes)) add(reasonCodes, 'unknown_state');
  const rangeStart = utc(range.start); const rangeEnd = utc(range.end);
  if (range.timezone !== 'UTC' || rangeStart == null || rangeEnd == null) add(reasonCodes, 'non_utc_time');
  if (rangeStart != null && rangeEnd != null && rangeStart >= rangeEnd) add(reasonCodes, 'unknown_state');
  if (!Array.isArray(dataset.gaps) || !Array.isArray(dataset.corrections)) add(reasonCodes, 'missing_required_field');

  if (!Array.isArray(dataset.candles) || !dataset.candles.length) add(reasonCodes, 'missing_required_field');
  else if (intervalMs) {
    const candles = [...dataset.candles].sort((a, b) => String(a?.openTime).localeCompare(String(b?.openTime)));
    const seen = new Set(); let prior = null;
    for (const candle of candles) {
      if (!record(candle) || !required(candle, ['openTime', 'closeTime', 'open', 'high', 'low', 'close', 'volume', 'sourceStatus'], reasonCodes)) { add(reasonCodes, 'unknown_state'); continue; }
      const open = utc(candle.openTime); const close = utc(candle.closeTime);
      if (open == null || close == null) { add(reasonCodes, 'non_utc_time'); continue; }
      if (open % intervalMs !== 0 || close !== open + intervalMs) add(reasonCodes, 'misaligned_interval');
      if (seen.has(open)) add(reasonCodes, 'duplicate_candle');
      if (prior != null && open - prior > intervalMs) add(reasonCodes, 'candle_gap');
      seen.add(open); prior = open;
      if (![candle.open, candle.high, candle.low, candle.close].every(number) || candle.open <= 0 || candle.low <= 0 || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) add(reasonCodes, 'invalid_ohlc');
      if (!number(candle.volume) || candle.volume < 0 || (candle.quoteVolume != null && (!number(candle.quoteVolume) || candle.quoteVolume < 0)) || (candle.tradeCount != null && (!Number.isInteger(candle.tradeCount) || candle.tradeCount < 0))) add(reasonCodes, 'negative_volume');
      if (candle.sourceStatus !== 'AVAILABLE') add(reasonCodes, 'unknown_state');
    }
  }

  const reconstruction = assessRadarHistoricalReconstruction(dataset, options);
  const requiredRadar = Array.isArray(options?.requiredRadarFields) ? options.requiredRadarFields : [];
  if (requiredRadar.some((field) => reconstruction.states[field] === 'NOT_RECONSTRUCTABLE')) add(reasonCodes, 'radar_field_not_reconstructable');
  return { ok: reasonCodes.length === 0, reasonCodes, warnings, normalizedSummary: summary(dataset, depthStatus, futuresStatus), schemaVersion: HISTORICAL_MARKET_DATA_SCHEMA_VERSION, datasetVersion: typeof dataset.datasetVersion === 'string' ? dataset.datasetVersion : null };
}
