import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runRadarBacktest } from '../scripts/radar/radar-backtest-engine.mjs';
import { HISTORICAL_MARKET_DATA_SCHEMA_VERSION } from '../scripts/radar/historical-data-contract.mjs';
import { RADAR_TRADE_INTENT_CANDIDATE_FIXTURES, RADAR_TRADE_INTENT_REPLAY_CLOCK_MS } from './fixtures/radar-trade-intent-candidates.mjs';

function dataset(overrides = {}) {
  return {
    schemaVersion: HISTORICAL_MARKET_DATA_SCHEMA_VERSION,
    datasetVersion: 'backtest-fixture-v1',
    provenance: { provider: 'fixture-provider', venue: 'fixture-venue', product: 'spot', quote: 'USDT', symbol: 'SOL/USDT', sourceType: 'historical-export', sourceUrl: 'https://fixtures.invalid/backtest', fetchedAt: '2026-07-24T12:00:00.000Z', importedAt: '2026-07-24T12:01:00.000Z' },
    interval: '1h', range: { start: '2026-07-24T12:00:00.000Z', end: '2026-07-24T14:00:00.000Z', timezone: 'UTC' },
    candles: [
      { openTime: '2026-07-24T12:00:00.000Z', closeTime: '2026-07-24T13:00:00.000Z', open: 140, high: 141, low: 139, close: 140, volume: 1000, sourceStatus: 'AVAILABLE' },
      { openTime: '2026-07-24T13:00:00.000Z', closeTime: '2026-07-24T14:00:00.000Z', open: 140, high: 146, low: 139, close: 145, volume: 1000, sourceStatus: 'AVAILABLE' },
    ],
    gaps: [], corrections: [], depth: { status: 'UNKNOWN' }, ...overrides,
  };
}
function input(overrides = {}) { return { dataset: dataset(), candidateFixture: RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0], mode: 'spot', quote: 'USDT', clockMs: RADAR_TRADE_INTENT_REPLAY_CLOCK_MS, closeAtDatasetEnd: true, ...overrides }; }
function eventTypes(result) { return result.events.map((item) => item.type); }

test('same explicit input is deterministic and creates one simulated take-profit trade', () => {
  const first = runRadarBacktest(input()); const second = runRadarBacktest(input());
  assert.deepEqual(first, second); assert.equal(first.ok, true); assert.equal(first.summary.trades, 1); assert.ok(eventTypes(first).includes('dataset_validated')); assert.ok(eventTypes(first).includes('candidate_validated')); assert.ok(eventTypes(first).includes('intent_created')); assert.ok(eventTypes(first).includes('risk_approved')); assert.ok(eventTypes(first).includes('simulated_entry')); assert.ok(eventTypes(first).includes('simulated_take_profit'));
});
test('invalid dataset and invalid candidate fixture reject before any simulated entry', () => {
  const invalidDataset = runRadarBacktest(input({ dataset: dataset({ interval: '3m' }) }));
  assert.equal(invalidDataset.ok, false); assert.ok(invalidDataset.reasonCodes.includes('invalid_interval')); assert.ok(!eventTypes(invalidDataset).includes('simulated_entry'));
  const invalidCandidate = runRadarBacktest(input({ candidateFixture: RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[1] }));
  assert.equal(invalidCandidate.ok, false); assert.ok(invalidCandidate.reasonCodes.includes('not_entry_ready'));
});
test('fees and execution costs reduce net PnL', () => {
  const free = runRadarBacktest(input());
  const costly = runRadarBacktest(input({ costAssumptions: { makerFeeBps: 0, takerFeeBps: 20, slippageBps: 10, spreadBps: 10 } }));
  assert.ok(costly.summary.netPnl < free.summary.netPnl); assert.ok(costly.summary.fees > 0);
});
test('stop-loss and dataset-end close events are deterministic', () => {
  const stop = runRadarBacktest(input({ dataset: dataset({ candles: [dataset().candles[0], { ...dataset().candles[1], high: 144, low: 134, close: 136 }] }) }));
  assert.ok(eventTypes(stop).includes('simulated_stop')); assert.equal(stop.summary.losses, 1);
  const end = runRadarBacktest(input({ dataset: dataset({ candles: [dataset().candles[0], { ...dataset().candles[1], high: 144, low: 139, close: 142 }] }) }));
  assert.ok(eventTypes(end).includes('dataset_end_close'));
});
test('futures defaults to 1x isolated, rejects leverage above 2x, and keeps quote domains separate', () => {
  const futuresData = dataset({ provenance: { ...dataset().provenance, product: 'futures' }, futures: { status: 'AVAILABLE', fundingRate: 0.0001, markPrice: 140, indexPrice: 140, leverageMarginAssumptions: { maxLeverage: 2, marginMode: 'isolated' } } });
  const futures = runRadarBacktest(input({ dataset: futuresData, mode: 'futures' }));
  assert.equal(futures.ok, true); assert.equal(futures.assumptions.leverage, 1); assert.equal(futures.assumptions.marginMode, 'isolated'); assert.equal(futures.assumptions.liquidation.status, 'UNKNOWN');
  assert.equal(runRadarBacktest(input({ dataset: futuresData, mode: 'futures', leverage: 3 })).ok, false);
  const usdcData = dataset({ provenance: { ...dataset().provenance, quote: 'USDC', symbol: 'SOL/USDC' } });
  assert.equal(runRadarBacktest(input({ dataset: usdcData, quote: 'USDC' })).ok, true);
  assert.equal(runRadarBacktest(input({ dataset: usdcData, quote: 'USDT' })).ok, false);
});
test('missing stored strict Absorb evidence is rejected rather than invented', () => {
  const result = runRadarBacktest(input({ candidateFixture: { ...RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0], source: 'untrusted-fixture' } }));
  assert.equal(result.ok, false); assert.ok(result.reasonCodes.includes('radar_field_not_reconstructable')); assert.ok(!eventTypes(result).includes('intent_created'));
});
test('engine imports only the local validators and has no external client behavior', () => {
  const source = fs.readFileSync(new URL('../scripts/radar/radar-backtest-engine.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['./trade-intent-candidate-validation.mjs', './historical-data-contract.mjs']);
  assert.doesNotMatch(source, /\bfetch\s*\(/i); assert.doesNotMatch(source, /kucoin|binance|telegram|worker|placeorder|submitorder/i);
});
