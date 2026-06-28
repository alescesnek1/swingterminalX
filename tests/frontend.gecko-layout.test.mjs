// Phase 2 — REAL behavior test for GECKO section column honesty.
//
// gecko-layout.js is pure (no DOM at import), so we import the actual shipped
// geckoSectionLayout() the GECKO renderer uses (window.__geckoLayout, with a
// terminal.js inline fallback) and assert the column decisions directly —
// instead of only grepping terminal.js. The rule under test: never render a
// column whose values don't exist (no fake success), and flag partial data.

import test from 'node:test';
import assert from 'node:assert/strict';

import { geckoSectionLayout } from '../apps/edge/public/js/gecko-layout.js';

const sec = (valueMode, key) => ({ key: key || valueMode, diagnostics: { valueMode } });
const priceRow = (over = {}) => ({ priceText: '$1.23', change24hText: '+4.5%', ...over });

test('price_change with full coverage shows price + change, not partial', () => {
  const L = geckoSectionLayout(sec('price_change', 'top_gainers'), [priceRow(), priceRow()]);
  assert.equal(L.showChange, true);
  assert.equal(L.showPrice, true);
  assert.equal(L.showVolume, false);
  assert.equal(L.partial, false);
  assert.match(L.gridCols, /auto auto$/); // price + change columns
});

test('price_change missing some 24h values flags partial (honest, not faked)', () => {
  const L = geckoSectionLayout(sec('price_change'), [priceRow(), priceRow({ change24hText: '' })]);
  assert.equal(L.partial, true);
});

test('ATH section hides spot price and relabels the change column', () => {
  // price_change_since_ath rows carry a % from ATH but no spot price.
  const rows = [priceRow({ priceText: '' }), priceRow({ priceText: '' })];
  const L = geckoSectionLayout(sec('price_change', 'price_change_since_ath'), rows);
  assert.equal(L.showPrice, false);       // no spot price column invented
  assert.equal(L.showChange, true);
  assert.equal(L.changeLabel, 'FROM ATH');
});

test('volume section shows VOLUME column, never a fake price/change', () => {
  const L = geckoSectionLayout(sec('volume', 'highest_volume'), [priceRow(), priceRow()]);
  assert.equal(L.showVolume, true);
  assert.equal(L.showPrice, false);
  assert.equal(L.showChange, false);
});

test('unlock/category/unknown sections surface only values that exist', () => {
  // No price/change text at all → name-only list, no invented columns.
  const nameOnly = [{ name: 'Foo' }, { name: 'Bar' }];
  const L = geckoSectionLayout(sec('unlock', 'incoming_token_unlocks'), nameOnly);
  assert.equal(L.showPrice, false);
  assert.equal(L.showChange, false);
  assert.equal(L.showVolume, false);
  assert.equal(L.gridCols, '36px 1fr'); // just rank + name
});

test('empty section yields a safe name-only layout (no crash, no fake columns)', () => {
  const L = geckoSectionLayout(sec('price_change'), []);
  assert.equal(L.showPrice, false);
  assert.equal(L.showVolume, false);
  assert.equal(L.partial, false);
});

test('missing/garbage inputs do not throw and produce a name-only layout', () => {
  const L = geckoSectionLayout(undefined, undefined);
  assert.equal(L.mode, 'unknown');
  assert.equal(L.gridCols, '36px 1fr');
});
