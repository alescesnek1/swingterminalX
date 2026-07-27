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

// Pulls a top-level function out of terminal.js so its BEHAVIOUR can be asserted
// rather than its source text.
function extractFunction(name) {
  const start = terminalJs.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  let depth = 0; let i = terminalJs.indexOf('{', start);
  for (let j = i; j < terminalJs.length; j += 1) {
    if (terminalJs[j] === '{') depth += 1;
    else if (terminalJs[j] === '}') { depth -= 1; if (depth === 0) return terminalJs.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// Regression: the mapper put the PAIR in `symbol`, so isOnBinance looked up
// "BTCUSDTUSDT", found nothing, and every canonical row rendered as an
// off-Binance DEX asset with no order book — Bitcoin included.
test('canonical rows identify as Binance assets, keyed by base symbol not pair', () => {
  const sandbox = { BINANCE_USDT_PAIRS: new Set(['BTCUSDT']), BINANCE_USDC_PAIRS: new Set() };
  const make = new Function('BINANCE_USDT_PAIRS', 'BINANCE_USDC_PAIRS', `${extractFunction('_mapCanonicalTicker')}\n${extractFunction('isOnBinance')}\nreturn { _mapCanonicalTicker, isOnBinance };`);
  const { _mapCanonicalTicker, isOnBinance } = make(sandbox.BINANCE_USDT_PAIRS, sandbox.BINANCE_USDC_PAIRS);

  const row = _mapCanonicalTicker({ symbol: 'BTCUSDT', base_asset: 'BTC', quote_asset: 'USDT', market: 'spot', last_price: '101', price_change_percent: '-3', quote_volume: '9e8' });
  assert.equal(row.symbol, 'BTC', 'base asset, not the pair');
  assert.equal(row.pair, 'BTCUSDT', 'the pair is kept for order book lookups');
  assert.equal(row.binance_available, true);
  assert.equal(isOnBinance(row), true, 'a canonical Binance row must never read as DEX');

  // Without base_asset the pair is still split by its quote, not passed through.
  const derived = _mapCanonicalTicker({ symbol: 'ETHUSDC', quote_asset: 'USDC', market: 'spot', last_price: '3000' });
  assert.equal(derived.symbol, 'ETH');
  // Futures rows are tagged so the ALPHA badge resolves instead of DEX.
  assert.equal(_mapCanonicalTicker({ symbol: 'SOLUSDT', base_asset: 'SOL', quote_asset: 'USDT', market: 'futures' }).binance_market, 'futures');

  // loadOrderbook() gates on exchange being exactly 'BIN' or 'ALPHA'; the
  // descriptive 'Binance' sent every canonical coin down the "no book" path.
  assert.equal(row.exchange, 'BIN');
  assert.equal(row.spot_pair, 'BTCUSDT');
  assert.equal(_mapCanonicalTicker({ symbol: 'SOLUSDT', base_asset: 'SOL', quote_asset: 'USDT', market: 'futures' }).exchange, 'ALPHA');
  assert.equal(_mapCanonicalTicker({ symbol: 'SOLUSDT', base_asset: 'SOL', quote_asset: 'USDT', market: 'futures' }).futures_pair, 'SOLUSDT');
});

// The same coin trades on both venues, and canonical rows are keyed by base
// asset, so without a deliberate merge one venue's row silently displaced the
// other and the list came back short of the requested size.
test('spot and futures rows of one coin collapse to a single row, spot preferred', () => {
  const make = new Function(`${extractFunction('_dedupeCanonicalByBase')}\nreturn _dedupeCanonicalByBase;`);
  const dedupe = make();
  const merged = dedupe([
    { symbol: 'BTC', market: 'futures', total_volume: 900 },
    { symbol: 'BTC', market: 'spot', total_volume: 100 },
    { symbol: 'ETH', market: 'futures', total_volume: 50 },
    { symbol: 'SOL', market: 'spot', total_volume: 10 },
    { symbol: 'SOL', market: 'spot', total_volume: 80 },
  ]);
  assert.equal(merged.length, 3, 'one row per coin');
  const btc = merged.find((r) => r.symbol === 'BTC');
  assert.equal(btc.market, 'spot', 'spot wins even on lower volume — it has the order book');
  // A base that only trades on futures is kept, not dropped.
  assert.equal(merged.find((r) => r.symbol === 'ETH').market, 'futures');
  // Within one venue the deeper pair wins.
  assert.equal(merged.find((r) => r.symbol === 'SOL').total_volume, 80);
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
  assert.match(body, /_withCanonicalDiagnostics/);
});

// The provider/absorb panels were prepended, which pushed the real Radar Matrix
// down the page and read as a second, competing table. They belong inside the
// panel's own diagnostics section.
test('canonical panels are folded into the existing diagnostics, not stacked above the matrix', () => {
  const make = new Function(
    `${extractFunction('_renderProviderStatusPanel')}\n${extractFunction('_renderAbsorbDiagnosticsPanel')}\n${extractFunction('_radarStatusClass')}\n${extractFunction('_renderCanonicalRadarPanels')}\n${extractFunction('_withCanonicalDiagnostics')}\nreturn _withCanonicalDiagnostics;`,
  );
  const withDiagnostics = make();
  const esc = (v) => String(v ?? '');
  const anchor = '<details class="radar-diagnostics"><summary>Diagnostics & Logs</summary>';
  const main = `<div class="radar-section-title">Radar Matrix</div><table>MATRIX</table>${anchor}<ul><li>x</li></ul></details>`;
  const out = withDiagnostics(main, { providerStatus: { ABSORB_MODE: 'STRICT' }, candidates: [] }, esc);

  assert.ok(out.indexOf('MATRIX') < out.indexOf('radar-canonical-panels'), 'the matrix still comes first');
  assert.ok(out.indexOf(anchor) < out.indexOf('radar-canonical-panels'), 'panels sit inside the diagnostics section');
  // Without a canonical radar the markup is untouched.
  assert.equal(withDiagnostics(main, null, esc), main);
  // If the anchor is ever renamed the data is appended, never silently dropped.
  assert.match(withDiagnostics('<table>ONLY</table>', { providerStatus: {}, candidates: [] }, esc), /radar-canonical-panels/);
});

// ── the source switch must never be silent ───────────────────────────────────
// The legacy Fleet radar has no server rolling microstructure, so Strict Absorb
// renders "DATA OFF" on every row. Switching to it without saying so is what made
// the panel look self-contradictory: a real canonical verdict one cycle, "DATA OFF"
// the next, with nothing on screen explaining that the data source had changed.
const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');

test('falling back to the legacy radar states the active source and the reason', () => {
  assert.match(terminalJs, /function _radarLegacySourceNoticeHtml\(reason, esc\)/);
  assert.match(terminalJs, /Showing the legacy browser-computed RADAR/);
  // It must say DATA OFF here means a missing source, not a rejected absorption.
  assert.match(terminalJs, /no server rolling microstructure/);
  assert.match(terminalJs, /not<\/b> a rejected absorption/);
  // The reason is escaped, never interpolated raw.
  assert.match(terminalJs, /esc\(String\(reason \|\| 'unknown'\)\)/);
  // And the switch is logged, not just drawn.
  assert.match(terminalJs, /radar panel is showing the legacy browser feed/);
});

test('a failed canonical read replaces the stale context instead of leaving it in place', () => {
  // Previously __canonicalContext was assigned only on success, so a failed fetch
  // left the previous cycle's object rendering as if it were current.
  assert.match(terminalJs, /failed: true, failureReason:/);
  assert.match(terminalJs, /window\.__canonicalContext\.failed \? `\/api\/context failed/);
});

test('every versioned asset carries the same single bumped cache-bust token', () => {
  const tokens = [...indexHtml.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]);
  assert.ok(tokens.length >= 11, 'all versioned assets are still tokenised');
  assert.equal(new Set(tokens).size, 1, 'exactly one token across index.html');
  assert.equal(tokens[0], '6j3', 'token was bumped for this JS change');
});
