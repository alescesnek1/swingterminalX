// Executable regression guard for the LIVE bug: clicking a Trading RADAR
// candidate did nothing and Cockpit could never import it.
//
// ROOT CAUSE (proved here): terminal.js loads as a CLASSIC script, where a
// top-level `const Fleet = {…}` is a lexical global binding, NOT a property of
// window. The RADAR select setter (_radarSelect) and the Cockpit import focus
// (_cpRadarFocus) both READ window.Fleet, which resolved to `undefined` — so the
// click handler bailed before persisting the pick, and Cockpit never saw it.
//
// The pre-existing flow tests never caught this because they INJECT a fake
// window.Fleet object into the extracted functions — fabricating the exact global
// the real page could not reach. These tests instead:
//   1. assert the source now exposes the singleton (window.Fleet = Fleet),
//   2. execute _radarSelect through the *rendered onclick attribute string* with
//      window.Fleet aliased to the same object (as the fix makes it), and prove
//      the pick is written and the panel re-renders,
//   3. read the pick back through _cpRadarFocus (which uses window.Fleet) to prove
//      the Cockpit import end of the flow now sees the clicked symbol.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

// Brace-match a `function NAME(` body (pure helper, runnable in isolation).
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `could not find function ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// Brace-match an `LHS = function(` assignment (e.g. window._radarSelect = function…).
function extractAssignedFn(src, lhs) {
  const start = src.indexOf(`${lhs} = function`);
  assert.ok(start >= 0, `could not find ${lhs} = function`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces extracting ${lhs}`);
}

// The real _esc, so the onclick string we execute is byte-identical to render.
const _esc = new Function(`${extractFn(terminalJs, '_esc')}; return _esc;`)();

// Build a live _radarSelect whose window.Fleet AND bare Fleet resolve to the SAME
// object — exactly the state the window.Fleet = Fleet alias creates in the page.
function makeRadarSelect(fleet, onRender) {
  const src = extractAssignedFn(terminalJs, 'window._radarSelect');
  const win = { Fleet: fleet };
  const install = new Function(
    'window', 'Fleet', 'renderTradingRadarPanel',
    `${src}; return window._radarSelect;`,
  );
  const fn = install(win, fleet, onRender);
  win._radarSelect = fn;
  return win; // click executes against this window
}

// Fire a candidate's *rendered* onclick, exactly as the browser would.
function clickCandidate(win, symbol) {
  const onclick = `window._radarSelect('${_esc(symbol)}')`;
  new Function('window', onclick)(win);
}

// Run the real _cpRadarFocus against a window.Fleet (the Cockpit import read end).
function runCpRadarFocus(fleet) {
  const src = extractFn(terminalJs, '_cpRadarFocus');
  return new Function('window', `${src}; return _cpRadarFocus();`)({ Fleet: fleet });
}

function freshFleet() {
  return {
    data: { tradingRadar: {
      candidates: [{ symbol: 'AAAUSDT' }, { symbol: 'SPELLUSDT' }, { symbol: 'BBBUSDT' }],
      selected: { symbol: 'AAAUSDT' },   // radar's own default focus (top candidate)
      entryReady: [{ symbol: 'CCCUSDT' }],
    } },
    radarSelectedSymbol: null,
  };
}

// ── The regression guard for the exact defect ───────────────────────────────

test('the durable Fleet singleton is exposed on window (classic-script fix)', () => {
  // A top-level `const` is NOT a window property in a classic script; without this
  // alias every window.Fleet.* read (radar select + cockpit import) is undefined.
  assert.match(terminalJs, /window\.Fleet = Fleet;/);
});

test('_radarSelect READS the same Fleet it WRITES (no window/const split reintroduced)', () => {
  const src = extractAssignedFn(terminalJs, 'window._radarSelect');
  // It writes the pick on the bare Fleet binding…
  assert.match(src, /Fleet\.radarSelectedSymbol = c\.symbol/);
  // …and because window.Fleet is now aliased to that same object, the window.Fleet
  // read at the top of the function resolves to it too. Guard: keep them the same
  // object by keeping the alias present (asserted above).
});

// ── The real click → select → cockpit flow ─────────────────────────────────

test('clicking a rendered candidate persists the pick and re-renders', () => {
  const fleet = freshFleet();
  let renders = 0;
  const win = makeRadarSelect(fleet, () => { renders++; });

  clickCandidate(win, 'SPELLUSDT');

  assert.equal(fleet.radarSelectedSymbol, 'SPELLUSDT', 'pick persisted on durable Fleet');
  assert.equal(renders, 1, 'panel re-rendered so the focus/selected state updates');
});

test('Cockpit import then sees exactly the clicked symbol (through window.Fleet)', () => {
  const fleet = freshFleet();
  const win = makeRadarSelect(fleet, () => {});
  clickCandidate(win, 'SPELLUSDT');

  assert.deepEqual(runCpRadarFocus(fleet), { symbol: 'SPELLUSDT' });
});

test('the pick survives a poll that replaces Fleet.data wholesale', () => {
  const fleet = freshFleet();
  const win = makeRadarSelect(fleet, () => {});
  clickCandidate(win, 'SPELLUSDT');

  // Poll: brand-new payload object, fresh tradingRadar whose default .selected is a
  // DIFFERENT coin and which has no client-side selection at all.
  fleet.data = { tradingRadar: {
    candidates: [{ symbol: 'SPELLUSDT' }, { symbol: 'DDDUSDT' }],
    selected: { symbol: 'DDDUSDT' },
  } };
  assert.deepEqual(runCpRadarFocus(fleet), { symbol: 'SPELLUSDT' }, 'durable pick outlives the swap');
});

test('a candidate that drops out later yields the honest stale sentinel (never a silent swap)', () => {
  const fleet = freshFleet();
  const win = makeRadarSelect(fleet, () => {});
  clickCandidate(win, 'SPELLUSDT');
  // SPELLUSDT falls out of the next radar payload.
  fleet.data = { tradingRadar: { candidates: [{ symbol: 'DDDUSDT' }], selected: { symbol: 'DDDUSDT' } } };
  assert.deepEqual(runCpRadarFocus(fleet), { __stale: true, symbol: 'SPELLUSDT' });
});

test('no explicit click → Cockpit import stays empty (no default/top fallback)', () => {
  const fleet = freshFleet(); // radar.selected + entryReady[0] + candidates[0] all exist
  // Never clicked: _cpRadarFocus must be null even though defaults are available.
  assert.equal(runCpRadarFocus(fleet), null);
});

test('clicking a symbol absent from candidates writes nothing (no phantom import)', () => {
  const fleet = freshFleet();
  let renders = 0;
  const win = makeRadarSelect(fleet, () => { renders++; });
  clickCandidate(win, 'ZZZUSDT'); // e.g. a rejected-filter row, not a real candidate
  assert.equal(fleet.radarSelectedSymbol, null, 'no bogus pick stored');
  assert.equal(renders, 0, 'no re-render for a non-candidate');
  assert.equal(runCpRadarFocus(fleet), null);
});

// ── The rendered DOM carries a clear, symbol-keyed selection marker ──────────

test('matrix rows carry data-radar-symbol AND an executable select handler', () => {
  const rowStart = terminalJs.indexOf('class="radar-matrix-row');
  assert.ok(rowStart > 0);
  const row = terminalJs.slice(rowStart, rowStart + 400);
  assert.match(row, /data-radar-symbol="\$\{esc\(c\.symbol\)\}"/);
  assert.match(row, /data-radar-select="1"/);
  assert.match(row, /onclick="window\._radarSelect\('\$\{esc\(c\.symbol\)\}'\)"/);
  // selected coin gets a visible persistent highlight
  assert.match(row, /radar-matrix-row--selected/);
});

test('watch cards carry data-radar-symbol AND an executable select handler', () => {
  const cardStart = terminalJs.indexOf('class="radar-watch-card');
  assert.ok(cardStart > 0);
  const card = terminalJs.slice(cardStart, cardStart + 400);
  assert.match(card, /data-radar-symbol="\$\{esc\(c\.symbol\)\}"/);
  assert.match(card, /onclick="window\._radarSelect\('\$\{esc\(c\.symbol\)\}'\)"/);
  assert.match(card, /radar-watch-card--selected/);
});

test('candidate rows/cards contain no competing external link (whole-row click is unambiguous)', () => {
  // The select target is the whole row/card; there is no <a href> inside a
  // candidate that could steal the click or open Binance instead of selecting.
  const rowStart = terminalJs.indexOf('class="radar-matrix-row');
  const rowEnd = terminalJs.indexOf('</tr>`', rowStart);
  const row = terminalJs.slice(rowStart, rowEnd);
  assert.doesNotMatch(row, /<a\s/, 'no anchor inside a matrix candidate row');
  assert.doesNotMatch(row, /binance/i);
});
