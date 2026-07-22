// Source guards for the RADAR wiring that makes the table's Setup number, the
// Absorb/Reclaim columns, and the Focus Candidate card agree on WHICH
// price-history source they show. terminal.js has no exports and the repo has
// no jsdom, so the behavioural model logic lives in the importable pure module
// (covered in tests/radar-price-history-backend-display.test.mjs); these
// guards cover the terminal.js contribution: that the backend scoring block is
// rendered for the selected candidate, that it is a DIFFERENT block from the
// admin-only advisory read, that the table Setup cell surfaces the +N PH tag,
// and that the Absorb/Reclaim tooltips are source-labeled.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const panelJs = fs.readFileSync(new URL('../apps/edge/public/js/price-history-signals-panel.js', import.meta.url), 'utf8');
const cssTxt = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');

test('pure module exports the backend scoring display helpers', () => {
  assert.match(panelJs, /export function radarBackendPriceHistoryModel/);
  assert.match(panelJs, /export function radarBackendPriceHistoryAdjustmentBreakdown/);
  assert.match(panelJs, /backendModel:\s*radarBackendPriceHistoryModel/);
  assert.match(panelJs, /backendAdjustmentBreakdown:\s*radarBackendPriceHistoryAdjustmentBreakdown/);
});

test('backend scoring block is emitted inside the Focus card for the selected candidate', () => {
  const focusStart = terminalJs.indexOf('focusHtml = `<div class="radar-focus-card">');
  const focusTitle = terminalJs.indexOf('class="radar-focus-title"', focusStart);
  assert.ok(focusStart !== -1 && focusTitle !== -1, 'focus card render block must exist');
  const focusBlock = terminalJs.slice(focusStart, focusTitle);
  assert.match(focusBlock, /\$\{_radarBackendPriceHistoryHtml\(selected\)\}/, 'backend scoring block must render for the selected candidate');
});

test('backend scoring block is a DISTINCT block from the admin advisory read', () => {
  // Both must be present, and the backend one must appear before the advisory
  // one so the operator reads the authoritative (scoring) source first.
  const backendIdx = terminalJs.indexOf('${_radarBackendPriceHistoryHtml(selected)}');
  const advisoryIdx = terminalJs.indexOf('${_radarPriceHistorySectionHtml(selected)}');
  assert.ok(backendIdx !== -1 && advisoryIdx !== -1, 'both blocks must be emitted');
  assert.ok(backendIdx < advisoryIdx, 'backend scoring block must precede the advisory read');
});

test('backend block reads the server-owned model, not a second fetch', () => {
  const start = terminalJs.indexOf('function _radarBackendPriceHistoryHtml');
  const end = terminalJs.indexOf('\nfunction _radarPriceHistorySectionHtml', start);
  assert.ok(start !== -1 && end !== -1, 'function must exist');
  const body = terminalJs.slice(start, end);
  assert.match(body, /helpers\.backendModel\(selectedCandidate\)/, 'must read the pure backend model');
  assert.doesNotMatch(body, /fetch\(/, 'must not perform any network fetch');
  // Honesty: names the source and the hard boundaries.
  assert.match(body, /MOVES SETUP/, 'must label itself as the scoring source');
  assert.match(body, /top-five/i, 'must honestly handle candidates outside the scored set');
});

test('backend block is NOT admin-gated (data ships with every candidate)', () => {
  const start = terminalJs.indexOf('function _radarBackendPriceHistoryHtml');
  const end = terminalJs.indexOf('\nfunction _radarPriceHistorySectionHtml', start);
  const body = terminalJs.slice(start, end);
  assert.doesNotMatch(body, /window\.__isAdmin/, 'backend scoring context is public candidate data, not admin-only');
});

test('table Setup cell surfaces a traceable +N PH tag', () => {
  assert.match(terminalJs, /backendAdjustmentBreakdown\(c\)/, 'Setup cell must compute the breakdown');
  assert.match(terminalJs, /radar-ph-setup-tag/, 'Setup cell must render the PH tag span');
  assert.match(terminalJs, /\+\$\{b\.adjustment\} PH/, 'tag must show the +N adjustment');
  assert.match(cssTxt, /\.radar-ph-setup-tag/, 'the tag must be styled');
});

test('table Absorb/Reclaim tooltips are source-labeled and name the price-history source', () => {
  assert.match(terminalJs, /Strict rolling absorption\. /, 'Absorb tooltip must name its own source');
  assert.match(terminalJs, /Market structural reclaim\. /, 'Reclaim tooltip must name its own source');
  assert.match(terminalJs, /_radarPhSourceTipSuffix\(c, 'absorption'\)/);
  assert.match(terminalJs, /_radarPhSourceTipSuffix\(c, 'reclaim'\)/);
});

test('the source-suffix helper distinguishes market/strict source from price-history', () => {
  const start = terminalJs.indexOf('function _radarPhSourceTipSuffix');
  const end = terminalJs.indexOf('\n// BACKEND price-history SCORING block', start);
  assert.ok(start !== -1 && end !== -1, 'helper must exist');
  const body = terminalJs.slice(start, end);
  assert.match(body, /price-history reclaim:/);
  assert.match(body, /price-history absorption:/);
  assert.match(body, /not in top-five scored set/i, 'must be honest when no context');
});

test('no directional trading-action wording introduced in the new frontend blocks', () => {
  for (const fn of ['_radarBackendPriceHistoryHtml', '_radarPhSourceTipSuffix']) {
    const start = terminalJs.indexOf('function ' + fn);
    assert.ok(start !== -1, fn + ' must exist');
    const slice = terminalJs.slice(start, start + 2600);
    assert.doesNotMatch(slice, /\b(buy|sell|going long|go short)\b/i, fn + ' must not contain trading-action wording');
  }
});
