import { HISTORICAL_MARKET_DATA_SCHEMA_VERSION } from '../../scripts/radar/historical-data-contract.mjs';
import { RADAR_TRADE_INTENT_CANDIDATE_FIXTURES, RADAR_TRADE_INTENT_REPLAY_CLOCK_MS } from './radar-trade-intent-candidates.mjs';

export const RADAR_PORTFOLIO_EDGE_SCENARIO_VERSION = 1;
export const RADAR_PORTFOLIO_EDGE_SCHEMA_VERSION = 'radar-portfolio-edge-scenario/v1';
export const RADAR_PORTFOLIO_EDGE_CREATED_AT = '2026-07-24T12:00:00.000Z';

export function edgeDataset({ quote = 'USDT', product = 'spot', symbol = 'SOL/USDT', candles, gaps = [], futures } = {}) {
  return {
    schemaVersion: HISTORICAL_MARKET_DATA_SCHEMA_VERSION, datasetVersion: 'synthetic-edge-v1',
    provenance: { provider: 'synthetic', venue: 'fixture', product, quote, symbol, sourceType: 'fixture', sourceUrl: 'https://fixtures.invalid/edge', fetchedAt: RADAR_PORTFOLIO_EDGE_CREATED_AT, importedAt: RADAR_PORTFOLIO_EDGE_CREATED_AT },
    interval: '1h', range: { start: '2026-07-24T12:00:00.000Z', end: '2026-07-24T14:00:00.000Z', timezone: 'UTC' },
    candles: candles ?? [
      { openTime: '2026-07-24T12:00:00.000Z', closeTime: '2026-07-24T13:00:00.000Z', open: 140, high: 141, low: 139, close: 140, volume: 1, sourceStatus: 'AVAILABLE' },
      { openTime: '2026-07-24T13:00:00.000Z', closeTime: '2026-07-24T14:00:00.000Z', open: 140, high: 146, low: 134, close: 140, volume: 1, sourceStatus: 'AVAILABLE' },
    ],
    gaps, corrections: [], depth: { status: 'UNKNOWN' }, ...(futures ? { futures } : {}),
  };
}
const valid = RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0];
const base = { clockMs: RADAR_TRADE_INTENT_REPLAY_CLOCK_MS, quoteBalances: { USDT: 1000, USDC: 500 }, sizing: { model: 'fixedNotional', fixedNotional: 100 }, riskLimits: { maxExposurePerTrade: 200, maxRealRiskAtStop: 20, maxOpenPositions: 2, maxDailyLoss: 100 }, closeAtDatasetEnd: true, mode: 'spot', quote: 'USDT' };
function scenario(name, fields, expected) { return { name, scenarioVersion: 1, schemaVersion: RADAR_PORTFOLIO_EDGE_SCHEMA_VERSION, createdAt: RADAR_PORTFOLIO_EDGE_CREATED_AT, assumptions: base, symbols: ['SOL/USDT'], datasets: [fields.dataset], candidateFixtures: [fields.candidateFixture ?? valid], tradePlans: [{ fixtureId: name, symbol: 'SOL/USDT', scheduledAt: RADAR_PORTFOLIO_EDGE_CREATED_AT, candidateFixture: fields.candidateFixture ?? valid, dataset: fields.dataset, ...fields }], expected }; }

const lossDataset = edgeDataset({ candles: [
  { openTime: '2026-07-24T12:00:00.000Z', closeTime: '2026-07-24T13:00:00.000Z', open: 140, high: 141, low: 139, close: 140, volume: 1, sourceStatus: 'AVAILABLE' },
  { openTime: '2026-07-24T13:00:00.000Z', closeTime: '2026-07-24T14:00:00.000Z', open: 140, high: 144, low: 134, close: 136, volume: 1, sourceStatus: 'AVAILABLE' },
] });
export const RADAR_PORTFOLIO_EDGE_SCENARIOS = Object.freeze([
  scenario('partial-entry', { dataset: edgeDataset(), partialFillRatio: 0.5 }, { entryRatio: 0.5 }),
  scenario('partial-exit', { dataset: edgeDataset(), partialExitRatio: 0.5 }, { exitRatio: 0.5 }),
  scenario('gap-before-entry', { dataset: edgeDataset({ gaps: [{ start: '2026-07-24T12:00:00.000Z', end: '2026-07-24T13:00:00.000Z' }] }) }, { reason: 'candle_gap' }),
  scenario('gap-while-open', { dataset: edgeDataset({ candles: edgeDataset().candles.map((candle, index) => index === 1 ? { ...candle, gapAfter: true } : candle) }) }, { warning: 'candle_gap' }),
  scenario('dataset-end', { dataset: edgeDataset(), closeAtDatasetEnd: false }, { open: true }),
  scenario('stale-before-fill', { dataset: edgeDataset(), candidateFreshnessAtFill: true, candidateMaxAgeMs: 1 }, { reason: 'stale_data' }),
  scenario('futures-funding', { dataset: edgeDataset({ product: 'futures', futures: { status: 'AVAILABLE', markPrice: 140, indexPrice: 140, fundingEvents: [{ time: '2026-07-24T13:30:00.000Z', rate: 0.01 }], leverageMarginAssumptions: { maxLeverage: 2, marginMode: 'isolated' }, liquidationDistance: { status: 'KNOWN' } } }), mode: 'futures', leverage: 1, marginMode: 'isolated' }, { funding: true }),
  scenario('futures-funding-unknown', { dataset: edgeDataset({ product: 'futures', futures: { status: 'AVAILABLE', markPrice: 140, indexPrice: 140, leverageMarginAssumptions: { maxLeverage: 2, marginMode: 'isolated' }, liquidationDistance: { status: 'KNOWN' } } }), mode: 'futures', leverage: 1, marginMode: 'isolated' }, { warning: 'funding_unknown' }),
  scenario('daily-loss-seed', { dataset: lossDataset }, { loss: true }),
]);
