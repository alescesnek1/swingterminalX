// Positioning context — context-only OI / long-short read-model. Pure helper
// guard tests: honest unavailable states, transparent thresholds, no forbidden
// wording, no fetch/env/side effects, no gate/telegram/execution semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildPositioningContext,
  OI_FLAT_BAND_PCT,
  LS_CROWDED_LONG_RATIO,
  LS_CROWDED_SHORT_RATIO,
  POSITIONING_STALE_TTL_MS,
} from '../scripts/radar/positioning-context.mjs';

const SRC = fs.readFileSync(new URL('../scripts/radar/positioning-context.mjs', import.meta.url), 'utf8');

const NOW = 1_700_000_000_000;
const FRESH = NOW - 60_000;

test('rising OI with rising price is supporting context only', () => {
  const r = buildPositioningContext({
    symbol: 'SPELLUSDT', openInterestChangePct: 4.2, priceChangePct: 1.8,
    updatedAtMs: FRESH, nowMs: NOW,
  });
  assert.equal(r.contextOnly, true);
  assert.equal(r.available, true);
  assert.equal(r.stale, false);
  assert.equal(r.openInterest.trend, 'rising');
  assert.equal(r.openInterest.changePct, 4.2);
  assert.equal(r.openInterest.label, 'OI rising with price up');
  // no action-like fields anywhere
  for (const k of ['action', 'signal', 'entryReady', 'score', 'telegram', 'buy', 'sell']) {
    assert.equal(k in r, false, `must not expose field ${k}`);
  }
});

test('falling OI is caution/supporting context only', () => {
  const r = buildPositioningContext({ openInterestChangePct: -6.5, priceChangePct: -2, updatedAtMs: FRESH, nowMs: NOW });
  assert.equal(r.available, true);
  assert.equal(r.openInterest.trend, 'falling');
  assert.equal(r.openInterest.label, 'OI falling with price down');
});

test('small OI change inside the flat band reads flat', () => {
  const r = buildPositioningContext({ openInterestChangePct: OI_FLAT_BAND_PCT / 2, updatedAtMs: FRESH, nowMs: NOW });
  assert.equal(r.openInterest.trend, 'flat');
  assert.equal(r.openInterest.label, 'OI flat');
});

test('crowded long / crowded short classification uses transparent thresholds', () => {
  const long = buildPositioningContext({ openInterestChangePct: 2, globalAccountRatio: LS_CROWDED_LONG_RATIO, updatedAtMs: FRESH, nowMs: NOW });
  assert.equal(long.longShort.interpretation, 'crowded long');
  assert.deepEqual(long.warnings, ['crowded long positioning']);

  const short = buildPositioningContext({ openInterestChangePct: 2, topTraderPositionRatio: LS_CROWDED_SHORT_RATIO, updatedAtMs: FRESH, nowMs: NOW });
  assert.equal(short.longShort.interpretation, 'crowded short');
  assert.deepEqual(short.warnings, ['crowded short positioning']);

  const balanced = buildPositioningContext({ openInterestChangePct: 2, globalAccountRatio: 1.1, updatedAtMs: FRESH, nowMs: NOW });
  assert.equal(balanced.longShort.interpretation, 'balanced');
  assert.deepEqual(balanced.warnings, []);
});

test('missing data returns honest unavailable, never fabricated values', () => {
  const r = buildPositioningContext({ symbol: 'XUSDT', updatedAtMs: FRESH, nowMs: NOW });
  assert.equal(r.available, false);
  assert.equal(r.openInterest.trend, 'unknown');
  assert.equal(r.openInterest.changePct, null);
  assert.equal(r.openInterest.label, 'OI unavailable');
  assert.equal(r.longShort.interpretation, 'unavailable');
  assert.ok(r.missing.includes('openInterestChangePct'));
  assert.ok(r.missing.includes('longShortRatio'));
});

test('stale snapshot returns unavailable with a stale warning', () => {
  const r = buildPositioningContext({
    openInterestChangePct: 9, priceChangePct: 3,
    updatedAtMs: NOW - POSITIONING_STALE_TTL_MS - 1, nowMs: NOW,
  });
  assert.equal(r.stale, true);
  assert.equal(r.available, false);
  assert.equal(r.openInterest.trend, 'unknown');
  assert.equal(r.openInterest.changePct, null);
  assert.deepEqual(r.warnings, ['positioning snapshot stale']);
});

test('long/short unavailable when no ratio producer exists (today)', () => {
  const r = buildPositioningContext({ openInterestChangePct: 3, updatedAtMs: FRESH, nowMs: NOW });
  assert.equal(r.available, true);
  assert.equal(r.longShort.globalAccountRatio, null);
  assert.equal(r.longShort.topTraderPositionRatio, null);
  assert.equal(r.longShort.interpretation, 'unavailable');
  assert.ok(r.missing.includes('longShortRatio'));
});

test('tolerates junk input without throwing', () => {
  for (const junk of [undefined, null, 'x', 42, [], { openInterestChangePct: 'abc', updatedAtMs: 'nope' }]) {
    const r = buildPositioningContext(junk);
    assert.equal(r.contextOnly, true);
    assert.equal(r.available, false);
  }
});

test('output carries no forbidden wording', () => {
  const samples = [
    buildPositioningContext({ openInterestChangePct: 5, priceChangePct: 2, globalAccountRatio: 3, updatedAtMs: FRESH, nowMs: NOW }),
    buildPositioningContext({ openInterestChangePct: -5, topTraderPositionRatio: 0.3, updatedAtMs: FRESH, nowMs: NOW }),
    buildPositioningContext({}),
  ];
  const blob = JSON.stringify(samples).replace(/takerBuySellRatio/g, 'takerRatio').toLowerCase();
  for (const w of ['liquidation heatmap', 'cvd', 'whale order', 'confirmed liquidation', 'guaranteed', 'sure trade', 'free money', 'sentiment', 'buy', 'sell', 'entry_ready', 'telegram']) {
    assert.equal(blob.includes(w), false, `output must not contain "${w}"`);
  }
});

test('module source is pure: no fetch, no env, no side-effectful imports, no gate/telegram/execution refs', () => {
  assert.doesNotMatch(SRC, /\bfetch\s*\(/);
  assert.doesNotMatch(SRC, /process\.env/);
  assert.doesNotMatch(SRC, /\bimport\s/, 'pure helper must import nothing');
  assert.doesNotMatch(SRC, /ENTRY_READY|telegram|execution|signature|apiKey/i);
  // "order-book" appears only in the honest disclaimer wording; no order
  // placement / signed / private endpoint references are allowed.
  assert.doesNotMatch(SRC, /placeOrder|newOrder|\/order|sapi|dapi/i);
  assert.doesNotMatch(SRC, /liquidation heatmap|CVD|whale/i);
});
