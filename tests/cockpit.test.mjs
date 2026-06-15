// Trade Tracker Cockpit engine — active trade manager behaviour.
// (scripts/cockpit/trade-cockpit.mjs is the tested reference the frontend mirrors.)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateTradeCockpit,
  summarizeCockpit,
  detectTpHits,
  buildCockpitAlerts,
  prefillFromRadarCandidate,
  COCKPIT_ACTIONS,
} from '../scripts/cockpit/trade-cockpit.mjs';

const full = (over = {}) => ({
  currentPrice: 19.86, change1hPct: 1, change4hPct: 3, spreadPct: 0.05,
  bidDepthRebuildPct: 12, buyVolumeDominance: 0.6, fundingRate: 0.01, openInterestChangePct: 4, ...over,
});

test('PnL math is correct (USD and %) on full data', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18.42, quantity: 2000, stopLoss: 18.05, tp1: 21, tp2: 23, tp3: 25, entryTime: new Date().toISOString() },
    full(), { score: 70 },
  );
  assert.equal(r.pnlPct, 7.82);
  assert.equal(r.unrealizedPnlUsd, 2880);
  assert.equal(r.positionValue, 39720);
});

test('scanner current price drives PnL; no live price never fakes PnL', () => {
  const tracked = { symbol: 'INJUSDT', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20, tp2: 22, tp3: 25 };
  const live = evaluateTradeCockpit(tracked, full({ currentPrice: 19 }), { score: 70 });
  assert.equal(live.pnlPct, 5.56);
  assert.equal(live.unrealizedPnlUsd, 100);

  const noPrice = evaluateTradeCockpit(tracked, {}, { score: 70 }); // not in scanner universe
  assert.equal(noPrice.status, 'NO_LIVE_PRICE');
  assert.equal(noPrice.action, COCKPIT_ACTIONS.NO_LIVE_PRICE);
  assert.equal(noPrice.priceUnavailable, true);
  assert.equal(noPrice.pnlPct, null);
  assert.equal(noPrice.unrealizedPnlUsd, null);
  assert.equal(noPrice.current, null);
});

test('missing microstructure → N/A mini-scores + lowConfidence (never fabricated)', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20 },
    { currentPrice: 18.5, change1hPct: 1, change4hPct: 2 }, { score: 70 },
  );
  assert.equal(r.scores.orderBook, null);
  assert.equal(r.scores.flow, null);
  assert.equal(r.scores.derivatives, null);
  assert.equal(r.lowConfidence, true);
  assert.equal(typeof r.tradeHealthScore, 'number');
});

test('TP1 hit → TAKE_PARTIAL', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20, tp2: 23, tp3: 26 },
    full({ currentPrice: 20.5 }), { score: 70 },
  );
  assert.equal(r.tpHits.tp1, true);
  assert.equal(r.tpHits.tp2, false);
  assert.equal(r.action, COCKPIT_ACTIONS.TAKE_PARTIAL);
});

test('TP2 hit → TAKE_MORE (move stop)', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20, tp2: 23, tp3: 26 },
    full({ currentPrice: 23.5 }), { score: 70 },
  );
  assert.equal(r.tpHits.tp2, true);
  assert.ok([COCKPIT_ACTIONS.TAKE_MORE, COCKPIT_ACTIONS.MOVE_STOP].includes(r.action));
});

test('TP3 hit → EXIT (take most / runner)', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20, tp2: 23, tp3: 26 },
    full({ currentPrice: 26.5 }), { score: 70 },
  );
  assert.equal(r.tpHits.tp3, true);
  assert.equal(r.action, COCKPIT_ACTIONS.EXIT);
});

test('stop hit → EXIT + stopHit flag', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'WLDUSDT', entryPrice: 1.42, quantity: 12000, stopLoss: 1.38, tp1: 1.6 },
    full({ currentPrice: 1.37 }), { score: 60 },
  );
  assert.equal(r.action, COCKPIT_ACTIONS.EXIT);
  assert.equal(r.stopHit, true);
  assert.ok(r.tradeHealthScore <= 20);
});

test('near stop → REDUCE_RISK', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18, quantity: 100, stopLoss: 19.7, tp1: 25, tp2: 28, tp3: 30 },
    full({ currentPrice: 19.86 }), { score: 70 },
  );
  assert.equal(r.action, COCKPIT_ACTIONS.REDUCE_RISK);
});

test('profit + fading momentum → PROTECT_PROFIT', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18, quantity: 100, stopLoss: 16, tp1: 30, tp2: 35, tp3: 40 },
    { currentPrice: 19.5, change1hPct: -1, change4hPct: -2, spreadPct: 0.05, bidDepthRebuildPct: 1, buyVolumeDominance: 0.4, positiveDeltaNoAdvance: true, fundingRate: 0.02, openInterestChangePct: 2 },
    { score: 60 },
  );
  assert.equal(r.action, COCKPIT_ACTIONS.PROTECT_PROFIT);
});

test('missing TP/SL → INCOMPLETE_SETUP', () => {
  const noStop = evaluateTradeCockpit({ symbol: 'ARBUSDT', entryPrice: 0.812, quantity: 40000, tp1: 1 }, full({ currentPrice: 0.9 }), { score: 61 });
  assert.equal(noStop.status, 'INCOMPLETE_SETUP');
  assert.equal(noStop.action, COCKPIT_ACTIONS.INCOMPLETE_SETUP);

  const noTp = evaluateTradeCockpit({ symbol: 'ARBUSDT', entryPrice: 0.812, quantity: 40000, stopLoss: 0.78 }, full({ currentPrice: 0.9 }), { score: 61 });
  assert.equal(noTp.status, 'INCOMPLETE_SETUP');
});

test('realized PnL from partial exits is tracked (total = realized + remaining unrealized)', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20, tp2: 23, tp3: 26, partials: [{ fraction: 0.5, price: 20 }] },
    full({ currentPrice: 22 }), { score: 70 },
  );
  // 50% sold at 20 → realized = 0.5*100*(20-18) = 100
  assert.equal(r.realizedPnl, 100);
  // remaining 50% at 22 → unrealized = 0.5*100*(22-18) = 200
  assert.equal(r.unrealizedPnlUsd, 200);
  assert.equal(r.totalPnl, 300);
  assert.equal(r.remainingFraction, 0.5);
});

test('detectTpHits merges persisted hits with live price', () => {
  const hits = detectTpHits({ tp1: 20, tp2: 23, tp3: 26, tpHits: { tp1: true } }, 21);
  assert.equal(hits.tp1, true); // persisted
  assert.equal(hits.tp2, false);
  const live = detectTpHits({ tp1: 20, tp2: 23, tp3: 26 }, 24);
  assert.equal(live.tp1, true);
  assert.equal(live.tp2, true);
  assert.equal(live.tp3, false);
});

test('buildCockpitAlerts emits TP/stop events on transition only', () => {
  const evalr = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20, tp2: 23, tp3: 26 },
    full({ currentPrice: 20.5 }), { score: 70 },
  );
  const first = buildCockpitAlerts(evalr, {});
  assert.ok(first.some((a) => a.type === 'TP1_HIT'));
  // no duplicate once already known
  const again = buildCockpitAlerts(evalr, { tpHits: { tp1: true } });
  assert.equal(again.some((a) => a.type === 'TP1_HIT'), false);
});

test('prefillFromRadarCandidate maps entry zone / stop / invalidation / TP from RADAR', () => {
  const candidate = {
    symbol: 'SOLUSDT', STATUS: 'STANDARD_ENTRY_READY', FINAL_CONFIDENCE: 74,
    entryZone: { low: 100, high: 110 }, STOP_LOSS_LEVEL: 92, HARD_INVALIDATION: 88,
    TAKE_PROFIT_LEVELS: [{ label: 'TP1', level: 120 }, { label: 'TP2', level: 135 }, { label: 'TP3', level: 150 }],
    safetyStatus: 'UNKNOWN', REASON: ['reclaim held', 'flush confirmed'],
  };
  const t = prefillFromRadarCandidate(candidate);
  assert.equal(t.symbol, 'SOLUSDT');
  assert.equal(t.entryPrice, 105); // midpoint of zone
  assert.equal(t.stopLoss, 92);
  assert.equal(t.hardInvalidation, 88);
  assert.equal(t.tp1, 120);
  assert.equal(t.tp3, 150);
  assert.equal(t.fromRadar, true);
  assert.equal(t.safetyStatus, 'UNKNOWN');
});

test('summary reports health, needs-action, winner/risk, stale and no-price counts', () => {
  const a = evaluateTradeCockpit({ symbol: 'AUSDT', entryPrice: 10, quantity: 100, stopLoss: 9, tp1: 12, tp2: 14, tp3: 16 }, full({ currentPrice: 12.5 }), { score: 70 });
  const b = evaluateTradeCockpit({ symbol: 'BUSDT', entryPrice: 10, quantity: 100, stopLoss: 9.9, tp1: 20 }, full({ currentPrice: 9.85 }), { score: 70 }); // stop hit
  const c = evaluateTradeCockpit({ symbol: 'CUSDT', entryPrice: 10, quantity: 100, stopLoss: 9, tp1: 12 }, {}, { score: 70 }); // no price
  const s = summarizeCockpit([a, b, c]);
  assert.equal(s.openTrades, 3);
  assert.equal(s.noPriceCount, 1);
  assert.ok(s.needsActionCount >= 2);
  assert.notEqual(s.biggestRisk, 'CUSDT'); // no-price not ranked
  assert.equal(typeof s.averageHealth, 'number');
});
