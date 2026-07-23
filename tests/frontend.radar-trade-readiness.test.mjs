// Frontend source guards for the RADAR Trade Readiness panel (context-only).
// Renders only from candidate.tradeReadiness (server-computed), shows blockers /
// supporting context / missing / next check, and adds no fetch or forbidden words.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');

test('RADAR trade-readiness panel renders only when candidate.tradeReadiness exists', () => {
  assert.match(terminalJs, /selected\.tradeReadiness/);
  assert.match(terminalJs, /const tr = selected\.tradeReadiness;\s*\n\s*if \(!tr\) return ''/);
  assert.match(terminalJs, /radar-trade-readiness/);
  assert.match(terminalCss, /\.radar-trade-readiness/);
});

test('RADAR trade-readiness panel shows the operator-language sections', () => {
  assert.ok(terminalJs.includes('TRADE READINESS · what to check next'), 'panel title required');
  assert.match(terminalJs, /Actionable now:/);
  assert.match(terminalJs, /Context only/);
  assert.match(terminalJs, /Blocked by:/);
  assert.match(terminalJs, /Supporting context:/);
  assert.match(terminalJs, /Missing server-gate data:/);
  assert.match(terminalJs, /Next check:/);
  // renders the server-provided arrays/fields
  assert.match(terminalJs, /tr\.headline/);
  assert.match(terminalJs, /tr\.blockers/);
  assert.match(terminalJs, /tr\.supportive/);
  assert.match(terminalJs, /tr\.missing/);
  assert.match(terminalJs, /tr\.nextCheck/);
});

test('RADAR trade-readiness panel adds no fetch and no Coinee reference', () => {
  // isolate the readiness IIFE and assert it performs no fetch
  const start = terminalJs.indexOf('const tr = selected.tradeReadiness;');
  assert.ok(start > 0);
  const block = terminalJs.slice(start, start + 1200);
  assert.doesNotMatch(block, /fetch\s*\(/);
  assert.doesNotMatch(block, /coinee/i);
  // and it introduces no BUY/SELL/ENTRY_READY literal of its own
  assert.doesNotMatch(block, /\bBUY\b|\bSELL\b|ENTRY_READY/);
});

test('RADAR trade-readiness uses no forbidden wording', () => {
  assert.doesNotMatch(terminalJs, /liquidation heatmap/i);
  assert.doesNotMatch(terminalJs, /\bCVD\b/);
  assert.doesNotMatch(terminalJs, /whale orders/i);
  assert.doesNotMatch(terminalJs, /confirmed liquidation/i);
  assert.doesNotMatch(terminalJs, /guaranteed absorption/i);
});
