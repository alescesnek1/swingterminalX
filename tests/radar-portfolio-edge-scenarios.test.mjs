import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runRadarBacktest, runRadarPortfolioBacktest } from '../scripts/radar/radar-backtest-engine.mjs';
import { RADAR_PORTFOLIO_EDGE_SCENARIOS, edgeDataset } from './fixtures/radar-portfolio-edge-scenarios.mjs';

const scenario = (name) => RADAR_PORTFOLIO_EDGE_SCENARIOS.find((item) => item.name === name);
function inputFor(name, overrides = {}) {
  const item = scenario(name); const plan = item.tradePlans[0];
  return { ...item.assumptions, ...plan, dataset: plan.dataset, candidateFixture: plan.candidateFixture, ...overrides };
}
function portfolio(plans, assumptions = {}) {
  return { scenarioVersion: 1, schemaVersion: 'radar-portfolio-scenario/v1', createdAt: '2026-07-24T12:00:00.000Z', assumptions: { ...scenario('daily-loss-seed').assumptions, dailyBoundaryPolicy: 'UTC', ...assumptions }, tradePlans: plans };
}

test('versioned edge fixtures provide deterministic partial fill accounting', () => {
  for (const item of RADAR_PORTFOLIO_EDGE_SCENARIOS) { assert.equal(item.scenarioVersion, 1); assert.equal(item.schemaVersion, 'radar-portfolio-edge-scenario/v1'); assert.equal(item.createdAt, '2026-07-24T12:00:00.000Z'); }
  const partialEntry = runRadarBacktest(inputFor('partial-entry'));
  assert.equal(partialEntry.positions[0].entryFillRatio, 0.5);
  assert.equal(partialEntry.positions[0].notional, 50);
  assert.equal(partialEntry.positions[0].unfilledEntryPolicy, 'cancelled');
  assert.equal(partialEntry.positions[0].entryFee, 0);
  const partialExit = runRadarBacktest(inputFor('partial-exit'));
  assert.equal(partialExit.positions[0].exitFillRatio, 0.5);
  assert.ok(partialExit.positions[0].remainingQuantity > 0);
  assert.equal(partialExit.positions[0].remainingExitPolicy, 'mark_to_dataset_end');
  assert.ok(partialExit.summary.openPositions === 1);
});

test('gaps fail closed, stale candidates cannot reach a fill, and end policy is explicit', () => {
  const before = runRadarBacktest(inputFor('gap-before-entry'));
  assert.equal(before.ok, false);
  assert.ok(before.reasonCodes.includes('candle_gap'));
  assert.ok(!before.events.some((entry) => entry.type === 'simulated_entry'));
  const whileOpen = runRadarBacktest(inputFor('gap-while-open'));
  assert.ok(whileOpen.events.some((entry) => entry.type === 'simulated_entry'));
  assert.ok(whileOpen.events.some((entry) => entry.type === 'simulated_stop'));
  assert.ok(whileOpen.warnings.includes('candle_gap'));
  const stale = runRadarBacktest(inputFor('stale-before-fill'));
  assert.ok(stale.riskDecisions[0].reasonCodes.includes('stale_data'));
  assert.ok(!stale.events.some((entry) => entry.type === 'simulated_entry'));
  const quiet = edgeDataset({ candles: edgeDataset().candles.map((candle) => ({ ...candle, high: 144, low: 139, close: 142 })) });
  const kept = runRadarBacktest(inputFor('dataset-end', { dataset: quiet, closeAtDatasetEnd: false }));
  const closed = runRadarBacktest(inputFor('dataset-end', { dataset: quiet, closeAtDatasetEnd: true }));
  assert.equal(kept.summary.openPositions, 1);
  assert.ok(closed.events.some((entry) => entry.type === 'dataset_end_close'));
});

test('funding is charged only from supplied evidence and missing funding remains unknown', () => {
  const funded = runRadarBacktest(inputFor('futures-funding'));
  assert.ok(funded.quoteLedgers.USDT.fundingFees > 0);
  const unknown = runRadarBacktest(inputFor('futures-funding-unknown'));
  assert.ok(unknown.warnings.includes('funding_unknown'));
  assert.equal(unknown.quoteLedgers.USDT.fundingFees, 0);
});

test('UTC daily reset, per-quote losses, and optional global loss use deterministic portfolio state', () => {
  const seed = scenario('daily-loss-seed').tradePlans[0];
  const next = { ...seed, fixtureId: 'next-day', scheduledAt: '2026-07-25T12:00:00.000Z' };
  const lossLimits = { ...scenario('daily-loss-seed').assumptions.riskLimits, maxDailyLoss: 4 };
  const reset = runRadarPortfolioBacktest(portfolio([seed, next], { riskLimits: lossLimits }));
  assert.equal(reset.results[1].ok, true);
  assert.ok(reset.events.some((entry) => entry.type === 'daily_boundary_reset'));

  const usdcData = edgeDataset({ quote: 'USDC', symbol: 'SOL/USDC' });
  const usdc = { ...seed, fixtureId: 'usdc', symbol: 'SOL/USDC', dataset: usdcData, quote: 'USDC', scheduledAt: '2026-07-24T15:00:00.000Z' };
  const separated = runRadarPortfolioBacktest(portfolio([seed, usdc], { riskLimits: lossLimits }));
  assert.equal(separated.results[1].ok, true);
  const global = runRadarPortfolioBacktest(portfolio([seed, usdc], { riskLimits: { ...lossLimits, globalDailyLoss: 3 } }));
  assert.equal(global.results[1].ok, false);
  assert.ok(global.riskDecisions.some((entry) => entry.reasonCodes.includes('max_daily_loss_exceeded')));
});

test('edge fixtures and engine remain local-only with no external client imports', () => {
  const source = fs.readFileSync(new URL('../scripts/radar/radar-backtest-engine.mjs', import.meta.url), 'utf8') + fs.readFileSync(new URL('./fixtures/radar-portfolio-edge-scenarios.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(/i);
  assert.doesNotMatch(source, /kucoin|binance|telegram|worker|placeorder|submitorder/i);
});
