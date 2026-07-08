// Frontend source guards for the RADAR Pressure Zones panel (context-only proxy).
// The panel renders only when candidate.pressureZones exists, is labelled exactly,
// shows an honest unavailable state, adds no fetch, and uses no forbidden wording.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');

test('RADAR pressure-zones panel renders only when candidate.pressureZones is available', () => {
  assert.match(terminalJs, /selected\.pressureZones/);
  assert.match(terminalJs, /pz\.available !== true/);
  assert.match(terminalJs, /radar-pressure-zones/);
  assert.match(terminalCss, /\.radar-pressure-zones/);
});

test('RADAR pressure-zones panel uses the exact proxy label and disclaimer', () => {
  assert.ok(terminalJs.includes('PRESSURE ZONES · derived proxy — not liquidation data'), 'exact panel title required');
  assert.ok(terminalJs.includes('Derived proxy from closed candles; not liquidation data; not order-book data.'), 'disclaimer required');
});

test('RADAR pressure-zones panel renders an honest unavailable state', () => {
  assert.ok(terminalJs.includes('Pressure Zones unavailable — no fresh closed candle snapshot'), 'unavailable text required');
});

test('RADAR pressure-zones panel shows price/type/strength/basis + candles used + reference price', () => {
  assert.match(terminalJs, /z\.type/);
  assert.match(terminalJs, /z\.price/);
  assert.match(terminalJs, /z\.strength/);
  assert.match(terminalJs, /z\.basis/);
  assert.match(terminalJs, /Candles used/);
  assert.match(terminalJs, /Reference price/);
});

test('RADAR pressure-zones adds no new fetch and no Coinee reference', () => {
  assert.doesNotMatch(terminalJs, /fetch\([^)]*klines/i);
  assert.doesNotMatch(terminalJs, /fetch\([^)]*pressure/i);
  assert.doesNotMatch(terminalJs, /coinee/i);
});

test('RADAR pressure-zones uses no forbidden wording anywhere in the frontend', () => {
  assert.doesNotMatch(terminalJs, /liquidation heatmap/i);
  assert.doesNotMatch(terminalJs, /\bCVD\b/);
  assert.doesNotMatch(terminalJs, /whale orders/i);
  assert.doesNotMatch(terminalJs, /confirmed liquidation/i);
  assert.doesNotMatch(terminalJs, /guaranteed absorption/i);
});
