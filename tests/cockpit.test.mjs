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
  validateSetup,
  buildReviewChecklist,
  summarizeFundingContext,
  REVIEW_CARD_KEYS,
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
  // Valid long: stop BELOW entry, current just above the stop (danger zone).
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 21, quantity: 100, stopLoss: 19.7, tp1: 25, tp2: 28, tp3: 30 },
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

// ── Phase 1: live-trade validation safety ──────────────────────────────────

test('KITE regression: long with stop above entry → INVALID_SETUP, no stop/TP/EXIT verdict', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'KITEUSDT', side: 'long', entryPrice: 0.1084, quantity: 10000, stopLoss: 0.8900, tp1: 0.1980, tp2: 0.2390, tp3: 0.2560 },
    full({ currentPrice: 0.1059 }), { score: 70 },
  );
  assert.equal(r.status, 'INVALID_SETUP');
  assert.equal(r.action, COCKPIT_ACTIONS.MANUAL_REVIEW);
  assert.equal(r.stopHit, false);
  assert.notEqual(r.status, 'EXIT_ALL');
  assert.equal(r.tpHits.tp1, false);
  assert.equal(r.tpHits.tp2, false);
  assert.equal(r.tpHits.tp3, false);
  assert.match(r.reason.join(' '), /stop must be below entry/i);
  // No hard-exit / TP alerts must be produced for an invalid setup.
  const alerts = buildCockpitAlerts(r, {});
  assert.equal(alerts.some((a) => a.type === 'STOP_HIT'), false);
  assert.equal(alerts.some((a) => /TP\d_HIT/.test(a.type)), false);
});

test('long with a TP below entry → INVALID_SETUP', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'ARBUSDT', side: 'long', entryPrice: 1, quantity: 100, stopLoss: 0.9, tp1: 0.8 },
    full({ currentPrice: 0.95 }), { score: 70 },
  );
  assert.equal(r.status, 'INVALID_SETUP');
  assert.match(r.reason.join(' '), /TP1 must be above entry/i);
});

test('valid long stop still hard-exits when current <= stop', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', side: 'long', entryPrice: 20, quantity: 100, stopLoss: 19, tp1: 24 },
    full({ currentPrice: 18.9 }), { score: 60 },
  );
  assert.equal(r.status, 'EXIT_ALL');
  assert.equal(r.stopHit, true);
  assert.equal(r.action, COCKPIT_ACTIONS.EXIT);
});

test('valid long TP hit only when current >= TP', () => {
  const below = evaluateTradeCockpit(
    { symbol: 'INJUSDT', side: 'long', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20 },
    full({ currentPrice: 19.5 }), { score: 70 },
  );
  assert.equal(below.tpHits.tp1, false);
  const at = evaluateTradeCockpit(
    { symbol: 'INJUSDT', side: 'long', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20 },
    full({ currentPrice: 20 }), { score: 70 },
  );
  assert.equal(at.tpHits.tp1, true);
});

test('persisted tpHits go stale after the TP level is edited', () => {
  // Recorded a hit at old level 20; the level was later edited up to 25 and price
  // is below the new level → the stale hit must NOT count and must not alert.
  const trade = {
    symbol: 'INJUSDT', side: 'long', entryPrice: 18, quantity: 100, stopLoss: 17,
    tp1: 25, tp2: 28, tp3: 30, tpHits: { tp1: { price: 20, at: '2026-01-01T00:00:00Z' } },
  };
  const r = evaluateTradeCockpit(trade, full({ currentPrice: 22 }), { score: 70 });
  assert.equal(r.tpHits.tp1, false);
  const alerts = buildCockpitAlerts(r, {});
  assert.equal(alerts.some((a) => a.type === 'TP1_HIT'), false);
});

test('reload simulation: an already-alerted state does not re-emit STOP/TP alerts', () => {
  const trade = { symbol: 'INJUSDT', side: 'long', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20, tp2: 23, tp3: 26 };
  const r = evaluateTradeCockpit(trade, full({ currentPrice: 20.5 }), { score: 70 });
  // First observation emits TP1.
  const first = buildCockpitAlerts(r, {});
  assert.ok(first.some((a) => a.type === 'TP1_HIT'));
  // Persisted last-alerted snapshot (what the frontend now stores on the trade).
  const persistedPrev = { tpHits: { ...r.tpHits }, status: r.status, stopHit: r.stopHit, safetyStatus: r.safetyStatus };
  const afterReload = buildCockpitAlerts(r, persistedPrev);
  assert.equal(afterReload.some((a) => a.type === 'TP1_HIT'), false);
  assert.equal(afterReload.some((a) => a.type === 'STOP_HIT'), false);
});

test('all microstructure missing + weak health → no score-driven EXIT_ALL (manual review)', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', side: 'long', entryPrice: 100, quantity: 10, stopLoss: 80, tp1: 120 },
    { currentPrice: 92, change1hPct: -2, change4hPct: -3, vwapLost: true, reclaimLost: true }, // no book/flow/deriv
    { score: 30 },
  );
  assert.equal(r.lowConfidence, true);
  assert.equal(r.scores.orderBook, null);
  assert.equal(r.scores.flow, null);
  assert.equal(r.scores.derivatives, null);
  assert.notEqual(r.status, 'EXIT_ALL');
  assert.equal(r.status, 'MANUAL_REVIEW');
});

test('explicit short → INVALID_SETUP / manual review (no long-math verdict yet)', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', side: 'short', entryPrice: 20, quantity: 100, stopLoss: 22, tp1: 16 },
    full({ currentPrice: 21 }), { score: 70 },
  );
  assert.equal(r.status, 'INVALID_SETUP');
  assert.equal(r.action, COCKPIT_ACTIONS.MANUAL_REVIEW);
  assert.equal(r.stopHit, false);
  assert.match(r.reason.join(' '), /short/i);
});

test('validateSetup: long geometry rules and short gating', () => {
  assert.equal(validateSetup('long', 10, 9, [12, 14]).valid, true);
  assert.equal(validateSetup('long', 10, 11, [12]).valid, false);
  assert.equal(validateSetup('long', 10, 9, [8]).valid, false);
  assert.equal(validateSetup('short', 10, 12, [8]).valid, false);
  assert.equal(validateSetup(undefined, 10, 9, [12]).valid, true); // missing side defaults long
});

// ── M1: manual-review checklist + funding context (presentation only) ───────

const evalWith = (marketOver = {}, tradeOver = {}, regime = { score: 70 }) => evaluateTradeCockpit(
  { symbol: 'INJUSDT', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20, tp2: 23, tp3: 26, ...tradeOver },
  full(marketOver), regime,
);

test('buildReviewChecklist returns exactly the 8 cards in fixed order', () => {
  const r = evalWith();
  const model = buildReviewChecklist(r, full(), {});
  assert.equal(model.contextOnly, true);
  assert.equal(model.cards.length, 8);
  assert.deepEqual(model.cards.map((c) => c.key), REVIEW_CARD_KEYS);
});

test('buildReviewChecklist shows real values on full data + SAFE, no manual review', () => {
  const r = evalWith({}, { safetyStatus: 'SAFE' });
  const model = buildReviewChecklist(r, full(), {});
  const byKey = Object.fromEntries(model.cards.map((c) => [c.key, c]));
  for (const k of ['structure', 'flow', 'funding', 'oi', 'orderbook', 'regime']) {
    assert.equal(byKey[k].status, 'ok', `${k} should be ok on full data`);
    assert.ok(byKey[k].value, `${k} should carry a value`);
  }
  assert.equal(byKey.safety.status, 'ok');
  assert.equal(byKey.safety.value, 'SAFE');
  assert.equal(model.manualReview, false);
});

test('buildReviewChecklist shows honest N/A labels when data missing (no fabrication)', () => {
  // Only price + momentum present; book/flow/deriv/funding/oi absent.
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20 },
    { currentPrice: 18.5, change1hPct: 1, change4hPct: 2 }, {},
  );
  const model = buildReviewChecklist(r, { currentPrice: 18.5, change1hPct: 1, change4hPct: 2 }, {});
  const byKey = Object.fromEntries(model.cards.map((c) => [c.key, c]));
  assert.equal(byKey.flow.status, 'na');
  assert.equal(byKey.flow.note, 'Flow unavailable');
  assert.equal(byKey.orderbook.note, 'Orderbook unavailable');
  assert.equal(byKey.oi.note, 'OI unavailable');
  assert.equal(byKey.funding.note, 'Funding unavailable');
  assert.equal(byKey.safety.note, 'Safety UNKNOWN blocks alerts');
  assert.equal(byKey.news.note, 'News unavailable/degraded');
  assert.equal(byKey.regime.note, 'Market regime unavailable');
  // No card ever carries a fabricated numeric value when status is na.
  for (const c of model.cards) if (c.status === 'na') assert.equal(c.value == null || c.value === 'UNKNOWN', true);
  assert.equal(model.manualReview, true); // missing flow/orderbook/oi + safety UNKNOWN
});

test('buildReviewChecklist funding uses divergence context (labelled context only) when scored funding absent', () => {
  const r = evaluateTradeCockpit(
    { symbol: 'INJUSDT', entryPrice: 18, quantity: 100, stopLoss: 17, tp1: 20 },
    { currentPrice: 18.5, change1hPct: 1 }, {},
  );
  const model = buildReviewChecklist(r, { currentPrice: 18.5 }, { funding: { funding_pct: -0.012, signal: 'SHORTS_TRAPPED', source: 'funding-divergence' } });
  const funding = model.cards.find((c) => c.key === 'funding');
  assert.equal(funding.status, 'ok');
  assert.equal(funding.note, 'context only');
  assert.match(funding.value, /-0\.012%/);
  assert.match(funding.value, /SHORTS_TRAPPED/);
});

test('buildReviewChecklist is pure and carries no execution/gate fields (cannot exit or unlock alerts)', () => {
  const r = evalWith();
  const before = JSON.parse(JSON.stringify(r));
  const model = buildReviewChecklist(r, full(), {});
  // Does not mutate the evaluation.
  assert.deepEqual(JSON.parse(JSON.stringify(r)), before);
  // No execution verb / gate name anywhere in the model.
  const blob = JSON.stringify(model);
  for (const forbidden of ['EXIT_ALL', 'EMERGENCY_EXIT', 'ENTRY_READY', 'telegram', 'Telegram', 'TAKE_PROFIT', 'HOLD_STRONG']) {
    assert.equal(blob.includes(forbidden), false, `review model must not include ${forbidden}`);
  }
  // The model exposes no top-level action / entryReady / telegram driver; the only
  // per-card `status` is the presence flag ('ok' | 'na'), never an execution verb.
  for (const k of ['action', 'entryReady', 'telegram']) assert.equal(k in model, false);
  for (const c of model.cards) {
    for (const k of ['action', 'entryReady', 'telegram']) assert.equal(k in c, false);
    assert.ok(c.status === 'ok' || c.status === 'na', 'card.status is a presence flag only');
  }
});

test('summarizeFundingContext groups extremes + states as context only (no signal/action field)', () => {
  const signals = [
    { symbol: 'AAA', funding_pct: 0.05, price_change_24h_pct: 0.3, signal: 'CROWDED_LONG', bias: 'bearish' },
    { symbol: 'BBB', funding_pct: 0.021, price_change_24h_pct: -4, signal: 'LONGS_TRAPPED', bias: 'bearish' },
    { symbol: 'CCC', funding_pct: -0.008, price_change_24h_pct: 5, signal: 'SHORTS_TRAPPED', bias: 'bullish' },
    { symbol: 'DDD', funding_pct: 0.001, price_change_24h_pct: 1 }, // not extreme, no signal
    { symbol: 'EEE', funding_pct: 'x' }, // invalid → dropped
  ];
  const m = summarizeFundingContext(signals);
  assert.equal(m.contextOnly, true);
  assert.equal(m.source, 'funding-divergence');
  assert.equal(m.count, 4); // EEE dropped
  assert.equal(m.states.CROWDED_LONG, 1);
  assert.equal(m.states.LONGS_TRAPPED, 1);
  assert.equal(m.states.SHORTS_TRAPPED, 1);
  assert.deepEqual(m.extremePositive.map((r) => r.symbol), ['AAA']); // >= +0.03; BBB(0.021) excluded
  assert.deepEqual(m.extremeNegative.map((r) => r.symbol), ['CCC']); // <= -0.005
  assert.equal('action' in m, false);
  assert.equal('signal' in m, false);
});

test('summarizeFundingContext tolerates junk input', () => {
  assert.equal(summarizeFundingContext().count, 0);
  assert.equal(summarizeFundingContext(null).count, 0);
  assert.equal(summarizeFundingContext([null, 1, 'x', {}]).count, 0);
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
