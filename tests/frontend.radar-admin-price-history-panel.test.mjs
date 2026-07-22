// Source guards for the RADAR-facing "Price History Signals" section that
// renders INSIDE the Focus Candidate card. These are written specifically to
// fail if the exact production bug recurs: the panel fetching nothing on
// RADAR tab open because it was gated on an explicitly-clicked symbol
// (Fleet.radarSelectedSymbol, null until a click) instead of the focused
// candidate that the RADAR already shows.
//
// terminal.js is a classic <script> with no exports, so its functions cannot
// be imported for a DOM test here (the repo has no jsdom). The truly
// behavioural logic (pair->base mapping, state/tone model) is therefore kept
// in the importable pure module and covered for real in
// tests/radar-price-history-signal-states.test.mjs. These source guards cover
// the wiring terminal.js contributes: placement, trigger path, admin/GET
// discipline, and the no-poll / no-stale rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const panelJs = fs.readFileSync(new URL('../apps/edge/public/js/price-history-signals-panel.js', import.meta.url), 'utf8');

test('the old bottom-of-view RADAR box is gone from index.html', () => {
  assert.doesNotMatch(indexHtml, /id="radar-admin-price-history"/, 'the misplaced outside-root box must be removed');
});

test('the price-history section is emitted INSIDE the Focus Candidate card', () => {
  // _renderTradingRadar must inject the section into the focus card string,
  // between the decision cards and the focus title — not as a detached
  // sibling that a wholesale innerHTML replace would strip or misplace.
  const focusStart = terminalJs.indexOf('focusHtml = `<div class="radar-focus-card">');
  const focusTitle = terminalJs.indexOf('class="radar-focus-title"', focusStart);
  assert.ok(focusStart !== -1 && focusTitle !== -1, 'focus card render block must exist');
  const focusBlock = terminalJs.slice(focusStart, focusTitle);
  assert.match(focusBlock, /\$\{_radarPriceHistorySectionHtml\(selected\)\}/, 'section must be emitted inside the focus card for the selected candidate');
});

test('the section container carries the focused base symbol for the refresh hook to read', () => {
  const start = terminalJs.indexOf('function _radarPriceHistorySectionHtml');
  const end = terminalJs.indexOf('\nfunction _radarPhSetResult', start);
  assert.ok(start !== -1 && end !== -1 && start < end, '_radarPriceHistorySectionHtml must exist');
  const fn = terminalJs.slice(start, end);
  assert.match(fn, /if\s*\(\s*!window\.__isAdmin\s*\)\s*return\s*'';/, 'section must render only for admins');
  assert.match(fn, /id="radar-ph-signals-slot"/, 'section must use the stable slot id');
  assert.match(fn, /data-ph-debug="mounted"/, 'section must stamp a visible debug marker');
  assert.match(fn, /data-ph-admin="true"/, 'section must stamp admin visibility');
  assert.match(fn, /data-ph-pair="/, 'section must stamp the focused pair');
  assert.match(fn, /data-ph-base="/, 'section must stamp the focused base symbol as a data attribute');
  assert.match(fn, /data-ph-status="mounted"/, 'section must stamp its initial status');
  assert.match(fn, /display:block !important/, 'section must remain visibly mounted');
  assert.match(fn, /_baseSymbolFromRadarPair\(selectedCandidate\.symbol\)/, 'focused base must be derived from the selected candidate pair');
});

test('the fetch is FOCUS-driven (reads the slot data-ph-base), NOT gated on an explicit click', () => {
  const start = terminalJs.indexOf('async function _refreshRadarPriceHistorySignals');
  const end = terminalJs.indexOf('// ── Symbol watch-list', start);
  assert.ok(start !== -1 && end !== -1 && start < end, '_refreshRadarPriceHistorySignals must exist');
  const fn = terminalJs.slice(start, end);
  assert.match(fn, /getElementById\('radar-ph-signals-slot'\)/, 'must locate the rendered slot');
  assert.match(fn, /getAttribute\('data-ph-base'\)/, 'must read the focused base from the slot');
  // The regression guard: it must NOT gate the fetch on Fleet.radarSelectedSymbol,
  // which is null until an explicit click and caused zero requests on tab open.
  assert.doesNotMatch(fn, /Fleet\.radarSelectedSymbol/, 'must not gate the fetch on the explicit-click symbol');
});

test('renderTradingRadarPanel triggers the refresh on every render (tab open + poll re-renders)', () => {
  const start = terminalJs.indexOf('function renderTradingRadarPanel()');
  const end = terminalJs.indexOf('\n}', start);
  const fn = terminalJs.slice(start, end);
  assert.match(fn, /_refreshRadarPriceHistorySignals\(\)/, 'render must drive the refresh so tab-open and poll re-renders populate the section');
});

test('the refresh gates on window.__isAdmin and only ever issues a GET', () => {
  const start = terminalJs.indexOf('async function _refreshRadarPriceHistorySignals');
  const end = terminalJs.indexOf('// ── Symbol watch-list', start);
  const fn = terminalJs.slice(start, end);
  assert.match(fn, /if\s*\(\s*!window\.__isAdmin\s*\)\s*return;/, 'must early-return for non-admins');
  assert.match(fn, /ADMIN_PRICE_HISTORY_SIGNALS_ENDPOINT \+ '\?symbol='/, 'must query by base symbol');
  assert.doesNotMatch(fn, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i, 'must never send a mutating request');
  assert.match(fn, /await _getAuthHeaders\(\)/);
});

test('the refresh caches per base symbol and dedupes in-flight fetches (no poll spam)', () => {
  const start = terminalJs.indexOf('async function _refreshRadarPriceHistorySignals');
  const end = terminalJs.indexOf('// ── Symbol watch-list', start);
  const fn = terminalJs.slice(start, end);
  // Cache hit on the same base must repaint without fetching.
  assert.match(fn, /_radarPhCache\.base === base && _radarPhCache\.model/, 'must short-circuit and repaint from cache on an unchanged base');
  assert.match(fn, /_radarPhCache\.loadingBase === base/, 'must dedupe a concurrent fetch for the same base');
  // No setInterval/setTimeout poll loop drives the refresh anywhere.
  const pollLoops = terminalJs.match(/set(Interval|Timeout)\([^)]*_refreshRadarPriceHistorySignals/g) || [];
  assert.equal(pollLoops.length, 0, 'must never be driven by a poll timer');
});

test('a fetch result only repaints when the slot is still on the same base (never stale on symbol switch)', () => {
  const start = terminalJs.indexOf('function _radarPhSetResult');
  const end = terminalJs.indexOf('\nasync function _refreshRadarPriceHistorySignals', start);
  assert.ok(start !== -1 && end !== -1 && start < end, '_radarPhSetResult must exist');
  const fn = terminalJs.slice(start, end);
  assert.match(fn, /getAttribute\('data-ph-base'\)[^\n]*=== base/, 'must guard the repaint against a mid-flight symbol switch');
});

test('the refresh distinguishes auth / fetch / malformed transport errors', () => {
  const start = terminalJs.indexOf('async function _refreshRadarPriceHistorySignals');
  const end = terminalJs.indexOf('// ── Symbol watch-list', start);
  const fn = terminalJs.slice(start, end);
  assert.match(fn, /'AUTH_REQUIRED'/, 'must surface AUTH_REQUIRED on 401/403 or missing token');
  assert.match(fn, /'FETCH_ERROR'/, 'must surface FETCH_ERROR on network/HTTP failure');
  assert.match(fn, /'MALFORMED_RESPONSE'/, 'must surface MALFORMED_RESPONSE on unparseable body');
  assert.match(fn, /DB_UNAVAILABLE/, 'must preserve database-unavailable as a distinct degraded state');
  assert.match(fn, /errorBody && errorBody.reason === 'DB_UNAVAILABLE'[^;]*'FETCH_ERROR'/, 'generic 503/network failures must remain FETCH_ERROR');
  const panelBlock = terminalJs.slice(terminalJs.indexOf('const _RADAR_PH_LABEL'), terminalJs.indexOf('\nfunction _pwShowWatchError', terminalJs.indexOf('const _RADAR_PH_LABEL')));
  assert.match(panelBlock, /Status.*unavailable|return 'unavailable'/i, 'must render an explicit unavailable status');
  assert.match(panelBlock, /rcLabel = systemUnavailable \? 'Unknown'/, 'database unavailability must render reclaim as Unknown');
  assert.match(panelBlock, /abLabel = systemUnavailable \? 'Unknown'/, 'database unavailability must render absorption as Unknown');
});

test('RADAR slot renders explicit focused/status diagnostics and DB-unavailable copy', () => {
  const start = terminalJs.indexOf('const _RADAR_PH_LABEL');
  const end = terminalJs.indexOf('// â”€â”€ Symbol watch-list', start);
  const block = terminalJs.slice(start, end);
  assert.match(block, /PRICE HISTORY SIGNALS/);
  assert.match(block, /Focused/);
  assert.match(block, /Status/);
  assert.match(block, /Price-history database unavailable in this environment/);
  assert.match(block, /No scheduled history yet/);
});

test('_radarSelect re-renders (which drives the refresh) rather than calling a dead hook', () => {
  const selectFn = terminalJs.match(/window\._radarSelect = function\(sym\) \{[\s\S]{0,1400}?\r?\n\};/);
  assert.ok(selectFn, '_radarSelect must exist');
  assert.match(selectFn[0], /renderTradingRadarPanel\(\);/, 'selecting a candidate must re-render, which repaints/refetches the section for the new focus');
});

test('no buy/sell/long/short wording in the RADAR section wiring or shared module', () => {
  const start = terminalJs.indexOf('// ── ADMIN PRICE-HISTORY SIGNALS — RADAR-facing diagnostics ──');
  const end = terminalJs.indexOf('// ── Symbol watch-list', start);
  const block = terminalJs.slice(start, end) + panelJs;
  assert.doesNotMatch(block, /\b(buy|sell|long|short)\b/i);
});

test('the RADAR section never touches radar-context, scoring, gates, or execution state', () => {
  const start = terminalJs.indexOf('// ── ADMIN PRICE-HISTORY SIGNALS — RADAR-facing diagnostics ──');
  const end = terminalJs.indexOf('// ── Symbol watch-list', start);
  const block = terminalJs.slice(start, end);
  assert.doesNotMatch(block, /radar-context/);
  assert.doesNotMatch(block, /ENTRY_READY/);
  assert.doesNotMatch(block, /pushScannerContextToRadar/);
});

test('Cockpit shared panel preserves DB-unavailable and generic transport distinctions', () => {
  const start = terminalJs.indexOf('function _renderAdminPriceHistoryRow');
  const end = terminalJs.indexOf('\n//', start);
  const block = terminalJs.slice(start, end);
  assert.match(block, /errorBody && errorBody.reason === 'DB_UNAVAILABLE'[^;]*'FETCH_ERROR'/);
  assert.match(block, /MALFORMED_RESPONSE/);
  assert.match(block, /console\.warn\('\[Cockpit\] price-history fetch failed/);
});

test('the Cockpit admin panel is untouched (still BTC/ETH-only, still its own refresh)', () => {
  assert.match(terminalJs, /ADMIN_PRICE_HISTORY_SYMBOLS\s*=\s*\[\s*['"]BTC['"]\s*,\s*['"]ETH['"]\s*\]/);
  assert.match(terminalJs, /async function refreshAdminPriceHistorySignals\(\)/);
});
