import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HISTORICAL_MARKET_DATA_SCHEMA_VERSION, assessRadarHistoricalReconstruction, validateHistoricalMarketDataset } from '../scripts/radar/historical-data-contract.mjs';
import { RADAR_TRADE_INTENT_CANDIDATE_FIXTURES } from './fixtures/radar-trade-intent-candidates.mjs';

function spot(overrides = {}) {
  return {
    schemaVersion: HISTORICAL_MARKET_DATA_SCHEMA_VERSION,
    datasetVersion: 'fixture-spot-v1',
    provenance: { provider: 'fixture-provider', venue: 'fixture-venue', product: 'spot', quote: 'USDT', symbol: 'SOL/USDT', sourceType: 'historical-export', sourceUrl: 'https://fixtures.invalid/historical-candles', fetchedAt: '2026-07-24T12:00:00.000Z', importedAt: '2026-07-24T12:01:00.000Z' },
    interval: '1h',
    range: { start: '2026-07-24T00:00:00.000Z', end: '2026-07-24T02:00:00.000Z', timezone: 'UTC' },
    candles: [
      { openTime: '2026-07-24T00:00:00.000Z', closeTime: '2026-07-24T01:00:00.000Z', open: 100, high: 103, low: 99, close: 101, volume: 1000, quoteVolume: 101000, tradeCount: 20, sourceStatus: 'AVAILABLE' },
      { openTime: '2026-07-24T01:00:00.000Z', closeTime: '2026-07-24T02:00:00.000Z', open: 101, high: 104, low: 100, close: 102, volume: 900, quoteVolume: 91800, tradeCount: 18, sourceStatus: 'AVAILABLE' },
    ],
    gaps: [], corrections: [], depth: { status: 'UNKNOWN' }, ...overrides,
  };
}
function futures(overrides = {}) {
  const base = spot();
  return { ...base, datasetVersion: 'fixture-futures-v1', provenance: { ...base.provenance, product: 'futures' }, futures: { status: 'AVAILABLE', fundingRate: 0.0001, markPrice: 102, indexPrice: 101.8, openInterest: 50000, liquidationDistance: { status: 'UNKNOWN' }, leverageMarginAssumptions: { maxLeverage: 2, marginMode: 'isolated' } }, ...overrides };
}

test('valid spot USDT candle dataset is accepted with unavailable depth marked UNKNOWN', () => {
  const result = validateHistoricalMarketDataset(spot());
  assert.equal(result.ok, true); assert.deepEqual(result.reasonCodes, []); assert.ok(result.warnings.includes('depth_unavailable')); assert.equal(result.normalizedSummary.depthStatus, 'UNKNOWN'); assert.equal(result.schemaVersion, HISTORICAL_MARKET_DATA_SCHEMA_VERSION); assert.equal(result.datasetVersion, 'fixture-spot-v1');
});
test('valid futures USDT dataset accepts funding, mark, index, and simulation assumptions', () => {
  const result = validateHistoricalMarketDataset(futures());
  assert.equal(result.ok, true); assert.equal(result.normalizedSummary.futuresStatus, 'AVAILABLE');
});
test('USDC is supported and unsupported quotes reject', () => {
  assert.equal(validateHistoricalMarketDataset(spot({ provenance: { ...spot().provenance, quote: 'USDC', symbol: 'SOL/USDC' } })).ok, true);
  assert.ok(validateHistoricalMarketDataset(spot({ provenance: { ...spot().provenance, quote: 'EUR' } })).reasonCodes.includes('unsupported_quote'));
});
test('invalid interval, duplicate candles, and gaps reject', () => {
  assert.ok(validateHistoricalMarketDataset(spot({ interval: '3m' })).reasonCodes.includes('invalid_interval'));
  assert.ok(validateHistoricalMarketDataset(spot({ candles: [...spot().candles, spot().candles[0]] })).reasonCodes.includes('duplicate_candle'));
  const gap = { ...spot().candles[1], openTime: '2026-07-24T02:00:00.000Z', closeTime: '2026-07-24T03:00:00.000Z' };
  assert.ok(validateHistoricalMarketDataset(spot({ range: { start: '2026-07-24T00:00:00.000Z', end: '2026-07-24T03:00:00.000Z', timezone: 'UTC' }, candles: [spot().candles[0], gap], gaps: [{ start: '2026-07-24T01:00:00.000Z', end: '2026-07-24T02:00:00.000Z', reason: 'source-gap' }] })).reasonCodes.includes('candle_gap'));
});
test('invalid OHLC and negative volume reject', () => {
  assert.ok(validateHistoricalMarketDataset(spot({ candles: [{ ...spot().candles[0], high: 100 }, spot().candles[1] ] })).reasonCodes.includes('invalid_ohlc'));
  assert.ok(validateHistoricalMarketDataset(spot({ candles: [{ ...spot().candles[0], volume: -1 }, spot().candles[1] ] })).reasonCodes.includes('negative_volume'));
});
test('missing futures fields and depth stay UNKNOWN rather than being fabricated', () => {
  const futuresResult = validateHistoricalMarketDataset(futures({ futures: undefined }));
  assert.equal(futuresResult.ok, true); assert.ok(futuresResult.warnings.includes('futures_field_missing')); assert.equal(futuresResult.normalizedSummary.futuresStatus, 'UNKNOWN');
  const depthResult = validateHistoricalMarketDataset(spot({ depth: undefined }));
  assert.equal(depthResult.normalizedSummary.depthStatus, 'UNKNOWN'); assert.ok(depthResult.warnings.includes('depth_unavailable'));
});
test('strict Absorb is NOT_RECONSTRUCTABLE without a stored historical RADAR candidate', () => {
  const dataset = spot();
  assert.equal(assessRadarHistoricalReconstruction(dataset).states.strict_absorb, 'NOT_RECONSTRUCTABLE');
  assert.ok(validateHistoricalMarketDataset(dataset, { requiredRadarFields: ['strict_absorb'] }).reasonCodes.includes('radar_field_not_reconstructable'));
  assert.equal(assessRadarHistoricalReconstruction(dataset, { historicalCandidateFixture: RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0] }).states.strict_absorb, 'AVAILABLE_FROM_HISTORICAL_CANDIDATE');
});
test('contract is pure and imports no exchange, Telegram, order, or worker module', () => {
  const source = fs.readFileSync(new URL('../scripts/radar/historical-data-contract.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m); assert.doesNotMatch(source, /\bfetch\s*\(/i); assert.doesNotMatch(source, /kucoin|binance|telegram|worker|placeorder|submitorder/i);
});
