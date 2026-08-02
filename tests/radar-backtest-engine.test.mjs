import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runRadarBacktest, levelDomainReasons } from '../scripts/radar/radar-backtest-engine.mjs';
import { HISTORICAL_MARKET_DATA_SCHEMA_VERSION } from '../scripts/radar/historical-data-contract.mjs';
import { RADAR_TRADE_INTENT_CANDIDATE_FIXTURES, RADAR_TRADE_INTENT_REPLAY_CLOCK_MS } from './fixtures/radar-trade-intent-candidates.mjs';

function dataset(overrides = {}) { return { schemaVersion: HISTORICAL_MARKET_DATA_SCHEMA_VERSION, datasetVersion: 'backtest-fixture-v2', provenance: { provider: 'fixture-provider', venue: 'fixture-venue', product: 'spot', quote: 'USDT', symbol: 'SOL/USDT', sourceType: 'historical-export', sourceUrl: 'https://fixtures.invalid/backtest', fetchedAt: '2026-07-24T12:00:00.000Z', importedAt: '2026-07-24T12:01:00.000Z' }, interval: '1h', range: { start: '2026-07-24T12:00:00.000Z', end: '2026-07-24T16:00:00.000Z', timezone: 'UTC' }, candles: [ { openTime: '2026-07-24T12:00:00.000Z', closeTime: '2026-07-24T13:00:00.000Z', open: 140, high: 141, low: 139, close: 140, volume: 1000, sourceStatus: 'AVAILABLE' }, { openTime: '2026-07-24T13:00:00.000Z', closeTime: '2026-07-24T14:00:00.000Z', open: 140, high: 146, low: 139, close: 145, volume: 1000, sourceStatus: 'AVAILABLE' }, { openTime: '2026-07-24T14:00:00.000Z', closeTime: '2026-07-24T15:00:00.000Z', open: 140, high: 141, low: 139, close: 140, volume: 1000, sourceStatus: 'AVAILABLE' }, { openTime: '2026-07-24T15:00:00.000Z', closeTime: '2026-07-24T16:00:00.000Z', open: 140, high: 146, low: 139, close: 145, volume: 1000, sourceStatus: 'AVAILABLE' } ], gaps: [], corrections: [], depth: { status: 'UNKNOWN' }, ...overrides }; }
function input(overrides = {}) { return { dataset: dataset(), candidateFixture: RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0], mode: 'spot', quote: 'USDT', clockMs: RADAR_TRADE_INTENT_REPLAY_CLOCK_MS, quoteBalances: { USDT: 1000, USDC: 500 }, sizing: { model: 'fixedNotional', fixedNotional: 100 }, riskLimits: { maxExposurePerTrade: 200, maxRealRiskAtStop: 20, maxOpenPositions: 2, maxDailyLoss: 100 }, closeAtDatasetEnd: true, ...overrides }; }
function types(r) { return r.events.map((e) => e.type); }

test('fixed notional and percent-equity sizing are deterministic', () => { const fixed = runRadarBacktest(input()); assert.equal(fixed.positions[0].notional, 100); const pct = runRadarBacktest(input({ sizing: { model: 'percentEquity', percentEquity: 0.1 } })); assert.equal(pct.positions[0].notional, 100); assert.deepEqual(fixed, runRadarBacktest(input())); });
test('risk-at-stop sizing and missing stop rejection are explicit', () => { const risk = runRadarBacktest(input({ sizing: { model: 'riskAtStopPercentEquity', riskAtStopPercentEquity: 0.01 }, riskLimits: { ...input().riskLimits, maxExposurePerTrade: 500 } })); assert.ok(risk.positions[0].realRisk <= 10.000001); const missing = runRadarBacktest(input({ candidateFixture: { ...RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0], candidate: { ...RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0].candidate, invalidationLevel: undefined, HARD_INVALIDATION: undefined, STOP_LOSS_LEVEL: undefined } }, sizing: { model: 'riskAtStopPercentEquity', riskAtStopPercentEquity: 0.01 } })); assert.equal(missing.positions.length, 0); assert.ok(missing.riskDecisions[0].reasonCodes.includes('missing_stop')); });
test('exposure, open-position, and daily-loss limits veto deterministically', () => { assert.ok(runRadarBacktest(input({ riskLimits: { ...input().riskLimits, maxExposurePerTrade: 50 } })).riskDecisions[0].reasonCodes.includes('max_exposure_exceeded')); const nonExiting = dataset({ candles: dataset().candles.map((candle) => ({ ...candle, high: 144, low: 139, close: 142 })) }); const open = runRadarBacktest(input({ dataset: nonExiting, closeAtDatasetEnd: false, tradePlans: [{ candidateFixture: RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0], entryCandleIndex: 0 }, { candidateFixture: RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0], entryCandleIndex: 1 }], riskLimits: { ...input().riskLimits, maxOpenPositions: 1 } })); assert.ok(open.riskDecisions.some((d) => d.reasonCodes.includes('max_open_positions_exceeded'))); const daily = runRadarBacktest(input({ dailyRealizedPnl: { USDT: -99 }, riskLimits: { ...input().riskLimits, maxDailyLoss: 100 } })); assert.ok(daily.riskDecisions[0].reasonCodes.includes('max_daily_loss_exceeded')); });
test('USDT and USDC ledgers stay separated and unknown balance rejects', () => { const usdc = runRadarBacktest(input({ dataset: dataset({ provenance: { ...dataset().provenance, quote: 'USDC', symbol: 'SOL/USDC' } }), quote: 'USDC' })); assert.equal(usdc.quoteLedgers.USDT.initialBalance, 1000); assert.equal(usdc.quoteLedgers.USDC.initialBalance, 500); assert.equal(runRadarBacktest(input({ quoteBalances: { USDC: 500 } })).ok, false); });
test('costs reduce net result and conservative intrabar stop-first is recorded', () => { const free = runRadarBacktest(input()); const costly = runRadarBacktest(input({ costAssumptions: { makerFeeBps: 0, takerFeeBps: 20, slippageBps: 10, spreadBps: 10 } })); assert.ok(costly.summary.netPnl < free.summary.netPnl); const both = runRadarBacktest(input({ dataset: dataset({ candles: [dataset().candles[0], { ...dataset().candles[1], high: 146, low: 134, close: 140 }, ...dataset().candles.slice(2)] }) })); assert.ok(types(both).includes('simulated_stop')); assert.ok(both.warnings.includes('ambiguous_intrabar_stop_first')); });
test('sequential positions account realized PnL and dataset-end unrealized PnL', () => { const sequential = runRadarBacktest(input({ tradePlans: [{ candidateFixture: RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0], entryCandleIndex: 0 }, { candidateFixture: RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0], entryCandleIndex: 2 }] })); assert.equal(sequential.positions.length, 2); assert.equal(sequential.summary.trades, 2); assert.ok(sequential.equityCurve.length >= 1); const open = runRadarBacktest(input({ closeAtDatasetEnd: false, dataset: dataset({ candles: [dataset().candles[0], { ...dataset().candles[1], high: 144, low: 139, close: 142 }] }) })); assert.equal(open.summary.openPositions, 1); assert.notEqual(open.quoteLedgers.USDT.unrealizedPnl, 0); });
test('futures is isolated 1x, rejects leverage above 2x, and applies funding', () => { const futureData = dataset({ provenance: { ...dataset().provenance, product: 'futures' }, futures: { status: 'AVAILABLE', fundingRate: 0.01, markPrice: 140, indexPrice: 140, leverageMarginAssumptions: { maxLeverage: 2, marginMode: 'isolated' }, liquidationDistance: { status: 'UNKNOWN' } } }); const future = runRadarBacktest(input({ dataset: futureData, mode: 'futures' })); assert.equal(future.assumptions.leverage, 1); assert.equal(future.assumptions.marginMode, 'isolated'); assert.ok(future.quoteLedgers.USDT.fundingFees > 0); assert.equal(runRadarBacktest(input({ dataset: futureData, mode: 'futures', leverage: 3 })).ok, false); });
test('engine imports only local validation modules and has no external client behavior', () => { const source = fs.readFileSync(new URL('../scripts/radar/radar-backtest-engine.mjs', import.meta.url), 'utf8'); const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]); assert.deepEqual(imports, ['./trade-intent-candidate-validation.mjs', './historical-data-contract.mjs']); assert.doesNotMatch(source, /\bfetch\s*\(/i); assert.doesNotMatch(source, /kucoin|binance|telegram|worker|placeorder|submitorder/i); });

// ── price-domain invariant (regression: a fixture replayed on another market) ──
// Audit 2026-08-01: the public-candle backtest MVP replayed a candidate captured on
// SOL/USDT (stop 135, target 145) against BTC-USDT candles. The engine entered at the
// BTC candle price (73,939) and exited at the fixture's target (144.89), reporting
// "simulated_take_profit" with net PnL -499.52 on a 500 notional — a 99.9% loss
// labelled a take profit, because entry and levels came from two price domains.

function priceShifted(base) {
  // The default fixture dataset trades at ~140. Rebuild it at another scale, keeping
  // every contract field identical so only the PRICE DOMAIN differs.
  const scaled = dataset().candles.map((c) => ({ ...c, open: base, high: base * 1.01, low: base * 0.99, close: base }));
  return dataset({ candles: scaled });
}
function withLevels(stop, target) {
  const base = RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0];
  // The candidate contract requires an entry zone, a stop and at least three take
  // profit levels, so a level override must keep that shape — only the DOMAIN changes.
  return { ...base, candidate: { ...base.candidate, HARD_INVALIDATION: stop, TAKE_PROFIT_LEVELS: [{ level: target }, { level: target * 1.02 }, { level: target * 1.04 }] } };
}

test('levelDomainReasons rejects levels that do not bracket the entry', () => {
  const band = { low: 50, high: 150 };
  assert.deepEqual(levelDomainReasons(100, 95, 110, band), []);
  assert.ok(levelDomainReasons(100, 105, 110, band).includes('levels_not_bracketing_entry'), 'stop above entry');
  assert.ok(levelDomainReasons(100, 95, 90, band).includes('levels_not_bracketing_entry'), 'target below entry');
  assert.ok(levelDomainReasons(100, 95, 400, band).includes('levels_outside_market_range'), 'target far outside the traded band');
  assert.deepEqual(levelDomainReasons(0, 95, 110, band), ['unknown_state']);
});

test('a candidate from another price domain is vetoed, never simulated', () => {
  // The exact production case: ~140-scale levels against a ~73,900-scale market.
  const out = runRadarBacktest(input({ dataset: priceShifted(73900) }));
  assert.equal(out.ok, true, 'the run itself completes');
  assert.equal(out.summary.trades, 0, 'no position was opened');
  assert.equal(out.summary.netPnl, 0, 'and therefore no PnL was invented');
  const veto = out.riskDecisions.find((d) => d.decision === 'vetoed');
  assert.ok(veto, 'the plan was vetoed');
  assert.ok(veto.reasonCodes.includes('levels_not_bracketing_entry'));
  assert.ok(veto.reasonCodes.includes('levels_outside_market_range'));
  assert.ok(!types(out).includes('simulated_take_profit'), 'no take-profit event');
  assert.ok(!types(out).includes('simulated_entry'), 'no entry event');
});

test('the mirrored mismatch (levels far above the market) is vetoed too', () => {
  const out = runRadarBacktest(input({ candidateFixture: withLevels(60000, 70000) }));
  assert.equal(out.summary.trades, 0);
  const veto = out.riskDecisions.find((d) => d.decision === 'vetoed');
  assert.ok(veto.reasonCodes.includes('levels_not_bracketing_entry'));
  assert.ok(veto.reasonCodes.includes('levels_outside_market_range'));
});

test('a same-domain candidate still trades normally', () => {
  const out = runRadarBacktest(input());
  assert.equal(out.summary.trades, 1, 'the invariant does not block a legitimate plan');
  assert.ok(types(out).includes('simulated_entry'));
  assert.ok(out.riskDecisions.some((d) => d.decision === 'approved'));
});

test('win rate is measured over CLOSED trades, not opened ones', () => {
  // Levels wide enough that neither is touched by the fixture candles (139-146).
  const out = runRadarBacktest(input({ candidateFixture: withLevels(130, 200), closeAtDatasetEnd: false }));
  assert.equal(out.summary.trades, 1);
  assert.equal(out.summary.openPositions, 1);
  assert.equal(out.summary.closedTrades, 0);
  assert.equal(out.summary.winRate, 0, 'an open position is not a loss');
  assert.equal(out.summary.wins + out.summary.losses, 0, 'and is counted in neither column');
});
