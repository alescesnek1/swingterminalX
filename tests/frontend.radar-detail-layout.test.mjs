// RADAR detail layout — UX cleanup guards. Summary-first ordering, raw
// diagnostics collapsed, duplicate "Why blocked / what next" removed from the
// visible flow, Pressure Zones surfaced near the top. Display/copy only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

// Anchor helpers scoped to the RADAR focus card render.
const cardStart = terminalJs.indexOf('focusHtml = `<div class="radar-focus-card">');
assert.ok(cardStart > 0, 'radar focus card render not found');
const idx = (needle) => {
  const at = terminalJs.indexOf(needle, cardStart);
  assert.ok(at > 0, `expected to find "${needle}" in the focus card`);
  return at;
};

test('RADAR detail renders summary first, then supporting context, then collapsed raw', () => {
  const readiness = idx('class="radar-trade-readiness"');
  const operator = idx('radar-operator-summary');
  const focusTitle = idx('class="radar-focus-title"');
  const keyTrade = idx('class="radar-key-trade"');
  const pressure = idx('PRESSURE ZONES · derived proxy — not liquidation data');
  const advanced = idx('class="radar-advanced-diagnostics"');
  assert.ok(readiness < operator, 'Trade Readiness must come before Operator Summary');
  assert.ok(operator < focusTitle, 'Operator Summary before focus title');
  assert.ok(focusTitle < keyTrade, 'focus title before Key trade info');
  assert.ok(keyTrade < pressure, 'Key trade info before Pressure Zones');
  assert.ok(pressure < advanced, 'Pressure Zones (supporting) before the Advanced diagnostics block');
});

test('Trade Readiness appears before any raw diagnostics section', () => {
  const readiness = idx('class="radar-trade-readiness"');
  for (const raw of ['Score Breakdown', 'Microstructure readiness', 'Provider Status Panel', 'Absorb Diagnostics Panel', 'Reclaim Diagnostics Panel']) {
    assert.ok(readiness < idx(raw), `Trade Readiness must precede raw section "${raw}"`);
  }
});

test('Advanced diagnostics stays collapsed by default (open only via remembered per-symbol toggle)', () => {
  // The <details> open state is driven solely by the remembered expansion map,
  // never hardcoded open.
  assert.match(terminalJs, /radar-advanced-diagnostics"[^>]*\$\{window\._fleetAdvancedDiagExpanded[^}]*\? 'open' : ''\}/);
  assert.doesNotMatch(terminalJs, /class="radar-advanced-diagnostics"[^>]*\sopen\s*>/);
});

test('duplicate "Why blocked / what next" is removed from the visible flow (moved to Detailed blockers in Advanced)', () => {
  assert.doesNotMatch(terminalJs, /Why blocked \/ what next/);
  const detailed = idx('Detailed blockers');
  const advanced = idx('class="radar-advanced-diagnostics"');
  assert.ok(detailed > advanced, 'Detailed blockers must live inside the Advanced diagnostics block');
});

test('raw "Compact diagnostics" is moved into the collapsed Advanced diagnostics block', () => {
  const compact = idx('>Compact diagnostics<');
  const advanced = idx('class="radar-advanced-diagnostics"');
  assert.ok(compact > advanced, 'Compact diagnostics must live inside Advanced diagnostics');
});

test('Pressure Zones panel is not duplicated — it lives only in the visible supporting area', () => {
  const advanced = idx('class="radar-advanced-diagnostics"');
  const lastPz = terminalJs.lastIndexOf('radar-pressure-zones');
  assert.ok(lastPz > 0 && lastPz < advanced, 'no Pressure Zones panel should remain inside Advanced diagnostics');
});

test('copy polish: Actionable now / Context only present; no BUY/SELL/guaranteed', () => {
  assert.match(terminalJs, /Actionable now:/);
  assert.match(terminalJs, /Context only/);
  // forbidden trade-signal / overclaim wording must not appear in the readiness copy
  const readiness = idx('class="radar-trade-readiness"');
  const block = terminalJs.slice(readiness, readiness + 900);
  assert.doesNotMatch(block, /\bBUY\b|\bSELL\b|guaranteed/i);
});

test('RADAR focus card visible region adds no fetch and no forbidden wording', () => {
  const advanced = idx('class="radar-advanced-diagnostics"');
  const visible = terminalJs.slice(cardStart, advanced);
  assert.doesNotMatch(visible, /fetch\s*\(/);
  assert.doesNotMatch(visible, /coinee/i);
  assert.doesNotMatch(terminalJs.slice(cardStart), /liquidation heatmap/i);
  assert.doesNotMatch(terminalJs.slice(cardStart), /\bCVD\b/);
  assert.doesNotMatch(terminalJs.slice(cardStart), /whale orders/i);
  assert.doesNotMatch(terminalJs.slice(cardStart), /confirmed liquidation/i);
});
