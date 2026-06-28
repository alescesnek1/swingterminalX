// Phase — REAL behavior test for the "WHAT CHANGED?" digest.
//
// change-digest.js is pure (no DOM at import), so we import the actual shipped
// diff functions the operator panel uses (window.__changeDigest) and assert the
// observation-only output directly. This panel must never emit a trade signal,
// so a guard test pins the absence of trading terminology in its labels.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildChangeDigest, marketsDigest, geckoDigest } from '../apps/edge/public/js/change-digest.js';

const coin = (id, score, c24, over = {}) => ({ id, symbol: id.toUpperCase(), score, price_change_percentage_24h: c24, ...over });

test('first snapshot (no previous markets) returns first-snapshot state', () => {
  const d = buildChangeDigest({ prevMarkets: null, currMarkets: [coin('btc', 9, 1)] });
  assert.equal(d.firstSnapshot, true);
  assert.equal(d.comparisonLevel, 'none');
  assert.match(d.freshnessNote, /First snapshot/i);
  assert.equal(d.hasChanges, false);
});

test('new and removed coins in the top set are detected', () => {
  const prev = [coin('btc', 9, 0), coin('eth', 8, 0), coin('sol', 7, 0)];
  const curr = [coin('btc', 9, 0), coin('eth', 8, 0), coin('xrp', 7.5, 0)]; // sol left, xrp entered
  const m = marketsDigest(prev, curr, { topN: 3 });
  assert.equal(m.firstSnapshot, false);
  assert.deepEqual(m.entered.map((x) => x.symbol), ['XRP']);
  assert.deepEqual(m.left.map((x) => x.symbol), ['SOL']);
});

test('24h-change movers are sorted by absolute delta since the previous refresh', () => {
  const prev = [coin('btc', 9, 1), coin('eth', 8, 2), coin('sol', 7, 0)];
  const curr = [coin('btc', 9, 3), coin('eth', 8, 1.5), coin('sol', 7, 9)]; // Δ: btc +2, eth -0.5, sol +9
  const m = marketsDigest(prev, curr, { topN: 10 });
  assert.deepEqual(m.movers.map((x) => x.symbol), ['SOL', 'BTC', 'ETH']);
  assert.equal(m.movers[0].from, 0);
  assert.equal(m.movers[0].to, 9);
  assert.ok(Math.abs(m.movers[0].delta - 9) < 1e-9);
});

test('coins missing a 24h value are skipped from movers (no fake 0%)', () => {
  const prev = [coin('btc', 9, null, { price_change_percentage_24h: undefined, _c24: undefined })];
  const curr = [coin('btc', 9, null, { price_change_percentage_24h: undefined, _c24: undefined })];
  const m = marketsDigest(prev, curr, { topN: 10 });
  assert.equal(m.movers.length, 0);
});

test('GECKO newly-seen coin names per section are detected; categories skipped', () => {
  const sec = (key, names, valueMode = 'price_change') => ({
    key, title: key, diagnostics: { valueMode },
    items: names.map((n) => ({ name: n })),
  });
  const prev = [sec('trending_coins', ['Bitcoin', 'Ethereum']), sec('trending_categories', ['Memes'], 'category')];
  const curr = [sec('trending_coins', ['Bitcoin', 'Pepe', 'Dogwifhat']), sec('trending_categories', ['AI', 'Memes'], 'category')];
  const g = geckoDigest(prev, curr);
  assert.equal(g.firstSnapshot, false);
  // Only the coin section is diffed; the category section is ignored.
  assert.equal(g.newBySection.length, 1);
  assert.equal(g.newBySection[0].key, 'trending_coins');
  assert.deepEqual(g.newBySection[0].names, ['Pepe', 'Dogwifhat']);
});

test('GECKO first snapshot (no previous sections) returns first-snapshot state', () => {
  const g = geckoDigest(null, [{ key: 'trending_coins', items: [{ name: 'Bitcoin' }], diagnostics: {} }]);
  assert.equal(g.firstSnapshot, true);
  assert.deepEqual(g.newBySection, []);
});

test('stale/offline freshness produces a clear limited-comparison label', () => {
  const prev = [coin('btc', 9, 0)];
  const curr = [coin('btc', 9, 0)];
  const stale = buildChangeDigest({ prevMarkets: prev, currMarkets: curr, freshness: { ok: true, stale: true } });
  assert.equal(stale.comparisonLevel, 'limited');
  assert.match(stale.freshnessNote, /stale.*comparison may be limited/i);

  const offline = buildChangeDigest({ prevMarkets: prev, currMarkets: curr, freshness: { ok: false } });
  assert.equal(offline.comparisonLevel, 'limited');
});

test('fresh comparison reports the previous snapshot age in seconds', () => {
  const prev = [coin('btc', 9, 0)];
  const curr = [coin('btc', 9, 0)];
  const d = buildChangeDigest({
    prevMarkets: prev, currMarkets: curr,
    freshness: { ok: true, stale: false }, prevAtMs: 1000, nowMs: 46000,
  });
  assert.equal(d.comparisonLevel, 'ok');
  assert.match(d.freshnessNote, /from 45s ago/);
});

test('digest carries the observation-only disclaimer and NO trading terminology', () => {
  const prev = [coin('btc', 9, 1), coin('eth', 8, 2)];
  const curr = [coin('btc', 9, 5), coin('doge', 8.5, 2)];
  const d = buildChangeDigest({ prevMarkets: prev, currMarkets: curr, freshness: { ok: true, stale: false } });
  assert.match(d.disclaimer, /not a trade signal/i);
  // Serialize the whole digest and assert no execution/signal vocabulary leaked.
  const blob = JSON.stringify(d).toUpperCase();
  for (const word of ['BUY', 'SELL', 'ENTRY_READY', 'EXECUTE', 'LONG', 'SHORT', 'TP', 'STOP LOSS']) {
    assert.ok(!blob.includes(word), `digest must not contain trading word: ${word}`);
  }
});

test('the digest module never invokes a trading / alerting system', () => {
  // It may *document* that it avoids these, but it must not call them. Assert
  // no execution call-sites exist (function-call shapes, not prose mentions).
  const src = fs.readFileSync(new URL('../apps/edge/public/js/change-digest.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /placeOrder\s*\(|autoTrader[.(]|sendTelegram\s*\(|emitEntryReady\s*\(/i);
});
