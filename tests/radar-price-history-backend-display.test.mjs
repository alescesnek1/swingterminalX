// Pure tests for the BACKEND price-history scoring DISPLAY model — the model
// the RADAR table (Setup cell tag / Absorb+Reclaim tooltips) and the Focus
// Candidate "Backend price-history scoring" block read. This is a DIFFERENT
// source from the advisory frontend read: it shapes the server-owned
// `priceHistoryContext` + score-adjustment fields the trading radar attaches
// to the candidate (the only price-history read that moves SETUP_SCORE).
//
// Guarantees under test:
//   • fail-closed / honest ABSENT when the candidate is not in the top-five
//     price-history-scored set (never rendered as a failure),
//   • reclaim/absorption collapse to CONFIRMED|NOT_CONFIRMED|UNKNOWN only,
//   • the +N setup adjustment is traceable to reclaim(+2)/absorption(+1),
//   • it NEVER claims to affect execution score or Telegram,
//   • no directional (buy/sell/long/short) wording.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  radarBackendPriceHistoryModel,
  radarBackendPriceHistoryAdjustmentBreakdown,
} from '../apps/edge/public/js/price-history-signals-panel.js';

const FORBIDDEN_WORDS = /\b(buy|sell|long|short)\b/i;

function assertNoTradingWords(v) {
  assert.doesNotMatch(JSON.stringify(v), FORBIDDEN_WORDS, `must never contain trading-action wording: ${JSON.stringify(v)}`);
}

// Real production shape for a top-five candidate whose price-history reclaim
// confirmed and added +2 to setup.
const reclaimSupported = {
  symbol: 'ANSEMUSDT',
  SETUP_SCORE: 40,
  EXECUTION_SCORE: 23,
  priceHistoryScoreAdjustment: 2,
  priceHistoryUsedForScoring: true,
  priceHistoryGateSupport: { reclaim: true, absorption: false },
  priceHistoryGateBlockers: ['price-history absorption is not a confirmed medium-confidence history-only proxy'],
  priceHistoryContext: {
    status: 'OK',
    symbol: 'ANSEM',
    points: 20,
    reclaim: { status: 'CONFIRMED', reason: 'reclaimed prior local high and held' },
    absorption: { status: 'NOT_CONFIRMED', mode: 'history_only', confidence: 'low', reason: 'no volume spike' },
    blockers: ['strict rolling absorption unavailable'],
    source: 'price_history_db',
    affectsServerGate: true,
    affectsTelegram: false,
  },
};

// A top-five candidate that was evaluated but added nothing (real live state).
const evaluatedNoSupport = {
  symbol: 'FAIUSDT',
  priceHistoryScoreAdjustment: 0,
  priceHistoryUsedForScoring: false,
  priceHistoryGateSupport: { reclaim: false, absorption: false },
  priceHistoryContext: {
    status: 'OK',
    symbol: 'FAI',
    points: 20,
    reclaim: { status: 'NOT_CONFIRMED', reason: 'price below prior local high' },
    absorption: { status: 'NOT_CONFIRMED', mode: 'history_only', confidence: 'low', reason: 'no volume spike' },
    blockers: [],
    source: 'price_history_db',
    affectsServerGate: false,
    affectsTelegram: false,
  },
};

// A focused candidate outside the top five — the exact production case where
// the focus card followed LITUSDT (#107) which carries no context.
const outsideTopFive = { symbol: 'LITUSDT', SETUP_SCORE: 24, EXECUTION_SCORE: 30 };

test('absent context is honest ABSENT, never a failed reading', () => {
  const m = radarBackendPriceHistoryModel(outsideTopFive);
  assert.equal(m.present, false);
  assert.equal(m.status, 'ABSENT');
  assert.equal(m.adjustment, 0);
  assert.equal(m.usedForScoring, false);
  assert.equal(m.reclaim, 'UNKNOWN');
  assert.equal(m.absorption, 'UNKNOWN');
  assert.match(m.blockers.join(' '), /top-five/i);
  assertNoTradingWords(m);
});

test('confirmed price-history reclaim maps to +2 and CONFIRMED', () => {
  const m = radarBackendPriceHistoryModel(reclaimSupported);
  assert.equal(m.present, true);
  assert.equal(m.status, 'OK');
  assert.equal(m.reclaim, 'CONFIRMED');
  assert.equal(m.gateReclaim, true);
  assert.equal(m.absorption, 'NOT_CONFIRMED');
  assert.equal(m.gateAbsorption, false);
  assert.equal(m.adjustment, 2);
  assert.equal(m.usedForScoring, true);
  assert.equal(m.points, 20);
  assertNoTradingWords(m);
});

test('backend model NEVER claims execution or Telegram effect', () => {
  for (const c of [reclaimSupported, evaluatedNoSupport, outsideTopFive]) {
    const m = radarBackendPriceHistoryModel(c);
    assert.equal(m.affectsExecution, false);
    assert.equal(m.affectsTelegram, false);
    assert.match(m.note, /never affects execution/i);
    assert.match(m.note, /telegram/i);
  }
});

test('adjustment is clamped to 0..3 even on out-of-range input', () => {
  assert.equal(radarBackendPriceHistoryModel({ ...reclaimSupported, priceHistoryScoreAdjustment: 99 }).adjustment, 3);
  assert.equal(radarBackendPriceHistoryModel({ ...reclaimSupported, priceHistoryScoreAdjustment: -5 }).adjustment, 0);
  assert.equal(radarBackendPriceHistoryModel({ ...reclaimSupported, priceHistoryScoreAdjustment: 'x' }).adjustment, 0);
});

test('garbage / null input never throws and stays ABSENT', () => {
  for (const bad of [null, undefined, 42, 'str', {}, { priceHistoryContext: 'nope' }]) {
    const m = radarBackendPriceHistoryModel(bad);
    assert.equal(m.present, false);
    assert.equal(m.adjustment, 0);
  }
});

test('adjustment breakdown traces +N to the exact sources', () => {
  const b = radarBackendPriceHistoryAdjustmentBreakdown(reclaimSupported);
  assert.equal(b.adjustment, 2);
  assert.equal(b.usedForScoring, true);
  assert.deepEqual(b.parts, ['+2 price-history reclaim']);
  assert.match(b.summary, /\+2 setup from price-history/i);
  assert.match(b.summary, /no effect on execution score or telegram/i);
  assertNoTradingWords(b);
});

test('adjustment breakdown for both reclaim + absorption support', () => {
  const both = {
    ...reclaimSupported,
    priceHistoryScoreAdjustment: 3,
    priceHistoryGateSupport: { reclaim: true, absorption: true },
  };
  const b = radarBackendPriceHistoryAdjustmentBreakdown(both);
  assert.equal(b.adjustment, 3);
  assert.deepEqual(b.parts, ['+2 price-history reclaim', '+1 history-only absorption']);
});

test('evaluated-but-no-support breakdown is explicit, not blank', () => {
  const b = radarBackendPriceHistoryAdjustmentBreakdown(evaluatedNoSupport);
  assert.equal(b.adjustment, 0);
  assert.equal(b.present, true);
  assert.match(b.summary, /added nothing to setup/i);
});

test('outside-top-five breakdown says N/A honestly', () => {
  const b = radarBackendPriceHistoryAdjustmentBreakdown(outsideTopFive);
  assert.equal(b.adjustment, 0);
  assert.equal(b.present, false);
  assert.match(b.summary, /top-five/i);
});
