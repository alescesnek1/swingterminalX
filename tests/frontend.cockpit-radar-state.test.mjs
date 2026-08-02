import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

// The Cockpit previously read no database at all: its only endpoints were the
// personal-watch ones, so it worked off whatever copy of the RADAR candidate the
// scanner happened to be holding in the browser. This block is the server's own
// current verdict for the ONE selected coin, read off the atomized (market, symbol)
// row, so the two can be compared instead of assumed identical.

test('the Cockpit reads the server verdict from the atomized per-symbol route', () => {
  assert.match(terminalJs, /\/api\/cockpit-radar-state\?symbol=\$\{encodeURIComponent\(symbol\)\}/);
  assert.match(terminalJs, /function _cpRadarStateSlotHtml\(symbol\)/);
  assert.match(terminalJs, /async function _refreshCockpitRadarState\(\)/);
  // Mounted in the RADAR focus card and refreshed when the Cockpit renders.
  assert.match(terminalJs, /\$\{_cpRadarStateSlotHtml\(f\.symbol\)\}/);
  assert.match(terminalJs, /_refreshCockpitRadarState\(\);/);
});

test('"not scored" and "read failed" are rendered as different facts', () => {
  // A coverage gap must never be presented as a rejected setup...
  assert.match(terminalJs, /This is a coverage gap, <b>not<\/b> a rejected setup/);
  // ...and a failed read must never be presented as "no setup".
  assert.match(terminalJs, /This is a failed read, not a "no setup" result/);
  // The 404 branch is explicitly the honest not-scored answer, not an error.
  assert.match(terminalJs, /r\.status === 404 \|\| \(body && body\.found === false\)/);
  assert.match(terminalJs, /state: 'notScored'/);
});

test('an uncomputed score renders UNKNOWN, never a zero a user could trade on', () => {
  assert.match(terminalJs, /function _cpScore\(value\) \{ return \(value === null \|\| value === undefined\) \? 'UNKNOWN'/);
  assert.match(terminalJs, /function _cpLevel\(value\) \{ return \(value === null \|\| value === undefined\) \? 'UNKNOWN'/);
});

test('staleness is surfaced rather than left for the user to infer', () => {
  assert.match(terminalJs, /STALE — older than two collector cycles/);
  assert.match(terminalJs, /_cpRadarStateRow\('Freshness'/);
});

test('the read is bounded, deduped and logs every failure with context', () => {
  assert.match(terminalJs, /CP_RADAR_STATE_TTL_MS = 30_000/);
  assert.match(terminalJs, /CP_RADAR_STATE_TIMEOUT_MS = 6000/);
  assert.match(terminalJs, /_cpRadarStateInFlight\.has\(symbol\)/);
  assert.match(terminalJs, /new AbortController\(\)/);
  // Failures are logged, never swallowed.
  assert.match(terminalJs, /console\.warn\('\[CP-RADAR-STATE\]'/);
  assert.match(terminalJs, /console\.warn\('\[CP-RADAR-STATE\] read failed:'/);
  assert.match(terminalJs, /AbortError' \? `timed out after/);
  // The in-flight marker is always released.
  assert.match(terminalJs, /_cpRadarStateInFlight\.delete\(symbol\)/);
});

test('the block is display-only: it imports nothing and triggers no trade action', () => {
  const start = terminalJs.indexOf('function _cpRadarStateSlotHtml');
  const end = terminalJs.indexOf('function _cpRadarFocusHtml');
  assert.ok(start > 0 && end > start, 'the block is locatable');
  const block = terminalJs.slice(start, end);
  assert.doesNotMatch(block, /cockpit-import-radar|_cpFillForm|_cpOpenManual/);
  assert.doesNotMatch(block, /telegram|ENTRY_READY\s*=/i);
  // Values are escaped on the way into the DOM.
  assert.match(block, /_esc\(/);
  assert.doesNotMatch(block, /innerHTML\s*=\s*[^_]*\$\{(?!_esc|_cpRadarStateInnerHtml)/);
});

// A miss has two causes and the panel must not assert the friendlier one.
test('an empty state table is rendered as a publisher outage, not a coverage gap', () => {
  assert.match(terminalJs, /The server has scored NO coins/);
  assert.match(terminalJs, /This is a server-side outage, <b>not<\/b> a verdict about/);
  // The coverage payload reaches the renderer.
  assert.match(terminalJs, /coverage: \(body && body\.coverage\) \|\| null/);
  assert.match(terminalJs, /cov\.available === true && cov\.scoredSymbols === 0/);
  // And the coverage-gap branch now says how many coins ARE scored.
  assert.match(terminalJs, /The server currently holds verdicts for/);
});
