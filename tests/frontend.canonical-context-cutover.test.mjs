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
  // Pinned on purpose: bumping this literal is the deliberate act that proves a
  // JS/CSS change was paired with a cache-bust. 6j8 → 6k1 for the central client
  // error log; 6k1 → 6k2 for the native-auth browser switch (auth-client.js and
  // admin-users-panel.js added, terminal.js auth wiring changed); 6k2 -> 6k3 for the
  // Cockpit miss diagnosis (terminal.js renders a publisher outage distinctly from a
  // coverage gap).
  assert.equal(tokens[0], '6k3', 'token was bumped for this JS change');
});

// The measurement budget targets the deepest drawdowns, and DISLOCATION is 20% of
// SETUP_SCORE, so measured coins are also the highest-setup coins and sort to the top.
// The default 20-row window is then often entirely measured and every visible row
// legitimately reads STRICT OK -- which looks like "STRICT OK on everything", i.e.
// like a bug. Stating the coverage split is what distinguishes "all measured" from
// "all confirmed".
test('the RADAR matrix states microstructure coverage for shown rows and all candidates', () => {
  assert.match(terminalJs, /const _measuredOf = \(list\) =>/);
  assert.match(terminalJs, /rollingMicrostructurePresent === true/);
  assert.match(terminalJs, /shown rows/);
  assert.match(terminalJs, /candidates carry it/);
  // It must say STRICT N/A is neither a confirmation nor a rejection.
  assert.match(terminalJs, /neither a confirmed nor a rejected absorption/);
  // And when the whole window is measured, say so instead of implying universe-wide.
  assert.match(terminalJs, /reflects the measured set, not the whole universe/);
  // Counts are escaped, never interpolated raw.
  assert.match(terminalJs, /esc\(String\(_shownMeasured\)\)/);
  assert.match(terminalJs, /esc\(String\(_totalMeasured\)\)/);
});

// The canonical read is a BROWSER flag; a server env var cannot enable it. With it off
// the terminal served the legacy feed silently, and the legacy feed has NO 4h and NO
// 12h change at all -- so those scanner columns were blank with nothing on screen
// saying why, or even that a switch existed.
test('a disabled canonical read is announced, and names the browser flag', () => {
  assert.match(terminalJs, /the canonical read is DISABLED in this browser/);
  assert.match(terminalJs, /radarCanonicalContextRead/);
  assert.match(terminalJs, /a server env var cannot enable it/);
});

test('the legacy notice states which timeframe columns the fallback costs', () => {
  assert.match(terminalJs, /no 4h and no 12h change/);
  assert.match(terminalJs, /24h is unaffected/);
});

test('the legacy notice renders whether the flag is off, failed, or pending', () => {
  // Every legacy render must go through the notice. The disabled case was hidden by an
  // `else` branch that rendered the legacy radar with no notice at all.
  assert.match(terminalJs, /_radarLegacySourceNoticeHtml\(reason, _esc\) \+ _renderTradingRadar\(fleetRadar, _esc\)/);
  // The un-annotated legacy render must exist ONLY as the try/catch shape guard.
  const bare = [...terminalJs.matchAll(/mainHtml = _renderTradingRadar\(fleetRadar, _esc\)/g)];
  assert.equal(bare.length, 1, 'exactly one un-annotated legacy render remains (the shape-error guard)');
  assert.match(terminalJs.slice(bare[0].index - 220, bare[0].index), /catch \(e\)/, 'and it sits inside the catch');
});

// ── Market cap: the canonical feed has none, so it is enriched from /api/markets ──
//
// `market_ticker_observations` is Binance ticker data and has no market-cap column,
// so /api/context can never supply one. Every canonical row arrived with market_cap
// absent, which blanked market cap across the UI and silently collapsed the heatmap's
// "sorted by market cap" ordering into "whatever order the rows arrived in".

function extractAsyncFunction(name) {
  const start = terminalJs.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  let depth = 0;
  for (let j = terminalJs.indexOf('{', start); j < terminalJs.length; j += 1) {
    if (terminalJs[j] === '{') depth += 1;
    else if (terminalJs[j] === '}') { depth -= 1; if (depth === 0) return terminalJs.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

function makeEnricher(fetchStub, win) {
  const make = new Function('fetch', 'window', 'console',
    `${extractAsyncFunction('_enrichCanonicalWithMarketCap')}\nreturn _enrichCanonicalWithMarketCap;`);
  return make(fetchStub, win, { warn() {}, error() {} });
}

test('canonical rows are enriched with market cap, and market_cap 0 stays UNKNOWN', async () => {
  const seen = [];
  const fetchStub = async (url) => {
    seen.push(url);
    return { ok: true, json: async () => ([
      { symbol: 'BTC', market_cap: 2e12, market_cap_rank: 1 },
      { symbol: 'ETH:USDT', market_cap: 4e11, market_cap_rank: 2 },
      // /api/markets marks a Binance-only listing with no CoinGecko entry as 0 —
      // that is "unknown", never "worth nothing".
      { symbol: 'ONLYBIN', market_cap: 0, market_cap_rank: 0 },
    ]) };
  };
  const win = {};
  const enrich = makeEnricher(fetchStub, win);
  const rows = [{ symbol: 'BTC' }, { symbol: 'ETH' }, { symbol: 'ONLYBIN' }, { symbol: 'UNLISTED' }];

  await enrich(rows, {});

  assert.deepEqual(seen, ['/api/markets']);
  assert.equal(rows[0].market_cap, 2e12);
  assert.equal(rows[0].market_cap_rank, 1);
  assert.equal(rows[1].market_cap, 4e11, 'pair suffix is stripped before matching');
  assert.equal('market_cap' in rows[2], false, 'a 0 market cap must not be copied as a real value');
  assert.equal('market_cap' in rows[3], false, 'a coin outside the CG universe stays absent');
  assert.equal(win.__marketCapEnrichment.ok, true);
  assert.equal(win.__marketCapEnrichment.matched, 2);
  assert.equal(win.__marketCapEnrichment.total, 4);
});

test('a failed market-cap enrichment is recorded and leaves rows absent, never 0', async () => {
  const win = {};
  const enrich = makeEnricher(async () => ({ ok: false, status: 503, text: async () => '' }), win);
  const rows = [{ symbol: 'BTC' }];

  await enrich(rows, {});

  assert.equal('market_cap' in rows[0], false, 'a failed fetch must not fabricate a market cap');
  assert.equal(win.__marketCapEnrichment.ok, false);
  assert.match(win.__marketCapEnrichment.reason, /HTTP 503/);
});

test('the canonical fetch runs the market-cap enrichment', () => {
  assert.match(terminalJs, /await _enrichCanonicalWithMarketCap\(rows, authHeaders\)/);
});
