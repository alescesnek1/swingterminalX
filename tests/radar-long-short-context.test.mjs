// Long/short context — context-only positioning read-model. Pure parser guard
// tests: honest unavailable states, transparent thresholds, latest-row picking,
// no forbidden wording, no fetch/env side effects, no gate/telegram/execution
// semantics, no signed/order/sapi/dapi/signature strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildLongShortContext,
  LS_CROWDED_LONG_RATIO,
  LS_CROWDED_SHORT_RATIO,
  POSITIONING_STALE_TTL_MS,
} from '../scripts/radar/long-short-context.mjs';

const SRC = fs.readFileSync(new URL('../scripts/radar/long-short-context.mjs', import.meta.url), 'utf8');

const NOW = 1_700_000_000_000;
const FRESH = NOW - 60_000;

// Documented Binance /futures/data response row shapes.
const globalRow = (r, ts) => ({ symbol: 'SPELLUSDT', longShortRatio: String(r), longAccount: '0.6', shortAccount: '0.4', timestamp: String(ts) });
const topRow = (r, ts) => ({ symbol: 'SPELLUSDT', longShortRatio: String(r), longAccount: '0.55', shortAccount: '0.45', timestamp: String(ts) });
const takerRow = (r, ts) => ({ buySellRatio: String(r), buyVol: '100', sellVol: '80', timestamp: String(ts) });

test('crowded long classification at/above threshold', () => {
  const r = buildLongShortContext({
    symbol: 'SPELLUSDT', period: '5m', nowMs: NOW,
    globalAccountRatioSeries: [globalRow(LS_CROWDED_LONG_RATIO, FRESH)],
    topTraderPositionRatioSeries: [topRow(3.1, FRESH)],
    takerRatioSeries: [takerRow(1.4, FRESH)],
  });
  assert.equal(r.contextOnly, true);
  assert.equal(r.available, true);
  assert.equal(r.stale, false);
  assert.equal(r.interpretation, 'crowded long');
  assert.deepEqual(r.warnings, ['crowded long positioning']);
  assert.equal(r.globalAccountRatio, LS_CROWDED_LONG_RATIO);
  assert.equal(r.topTraderPositionRatio, 3.1);
  assert.equal(r.takerBuySellRatio, 1.4);
  // no action-like fields anywhere
  for (const k of ['action', 'signal', 'entryReady', 'score', 'telegram', 'buy', 'sell']) {
    assert.equal(k in r, false, `must not expose field ${k}`);
  }
});

test('crowded short classification at/below threshold', () => {
  const r = buildLongShortContext({
    nowMs: NOW,
    globalAccountRatioSeries: [globalRow(LS_CROWDED_SHORT_RATIO, FRESH)],
  });
  assert.equal(r.available, true);
  assert.equal(r.interpretation, 'crowded short');
  assert.deepEqual(r.warnings, ['crowded short positioning']);
});

test('balanced classification between thresholds', () => {
  const r = buildLongShortContext({
    nowMs: NOW,
    globalAccountRatioSeries: [globalRow(1.2, FRESH)],
    topTraderPositionRatioSeries: [topRow(1.0, FRESH)],
  });
  assert.equal(r.interpretation, 'balanced');
  assert.deepEqual(r.warnings, []);
});

test('picks the freshest row by timestamp, not array order', () => {
  const r = buildLongShortContext({
    nowMs: NOW,
    globalAccountRatioSeries: [globalRow(1.0, NOW - 600_000), globalRow(3.0, FRESH), globalRow(0.4, NOW - 300_000)],
  });
  assert.equal(r.globalAccountRatio, 3.0);
  assert.equal(r.interpretation, 'crowded long');
});

test('missing data returns honest unavailable, never fabricated', () => {
  const r = buildLongShortContext({ symbol: 'XUSDT', nowMs: NOW });
  assert.equal(r.available, false);
  assert.equal(r.interpretation, 'unavailable');
  assert.equal(r.globalAccountRatio, null);
  assert.equal(r.topTraderPositionRatio, null);
  assert.equal(r.takerBuySellRatio, null);
  assert.ok(r.missing.includes('globalAccountRatio'));
  assert.ok(r.missing.includes('topTraderPositionRatio'));
  assert.ok(r.missing.includes('takerBuySellRatio'));
});

test('stale snapshot returns unavailable with a stale warning', () => {
  const r = buildLongShortContext({
    nowMs: NOW,
    globalAccountRatioSeries: [globalRow(3.0, NOW - POSITIONING_STALE_TTL_MS - 1)],
  });
  assert.equal(r.stale, true);
  assert.equal(r.available, false);
  assert.equal(r.interpretation, 'unavailable');
  assert.equal(r.globalAccountRatio, null);
  assert.deepEqual(r.warnings, ['long/short snapshot stale']);
});

test('non-finite ratios and malformed timestamps are ignored, not invented', () => {
  const r = buildLongShortContext({
    nowMs: NOW,
    globalAccountRatioSeries: [{ longShortRatio: 'abc', timestamp: 'nope' }, globalRow(2.6, FRESH)],
    takerRatioSeries: [{ buySellRatio: 'xyz', timestamp: String(FRESH) }],
  });
  assert.equal(r.globalAccountRatio, 2.6);
  assert.equal(r.interpretation, 'crowded long');
  assert.equal(r.takerBuySellRatio, null);
  assert.ok(r.missing.includes('takerBuySellRatio'));
});

test('custom staleTtlMs is honored', () => {
  const r = buildLongShortContext({
    nowMs: NOW, staleTtlMs: 30_000,
    globalAccountRatioSeries: [globalRow(3.0, NOW - 60_000)],
  });
  assert.equal(r.stale, true);
  assert.equal(r.available, false);
});

test('tolerates junk input without throwing', () => {
  for (const junk of [undefined, null, 'x', 42, [], { globalAccountRatioSeries: 'nope' }]) {
    const r = buildLongShortContext(junk);
    assert.equal(r.contextOnly, true);
    assert.equal(r.available, false);
    assert.equal(r.interpretation, 'unavailable');
  }
});

test('output carries no forbidden wording', () => {
  const samples = [
    buildLongShortContext({ nowMs: NOW, globalAccountRatioSeries: [globalRow(3, FRESH)], takerRatioSeries: [takerRow(1.5, FRESH)] }),
    buildLongShortContext({ nowMs: NOW, globalAccountRatioSeries: [globalRow(0.3, FRESH)] }),
    buildLongShortContext({}),
  ];
  const blob = JSON.stringify(samples).toLowerCase();
  // Forbidden phrases + action semantics. Note: `takerBuySellRatio` is a
  // documented Binance field name, so bare "buy"/"sell" substrings are expected
  // and legitimate — we assert no standalone BUY/SELL action verbs instead.
  for (const w of ['liquidation heatmap', 'cvd', 'whale order', 'confirmed liquidation', 'guaranteed absorption', 'retail sentiment truth', 'free money', 'sure trade', 'entry_ready', 'telegram']) {
    assert.equal(blob.includes(w), false, `output must not contain "${w}"`);
  }
  for (const key of ['action', 'signal', 'entryReady', 'score', 'telegram', 'buySignal', 'sellSignal']) {
    for (const sample of samples) assert.equal(key in sample, false, `output must not expose field ${key}`);
  }
});

test('module source is pure: no fetch, no env, only the pure sibling import, no signed/order strings', () => {
  assert.doesNotMatch(SRC, /\bfetch\s*\(/);
  assert.doesNotMatch(SRC, /process\.env/);
  // The ONLY import allowed is the pure positioning-context sibling (threshold SSOT).
  const imports = SRC.match(/^import[\s\S]*?from\s+'([^']+)';/gm) || [];
  assert.equal(imports.length, 1, 'exactly one import expected');
  assert.match(imports[0], /'\.\/positioning-context\.mjs'/);
  assert.doesNotMatch(SRC, /ENTRY_READY|telegram|execution|signature|apiKey|apiSecret|secretKey/i);
  assert.doesNotMatch(SRC, /placeOrder|newOrder|\/api\/v3\/order|\/fapi\/v1\/order|\/sapi|\/dapi/i);
  assert.doesNotMatch(SRC, /liquidation heatmap|CVD|whale/i);
});
