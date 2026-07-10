// Frontend source + behavior guards for the RADAR → Cockpit operator flow fix.
//
// Covers four operator-facing UX bugs surfaced in production:
//   A) The operator's RADAR pick must survive polls/tab switches and reach the
//      Cockpit import panel (durable Fleet.radarSelectedSymbol, resolved live).
//   B) Trade Readiness "Missing data" must render human labels, never raw
//      camelCase internal field names.
//   C) Unavailable Pressure Zones must render a compact muted one-liner, not a
//      full titled/bordered panel.
//   D) The Cockpit import panel must clearly show the selected-from-RADAR origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');

// Extract a top-level `function NAME(...) { ... }` body by brace-matching, so a
// pure display helper can be executed in isolation (no browser/DOM required).
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  assert.ok(start >= 0, `could not find ${sig}`);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// ── A) RADAR → Cockpit selected-candidate persistence ───────────────────────

test('A: operator RADAR pick is persisted on the durable Fleet object (survives poll swap)', () => {
  // Fleet (not Fleet.data — which is replaced wholesale each poll) carries the pick
  assert.match(terminalJs, /radarSelectedSymbol: null/);
  assert.match(terminalJs, /Fleet\.radarSelectedSymbol = c\.symbol/);
});

test('A: Cockpit focus resolves the persisted symbol against current candidates', () => {
  const block = extractFn(terminalJs, '_cpRadarFocus');
  assert.match(block, /Fleet\.radarSelectedSymbol/);
  assert.match(block, /candidates\.find\(\(c\) => c && c\.symbol === picked\)/);
  // present → return the live candidate; gone → honest stale sentinel
  assert.match(block, /return \{ __stale: true, symbol: picked \}/);
});

// Execute _cpRadarFocus against a mock window.Fleet to PROVE the Cockpit import
// focus only ever comes from an explicit click and never a default/top fallback.
function runCpRadarFocus(fleet) {
  const fnSrc = extractFn(terminalJs, '_cpRadarFocus');
  // eslint-disable-next-line no-new-func
  return new Function('window', `${fnSrc}; return _cpRadarFocus();`)({ Fleet: fleet });
}

test('A: Cockpit import does NOT fall back to a default/top candidate (no explicit click → null)', () => {
  const radar = {
    candidates: [{ symbol: 'AAAUSDT' }, { symbol: 'BBBUSDT' }],
    selected: { symbol: 'AAAUSDT' },       // radar's own default focus
    entryReady: [{ symbol: 'CCCUSDT' }],   // a first-entry-ready default
  };
  // No explicit pick: even though radar.selected / entryReady[0] / candidates[0]
  // all exist, Cockpit import focus must be null (empty state).
  assert.equal(runCpRadarFocus({ data: { tradingRadar: radar }, radarSelectedSymbol: null }), null);
  assert.equal(runCpRadarFocus({ data: { tradingRadar: radar }, radarSelectedSymbol: '' }), null);
});

test('A: explicit click resolves live; explicit-but-missing yields the stale sentinel', () => {
  const radar = { candidates: [{ symbol: 'AAAUSDT' }, { symbol: 'BBBUSDT' }], selected: { symbol: 'AAAUSDT' } };
  // Explicit pick present in candidates → that exact candidate (never candidates[0]).
  assert.deepEqual(
    runCpRadarFocus({ data: { tradingRadar: radar }, radarSelectedSymbol: 'BBBUSDT' }),
    { symbol: 'BBBUSDT' },
  );
  // Explicit pick no longer in candidates → stale sentinel, not a default coin.
  assert.deepEqual(
    runCpRadarFocus({ data: { tradingRadar: radar }, radarSelectedSymbol: 'ZZZUSDT' }),
    { __stale: true, symbol: 'ZZZUSDT' },
  );
});

test('A: a poll that replaces Fleet.data does not lose the explicit pick', () => {
  const before = { candidates: [{ symbol: 'AAAUSDT' }, { symbol: 'SPELLUSDT' }], selected: { symbol: 'AAAUSDT' } };
  const fleet = { data: { tradingRadar: before }, radarSelectedSymbol: 'SPELLUSDT' };
  assert.deepEqual(runCpRadarFocus(fleet), { symbol: 'SPELLUSDT' });
  // Simulate a poll: Fleet.data replaced wholesale with a fresh payload object
  // whose tradingRadar has NO client `.selected`. The durable pick still resolves.
  fleet.data = { tradingRadar: { candidates: [{ symbol: 'SPELLUSDT' }, { symbol: 'DDDUSDT' }], selected: { symbol: 'DDDUSDT' } } };
  assert.deepEqual(runCpRadarFocus(fleet), { symbol: 'SPELLUSDT' });
});

test('A: stale/missing pick shows an honest "pick again" state, never a silent swap', () => {
  assert.match(terminalJs, /is no longer available — pick again/);
  // and the import prefill refuses the stale sentinel so no phantom levels import
  const pre = extractFn(terminalJs, '_cpPrefillFromRadar');
  assert.match(pre, /if \(!c \|\| c\.__stale\) return null/);
});

test('A: import prefill carries only trade levels — never pressureZones / tradeReadiness', () => {
  const block = extractFn(terminalJs, '_cpPrefillFromRadar');
  for (const f of ['symbol:', 'entryPrice:', 'stopLoss:', 'hardInvalidation:', 'tp1:', 'tp2:', 'tp3:', 'safetyStatus:', 'fromRadar: true']) {
    assert.ok(block.includes(f), `prefill must preserve ${f}`);
  }
  assert.doesNotMatch(block, /pressureZones|tradeReadiness/);
});

test('A: RADAR focus render honors the persisted pick (poll cannot yank focus off it)', () => {
  assert.match(terminalJs, /const _pickedSym = \(typeof Fleet !== 'undefined' && Fleet && Fleet\.radarSelectedSymbol\)/);
  assert.match(terminalJs, /const selected = _picked \|\| radar\.selected \|\| candidates\[0\] \|\| null/);
});

// ── B) Humanized Trade Readiness "Missing data" ─────────────────────────────

test('B: Missing data renders through the humanizer, not raw candidate keys', () => {
  assert.match(terminalJs, /Missing data:<\/b> \$\{joinList\(\(Array\.isArray\(tr\.missing\) \? tr\.missing : \[\]\)\.map\(_radarHumanizeSignal\)\)\}/);
});

test('B: humanizer maps every required key and never emits camelCase output', () => {
  // Execute the real helper in isolation.
  const fnSrc = extractFn(terminalJs, '_radarHumanizeSignal');
  // eslint-disable-next-line no-new-func
  const _radarHumanizeSignal = new Function(`${fnSrc}; return _radarHumanizeSignal;`)();

  const cases = {
    orderBookDepthWithinPct: 'orderbook depth',
    orderBookDepthWithin1Pct: 'orderbook depth',
    spreadPct: 'spread',
    openInterestChangePct: 'open interest',
    fundingRate: 'funding',
    longLiquidationSpike: 'long liquidation spike',
    shortLiquidationSpike: 'short liquidation spike',
    marketSellRatio: 'market sell ratio',
    bidDepthRebuildPct: 'bid depth rebuild',
    derivatives: 'derivatives',
    flow: 'rolling flow',
    provider: 'provider',
    safety: 'safety',
  };
  for (const [key, label] of Object.entries(cases)) {
    assert.equal(_radarHumanizeSignal(key), label, `${key} → ${label}`);
  }

  // Human-worded input (already contains a space) passes through untouched.
  assert.equal(_radarHumanizeSignal('rolling flow'), 'rolling flow');

  // No output — mapped OR fallback — may contain a raw camelCase boundary.
  const camel = /[a-z][A-Z]/;
  const allKeys = [...Object.keys(cases), 'someUnmappedFieldPct', 'anotherWeirdKey'];
  for (const key of allKeys) {
    assert.doesNotMatch(_radarHumanizeSignal(key), camel, `humanized("${key}") must not be camelCase`);
  }
});

test('B: Trade Readiness uses no forbidden wording', () => {
  assert.doesNotMatch(terminalJs, /liquidation heatmap/i);
  assert.doesNotMatch(terminalJs, /\bCVD\b/);
  assert.doesNotMatch(terminalJs, /whale orders/i);
  assert.doesNotMatch(terminalJs, /guaranteed absorption/i);
  assert.doesNotMatch(terminalJs, /confirmed liquidation/i);
});

// ── C) Pressure Zones unavailable is compact, not a big panel ───────────────

test('C: available Pressure Zones still renders the full supporting-context panel', () => {
  assert.match(terminalJs, /class="radar-microstructure radar-pressure-zones">/);
  assert.ok(terminalJs.includes('PRESSURE ZONES · derived proxy — not liquidation data'));
});

test('C: unavailable Pressure Zones renders a compact muted one-liner, not a titled panel', () => {
  // isolate the unavailable branch and assert it is the mini one-liner
  const marker = "if (!pz || pz.available !== true) {";
  const start = terminalJs.indexOf(marker);
  assert.ok(start > 0);
  const block = terminalJs.slice(start, start + 500);
  assert.match(block, /radar-pressure-zones-mini/);
  assert.ok(block.includes('Pressure Zones unavailable — no fresh closed candle snapshot'));
  // the unavailable branch must NOT rebuild the heavy titled/bordered panel
  assert.doesNotMatch(block, /radar-microstructure__title/);
  assert.match(terminalCss, /\.radar-pressure-zones-mini\{[^}]*font-size:10px/);
});

test('C: Advanced diagnostics stays collapsed by default (no forced open)', () => {
  assert.match(terminalJs, /<details class="radar-advanced-diagnostics"/);
  assert.doesNotMatch(terminalJs, /<details class="radar-advanced-diagnostics"[^>]*\sopen>/);
});

// ── D) Scanner → RADAR → Cockpit clarity copy ───────────────────────────────

test('D: Cockpit import panel names the selected RADAR symbol and origin', () => {
  assert.match(terminalJs, /Ready to import \$\{_esc\(f\.symbol\)\} from Trading RADAR/);
  assert.match(terminalJs, /Selected from RADAR: <b>\$\{_esc\(f\.symbol\)\}<\/b>/);
  assert.match(terminalCss, /\.cockpit-radar-focus__selected/);
});
