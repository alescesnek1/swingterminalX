// Phase 1 source guards for the PRODUCTION frontend cockpit (apps/edge/public/js/terminal.js).
// The frontend cockpit runs in the browser and mirrors scripts/cockpit/trade-cockpit.mjs.
// These guards prove the deployed code no longer fabricates microstructure defaults
// and surfaces N/A / low-confidence / no-live-price states honestly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');

test('frontend cockpit no longer fabricates microstructure defaults', () => {
  assert.doesNotMatch(terminalJs, /_cpNum\(row\.spreadPct,\s*0\.06\)/);
  assert.doesNotMatch(terminalJs, /_cpNum\(row\.bidDepthRebuildPct,\s*8\)/);
  assert.doesNotMatch(terminalJs, /marketBuyVolumeDominance,\s*0\.52\)/);
  assert.doesNotMatch(terminalJs, /_cpNum\(row\.fundingRate,\s*0\.01\)/);
  assert.doesNotMatch(terminalJs, /_cpNum\(row\.openInterestChangePct,\s*0\)/);
});

test('frontend cockpit never falls back to entry price for current price', () => {
  assert.doesNotMatch(terminalJs, /_cpNum\(market\.currentPrice,\s*entry\)/);
  assert.match(terminalJs, /const current = _cpNum\(market\.currentPrice\);/);
  assert.match(terminalJs, /NO_LIVE_PRICE/);
  assert.match(terminalJs, /not in scanner universe/);
});

test('frontend cockpit computes mini-scores only when present and flags low-confidence', () => {
  assert.match(terminalJs, /_cpPresent\(/);
  assert.match(terminalJs, /momentumPresent/);
  assert.match(terminalJs, /bookPresent/);
  assert.match(terminalJs, /flowPresent/);
  assert.match(terminalJs, /derivPresent/);
  assert.match(terminalJs, /lowConfidence/);
  assert.match(terminalJs, /missingComponents/);
});

test('frontend cockpit renders N/A scores, low-confidence badge, and no-price state', () => {
  assert.match(terminalJs, /val == null \? 'N\/A'/);
  assert.match(terminalJs, /LOW-CONFIDENCE/);
  assert.match(terminalJs, /no live price/);
  assert.match(terminalCss, /\.cockpit-score\.na/);
  assert.match(terminalCss, /\.cockpit-lowconf/);
});
