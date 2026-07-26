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
