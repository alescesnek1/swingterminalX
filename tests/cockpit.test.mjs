// Phase 1 honesty guards for the Trade Tracker Cockpit engine
// (scripts/cockpit/trade-cockpit.mjs — the reference the frontend mirrors).
//   - PnL math is correct from entry/qty/current
//   - missing microstructure → mini-scores are null (N/A), health re-normalised,
//     lowConfidence flagged — never fabricated
//   - no live price → NO_LIVE_PRICE, never fall back to entry / fake 0% PnL
//   - hard vetoes still fire
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTradeCockpit, summarizeCockpit } from '../scripts/cockpit/trade-cockpit.mjs';

test('Cockpit PnL math is correct (USD and %)', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18.42, quantity: 2000, stopLoss: 18.05, tp1: 20.2, entryTime: new Date().toISOString() },
    { currentPrice: 19.86, change1hPct: 1, change4hPct: 3 },
    { score: 70 },
  );
  assert.equal(r.pnlPct, 7.82);
  assert.equal(r.pnlUsd, 2880);
  assert.equal(r.positionValue, 39720);
});

test('Cockpit marks mini-scores N/A and flags lowConfidence when microstructure is missing', () => {
  // Only live price + price momentum + regime are available — no order book,
  // flow, or derivatives. Those mini-scores must be null, not fabricated.
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18.42, quantity: 2000, stopLoss: 18.05, tp1: 25 },
    { currentPrice: 19.86, change1hPct: 1, change4hPct: 2 },
    { score: 70 },
  );
  assert.equal(r.scores.orderBook, null);
  assert.equal(r.scores.flow, null);
  assert.equal(r.scores.derivatives, null);
  assert.equal(r.lowConfidence, true);
  assert.deepEqual(r.missingComponents.sort(), ['derivatives', 'flow', 'orderBook']);
  // Health is still produced from the components we genuinely have.
  assert.equal(typeof r.tradeHealthScore, 'number');
  assert.match(r.reason.join(' '), /low-confidence/);
});

test('Cockpit does NOT fabricate microstructure when real data is supplied', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18.42, quantity: 2000, stopLoss: 18.05 },
    { currentPrice: 19.86, change1hPct: 1, change4hPct: 2, spreadPct: 0.05, bidDepthRebuildPct: 12, buyVolumeDominance: 0.6, fundingRate: 0.01, openInterestChangePct: 4 },
    { score: 70 },
  );
  assert.equal(typeof r.scores.orderBook, 'number');
  assert.equal(typeof r.scores.flow, 'number');
  assert.equal(typeof r.scores.derivatives, 'number');
  assert.equal(r.lowConfidence, false);
});

test('Cockpit never falls back to entry price when live price is missing', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'XYZUSDT', entryPrice: 1.5, quantity: 100, stopLoss: 1.4 },
    {}, // no market row → not in scanner universe
    { score: 60 },
  );
  assert.equal(r.status, 'NO_LIVE_PRICE');
  assert.equal(r.priceUnavailable, true);
  assert.equal(r.pnlPct, null);
  assert.equal(r.pnlUsd, null);
  assert.equal(r.positionValue, null);
  assert.equal(r.tradeHealthScore, null);
  assert.match(r.action, /price unavailable/i);
});

test('Cockpit hard vetoes still fire (stop breach, regime disaster)', () => {
  const stopBreach = evaluateTradeCockpit(
    { symbol: 'WLDUSDT', entryPrice: 1.42, quantity: 12000, stopLoss: 1.38 },
    { currentPrice: 1.37 },
    { score: 60 },
  );
  assert.equal(stopBreach.status, 'EXIT_ALL');
  assert.ok(stopBreach.tradeHealthScore <= 20);

  const regimeDisaster = evaluateTradeCockpit(
    { symbol: 'WLDUSDT', entryPrice: 1.42, quantity: 12000, stopLoss: 1.30 },
    { currentPrice: 1.40 },
    { score: 19 },
  );
  assert.ok(['EMERGENCY_EXIT', 'RISK_OFF_EXIT'].includes(regimeDisaster.status));
  assert.ok(regimeDisaster.tradeHealthScore <= 30);
});

test('Cockpit missing stop → MISSING_RISK_DATA and summary excludes no-price rows from ranking', () => {
  const noStop = evaluateTradeCockpit({ symbol: 'ARBUSDT', entryPrice: 0.812, quantity: 40000 }, { currentPrice: 0.895 }, { score: 61 });
  assert.equal(noStop.status, 'MISSING_RISK_DATA');

  const noPrice = evaluateTradeCockpit({ symbol: 'XYZUSDT', entryPrice: 1, quantity: 10, stopLoss: 0.9 }, {}, { score: 60 });
  const summary = summarizeCockpit([noStop, noPrice]);
  assert.equal(summary.openTrades, 2);
  // A no-live-price trade (null health/pnl) must not be ranked as biggest risk/winner.
  assert.notEqual(summary.biggestRisk, 'XYZUSDT');
  assert.notEqual(summary.biggestWinner, 'XYZUSDT');
});
