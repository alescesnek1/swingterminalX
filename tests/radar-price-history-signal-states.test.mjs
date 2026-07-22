// Fixture tests proving the price-history reclaim/absorption STATE model
// used by the RADAR-facing diagnostics panel can reach every state,
// including the POSITIVE ones (ACTIVE_RECLAIM, ABSORPTION) — not just
// whatever NO_RECLAIM/NO_ABSORPTION the live market happens to show right
// now. These are deterministic fixtures, independent of live BTC/ETH data.
//
// Pure functions only: no DOM, no fetch, no network.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  priceHistoryReclaimState,
  priceHistoryAbsorptionState,
  radarSignalStateLabel,
  radarSignalStateTone,
  radarBaseSymbolFromPair,
  radarPriceHistorySignalRenderModel,
  radarPriceHistorySignalErrorModel,
} from '../apps/edge/public/js/price-history-signals-panel.js';

const FORBIDDEN_WORDS = /\b(buy|sell|long|short)\b/i;

function apiFixture({ reclaim, absorption, orderbookUsed = false, orderbookReason = 'ORDERBOOK_UNAVAILABLE', points = 20, symbol = 'BTC' } = {}) {
  return {
    ok: true,
    symbol,
    points,
    orderbookUsed,
    orderbookReason,
    orderbookMode: orderbookUsed ? 'server' : 'external_browser_required',
    reclaim: reclaim || { status: 'OK', signal: 'NO_RECLAIM', reason: 'price below prior local high', confidence: 'low' },
    absorption: absorption || { status: 'OK', signal: 'NO_ABSORPTION', reason: 'no volume spike', confidence: 'low' },
  };
}

// ── Reclaim state fixtures ──

test('reclaim: positive fixture (BULLISH_RECLAIM) resolves to ACTIVE_RECLAIM', () => {
  const api = apiFixture({ reclaim: { status: 'OK', signal: 'BULLISH_RECLAIM', reason: 'held above 66680 for 3 points (+1.2%)', confidence: 'high' } });
  const model = radarPriceHistorySignalRenderModel(api);
  assert.equal(model.reclaimState, 'ACTIVE_RECLAIM');
  assert.equal(priceHistoryReclaimState(model), 'ACTIVE_RECLAIM');
});

test('reclaim: neutral NO_RECLAIM fixture resolves to NO_RECLAIM (not an error)', () => {
  const api = apiFixture({ reclaim: { status: 'OK', signal: 'NO_RECLAIM', reason: 'price below prior local high', confidence: 'low' } });
  const model = radarPriceHistorySignalRenderModel(api);
  assert.equal(model.reclaimState, 'NO_RECLAIM');
});

test('reclaim: FAILED_RECLAIM fixture also resolves to NO_RECLAIM (neutral, not broken)', () => {
  const api = apiFixture({ reclaim: { status: 'OK', signal: 'FAILED_RECLAIM', reason: 'broke above level but fell back below it', confidence: 'medium' } });
  const model = radarPriceHistorySignalRenderModel(api);
  assert.equal(model.reclaimState, 'NO_RECLAIM');
});

test('reclaim: INSUFFICIENT_HISTORY fixture is distinct from NO_RECLAIM/UNKNOWN', () => {
  const api = apiFixture({ reclaim: { status: 'INSUFFICIENT_HISTORY', signal: 'UNKNOWN', reason: 'need >= 5 valid points, have 2', confidence: 'low' } });
  const model = radarPriceHistorySignalRenderModel(api);
  assert.equal(model.reclaimState, 'INSUFFICIENT_HISTORY');
});

test('reclaim: unexpected UNKNOWN-with-OK-status fixture falls back to UNKNOWN, never bearish', () => {
  const api = apiFixture({ reclaim: { status: 'OK', signal: 'UNKNOWN', reason: '', confidence: 'low' } });
  const model = radarPriceHistorySignalRenderModel(api);
  assert.equal(model.reclaimState, 'UNKNOWN');
});

test('DB_UNAVAILABLE is a degraded system state with unknown signal states', () => {
  const model = radarPriceHistorySignalRenderModel({ ok: false, reason: 'DB_UNAVAILABLE' }, 'BTC');
  assert.equal(model.status, 'DB_UNAVAILABLE');
  assert.equal(model.reclaimState, 'DB_UNAVAILABLE');
  assert.equal(model.absorptionState, 'DB_UNAVAILABLE');
  assert.equal(radarSignalStateLabel('DB_UNAVAILABLE'), 'Unavailable');
  assert.equal(radarSignalStateTone('DB_UNAVAILABLE'), 'degraded');
  assert.equal(model.reclaim.signal, 'UNKNOWN');
  assert.equal(model.absorption.signal, 'UNKNOWN');
});

test('reclaim: ok:false / malformed response resolves to ERROR, never a directional guess', () => {
  assert.equal(priceHistoryReclaimState(radarPriceHistorySignalRenderModel({ ok: false, reason: 'DB_UNAVAILABLE' })), 'DB_UNAVAILABLE');
  assert.equal(priceHistoryReclaimState(null), 'ERROR');
  assert.equal(priceHistoryReclaimState(undefined), 'ERROR');
});

// ── Absorption state fixtures ──

test('absorption: positive BULLISH_ABSORPTION fixture resolves to ABSORPTION even without a live book', () => {
  const api = apiFixture({
    absorption: { status: 'OK', signal: 'BULLISH_ABSORPTION', reason: 'elevated volume into a prior downtrend while price held', confidence: 'medium' },
    orderbookUsed: false,
  });
  const model = radarPriceHistorySignalRenderModel(api);
  assert.equal(model.absorptionState, 'ABSORPTION');
});

test('absorption: positive BEARISH_ABSORPTION fixture with a live book resolves to ABSORPTION', () => {
  const api = apiFixture({
    absorption: { status: 'OK', signal: 'BEARISH_ABSORPTION', reason: 'elevated volume into a prior uptrend while price stalled', confidence: 'high' },
    orderbookUsed: true,
    orderbookReason: 'OK',
  });
  const model = radarPriceHistorySignalRenderModel(api);
  assert.equal(model.absorptionState, 'ABSORPTION');
});

test('absorption: NO_ABSORPTION with a live book used resolves to plain NO_ABSORPTION, not degraded', () => {
  const api = apiFixture({
    absorption: { status: 'OK', signal: 'NO_ABSORPTION', reason: 'no volume spike', confidence: 'low' },
    orderbookUsed: true,
    orderbookReason: 'OK',
  });
  const model = radarPriceHistorySignalRenderModel(api);
  assert.equal(model.absorptionState, 'NO_ABSORPTION');
});

test('absorption: NO_ABSORPTION with the documented baseline no-book reason resolves to HISTORY_ONLY, not degraded', () => {
  const api = apiFixture({
    absorption: { status: 'OK', signal: 'NO_ABSORPTION', reason: 'no volume spike', confidence: 'low' },
    orderbookUsed: false,
    orderbookReason: 'ORDERBOOK_UNAVAILABLE',
  });
  const model = radarPriceHistorySignalRenderModel(api);
  assert.equal(model.absorptionState, 'HISTORY_ONLY');
});

test('absorption: NO_ABSORPTION with an unexpected orderbook failure reason resolves to ORDERBOOK_DEGRADED', () => {
  for (const reason of ['ORDERBOOK_AUTH_REQUIRED', 'INVALID_ORDERBOOK_PAIR', 'ORDERBOOK_FETCH_FAILED', 'ORDERBOOK_HTTP_500']) {
    const api = apiFixture({
      absorption: { status: 'OK', signal: 'NO_ABSORPTION', reason: 'no volume spike', confidence: 'low' },
      orderbookUsed: false,
      orderbookReason: reason,
    });
    const model = radarPriceHistorySignalRenderModel(api);
    assert.equal(model.absorptionState, 'ORDERBOOK_DEGRADED', `expected ORDERBOOK_DEGRADED for reason ${reason}`);
  }
});

test('absorption: INSUFFICIENT_HISTORY fixture is distinct from HISTORY_ONLY/ORDERBOOK_DEGRADED', () => {
  const api = apiFixture({
    absorption: { status: 'INSUFFICIENT_HISTORY', signal: 'UNKNOWN', reason: 'need >= 8 valid points, have 3', confidence: 'low' },
    orderbookUsed: false,
  });
  const model = radarPriceHistorySignalRenderModel(api);
  assert.equal(model.absorptionState, 'INSUFFICIENT_HISTORY');
});

test('absorption: ok:false / malformed response resolves to ERROR', () => {
  assert.equal(priceHistoryAbsorptionState(radarPriceHistorySignalRenderModel({ ok: false })), 'ERROR');
  assert.equal(priceHistoryAbsorptionState(null), 'ERROR');
});

// ── Full render model + error/malformed paths ──

test('radarPriceHistorySignalRenderModel never throws on malformed input and always resolves both states', () => {
  for (const bad of [null, undefined, {}, [], 42, 'nope', { ok: true, reclaim: 'garbage', absorption: 5 }]) {
    assert.doesNotThrow(() => radarPriceHistorySignalRenderModel(bad));
    const m = radarPriceHistorySignalRenderModel(bad);
    assert.ok(['ACTIVE_RECLAIM', 'NO_RECLAIM', 'INSUFFICIENT_HISTORY', 'UNKNOWN', 'ERROR'].includes(m.reclaimState));
    assert.ok(['ABSORPTION', 'NO_ABSORPTION', 'HISTORY_ONLY', 'ORDERBOOK_DEGRADED', 'INSUFFICIENT_HISTORY', 'UNKNOWN', 'ERROR'].includes(m.absorptionState));
  }
});

test('radarPriceHistorySignalErrorModel defaults to ERROR/ERROR when no kind given', () => {
  const m = radarPriceHistorySignalErrorModel('HTTP 503');
  assert.equal(m.reclaimState, 'ERROR');
  assert.equal(m.absorptionState, 'ERROR');
  assert.equal(m.error, true);
});

test('radarPriceHistorySignalErrorModel stamps a specific transport-error kind on both states', () => {
  for (const kind of ['AUTH_REQUIRED', 'FETCH_ERROR', 'MALFORMED_RESPONSE']) {
    const m = radarPriceHistorySignalErrorModel('msg', kind);
    assert.equal(m.reclaimState, kind);
    assert.equal(m.absorptionState, kind);
    assert.equal(m.error, true);
  }
});

test('an unrecognized error kind falls back to ERROR, never crashes', () => {
  const m = radarPriceHistorySignalErrorModel('msg', 'NONSENSE_KIND');
  assert.equal(m.reclaimState, 'ERROR');
  assert.equal(m.absorptionState, 'ERROR');
});

// ── Tone classification (drives badge colour: positive/neutral/degraded/error/waiting) ──

test('state tones classify severity correctly for the UI', () => {
  assert.equal(radarSignalStateTone('ACTIVE_RECLAIM'), 'positive');
  assert.equal(radarSignalStateTone('ABSORPTION'), 'positive');
  assert.equal(radarSignalStateTone('NO_RECLAIM'), 'neutral');
  assert.equal(radarSignalStateTone('NO_ABSORPTION'), 'neutral');
  assert.equal(radarSignalStateTone('HISTORY_ONLY'), 'degraded');
  assert.equal(radarSignalStateTone('ORDERBOOK_DEGRADED'), 'degraded');
  assert.equal(radarSignalStateTone('ORDERBOOK_UNAVAILABLE'), 'degraded');
  assert.equal(radarSignalStateTone('AUTH_REQUIRED'), 'error');
  assert.equal(radarSignalStateTone('FETCH_ERROR'), 'error');
  assert.equal(radarSignalStateTone('MALFORMED_RESPONSE'), 'error');
  assert.equal(radarSignalStateTone('ERROR'), 'error');
  assert.equal(radarSignalStateTone('INSUFFICIENT_HISTORY'), 'waiting');
  assert.equal(radarSignalStateTone('UNKNOWN'), 'waiting');
});

test('a neutral state is never toned as error/degraded (NO_RECLAIM/NO_ABSORPTION must not look broken)', () => {
  assert.equal(radarSignalStateTone('NO_RECLAIM'), 'neutral');
  assert.equal(radarSignalStateTone('NO_ABSORPTION'), 'neutral');
  assert.notEqual(radarSignalStateTone('NO_RECLAIM'), 'error');
  assert.notEqual(radarSignalStateTone('NO_ABSORPTION'), 'degraded');
});

test('an unknown code tones as waiting, never throws', () => {
  assert.equal(radarSignalStateTone('WHATEVER'), 'waiting');
  assert.equal(radarSignalStateTone(undefined), 'waiting');
});

// ── Pair -> base symbol mapping (the exact bug that made every RADAR query miss) ──

test('radarBaseSymbolFromPair strips the venue quote to the base symbol', () => {
  assert.equal(radarBaseSymbolFromPair('BTCUSDT'), 'BTC');
  assert.equal(radarBaseSymbolFromPair('ETHUSDT'), 'ETH');
  assert.equal(radarBaseSymbolFromPair('ERAUSDC'), 'ERA');
  assert.equal(radarBaseSymbolFromPair('SOLFDUSD'), 'SOL');
});

test('radarBaseSymbolFromPair normalizes case and strips punctuation before matching', () => {
  assert.equal(radarBaseSymbolFromPair('btcusdt'), 'BTC');
  assert.equal(radarBaseSymbolFromPair('BTC/USDT'), 'BTC');
  assert.equal(radarBaseSymbolFromPair(' eth-usdc '), 'ETH');
});

test('radarBaseSymbolFromPair returns a bare base symbol unchanged (DEX tokens), never null-drops it', () => {
  assert.equal(radarBaseSymbolFromPair('PEPE'), 'PEPE');
  assert.equal(radarBaseSymbolFromPair('WIF'), 'WIF');
});

test('radarBaseSymbolFromPair returns null for empty/invalid input, never throws', () => {
  assert.equal(radarBaseSymbolFromPair(''), null);
  assert.equal(radarBaseSymbolFromPair(null), null);
  assert.equal(radarBaseSymbolFromPair(undefined), null);
  assert.equal(radarBaseSymbolFromPair(42), null);
});

test('a base symbol equal to a quote name is not stripped to empty (USDT stays USDT)', () => {
  // "USDT" ends with "USDT" but length is not greater, so it is left as-is
  // rather than reduced to '' — guards the length check.
  assert.equal(radarBaseSymbolFromPair('USDT'), 'USDT');
});

// ── Labels: conservative wording, full coverage, no trading-action words ──

test('every reachable state code has a defined, conservative label', () => {
  const allStates = [
    'ACTIVE_RECLAIM', 'NO_RECLAIM', 'ABSORPTION', 'NO_ABSORPTION', 'HISTORY_ONLY',
    'ORDERBOOK_DEGRADED', 'ORDERBOOK_UNAVAILABLE', 'INSUFFICIENT_HISTORY',
    'AUTH_REQUIRED', 'FETCH_ERROR', 'MALFORMED_RESPONSE', 'DB_UNAVAILABLE', 'UNKNOWN', 'ERROR',
  ];
  for (const code of allStates) {
    const label = radarSignalStateLabel(code);
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 0, `missing label for ${code}`);
    assert.doesNotMatch(label, FORBIDDEN_WORDS, `label for ${code} must not contain trading-action wording: ${label}`);
  }
});

test('transport-error labels read as honest errors, not neutral outcomes', () => {
  assert.match(radarSignalStateLabel('AUTH_REQUIRED'), /sign-in|auth/i);
  assert.match(radarSignalStateLabel('FETCH_ERROR'), /error/i);
  assert.match(radarSignalStateLabel('MALFORMED_RESPONSE'), /malformed/i);
});

test('an unrecognized state code degrades to the Unknown label, never throws', () => {
  assert.equal(radarSignalStateLabel('SOME_FUTURE_CODE'), 'Unknown');
  assert.equal(radarSignalStateLabel(undefined), 'Unknown');
});

test('NO_RECLAIM and NO_ABSORPTION read as neutral labels, not error/broken wording', () => {
  assert.equal(radarSignalStateLabel('NO_RECLAIM'), 'No reclaim');
  assert.equal(radarSignalStateLabel('NO_ABSORPTION'), 'No absorption');
  assert.doesNotMatch(radarSignalStateLabel('NO_RECLAIM'), /error|fail|broken/i);
  assert.doesNotMatch(radarSignalStateLabel('NO_ABSORPTION'), /error|fail|broken/i);
});

test('degraded/unavailable orderbook states read as such, never as a healthy live book', () => {
  assert.match(radarSignalStateLabel('ORDERBOOK_DEGRADED'), /degraded/i);
  assert.match(radarSignalStateLabel('ORDERBOOK_UNAVAILABLE'), /unavailable/i);
  assert.match(radarSignalStateLabel('HISTORY_ONLY'), /history/i);
});
