import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

test('canonical context read is additive: OFF by default with a legacy fallback', () => {
  assert.match(terminalJs, /function _canonicalContextEnabled\(\)/);
  // Default OFF: only an explicit true / localStorage opt-in enables it.
  assert.match(terminalJs, /RADAR_CANONICAL_CONTEXT_READ === true/);
  assert.match(terminalJs, /radarCanonicalContextRead'\) === 'true'/);
  // The legacy /api/markets path is still present and used when canonical is off
  // or fails (fallback), never removed.
  assert.match(terminalJs, /fetch\('\/api\/markets'/);
  assert.match(terminalJs, /if \(!live\) \{/);
});

test('canonical fetch reads /api/context and falls back honestly on failure', () => {
  assert.match(terminalJs, /function _fetchCanonicalMarkets\(/);
  assert.match(terminalJs, /fetch\('\/api\/context'/);
  // Failure surfaces an error and falls through to the legacy feed (never silent).
  assert.match(terminalJs, /falling back to \/api\/markets/i);
  assert.match(terminalJs, /Canonical context unavailable/);
});

test('missing multi-timeframe fields are left absent (UNKNOWN), never fabricated', () => {
  assert.match(terminalJs, /function _mapCanonicalTicker\(/);
  // Only set the timeframe when the source value is present.
  assert.match(terminalJs, /if \(c1 != null\) row\._c1 = c1;/);
  assert.match(terminalJs, /if \(c4 != null\) row\._c4 = c4;/);
  assert.match(terminalJs, /if \(c12 != null\) row\._c12 = c12;/);
});

test('canonical RADAR + provider status are exposed for the RADAR/Absorb panels', () => {
  assert.match(terminalJs, /window\.__canonicalContext = \{ radar: j\.radar/);
});

const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');

test('Provider Status + Absorb Diagnostics panels render from canonical radar', () => {
  assert.match(terminalJs, /function _renderProviderStatusPanel\(/);
  assert.match(terminalJs, /function _renderAbsorbDiagnosticsPanel\(/);
  assert.match(terminalJs, /Provider Status/);
  assert.match(terminalJs, /Absorb Diagnostics/);
  assert.match(terminalJs, /MICROSTRUCTURE_PROVIDER/);
  assert.match(terminalJs, /STRICT_ABSORB_STATUS/);
  assert.match(terminalCss, /\.radar-absorb-table/);
  assert.match(terminalCss, /\.radar-provider-grid/);
});

test('RADAR panel prefers a READY canonical radar and falls back to Fleet', () => {
  const body = terminalJs.slice(terminalJs.indexOf('function renderTradingRadarPanel()'));
  assert.match(body, /_canonicalContextEnabled\(\)/);
  assert.match(body, /status \|\| ''\)\.toUpperCase\(\) === 'READY'/);
  assert.match(body, /fell back to Fleet/);
  assert.match(body, /_renderCanonicalRadarPanels/);
});
