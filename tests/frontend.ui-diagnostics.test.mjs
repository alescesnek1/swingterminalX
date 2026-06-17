import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  briefingSourceState,
  sanitizeBriefingDiagnosticReason,
  withBriefingDiagnostics,
} from '../apps/edge/netlify/edge-functions/lib/briefing-diagnostics.js';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

function sliceBetween(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  assert.ok(a >= 0, `missing start marker: ${start}`);
  assert.ok(b > a, `missing end marker: ${end}`);
  return src.slice(a, b);
}

function loadTerminalLinkHelpers() {
  const block = sliceBetween(terminalJs, 'function _compactBinancePair', '// V5: forward Supabase');
  const BINANCE_USDC_PAIRS = new Set(['BTCUSDC']);
  const BINANCE_USDT_PAIRS = new Set(['BTCUSDT']);
  return Function('BINANCE_USDC_PAIRS', 'BINANCE_USDT_PAIRS', `${block}; return { getBinanceLink };`)(BINANCE_USDC_PAIRS, BINANCE_USDT_PAIRS);
}

function loadScannerSortHelpers() {
  const block = sliceBetween(terminalJs, 'let _scannerSort', 'function getFilteredSorted');
  return Function(`${block}; return { _scannerCompare, _scannerC24Value };`)();
}

test('Binance link helper routes spot, futures, Alpha, and unsupported rows safely', () => {
  const { getBinanceLink } = loadTerminalLinkHelpers();

  const spot = getBinanceLink({ symbol: 'BTC', pair: 'BTCUSDT', quote: 'USDT', binance_available: true, binance_market: 'spot' });
  assert.match(spot.url, /\/trade\/BTC_USDT\?type=spot$/);

  const futures = getBinanceLink({ symbol: 'BTC', binance_available: true, binance_market: 'futures', futures_pair: 'BTCUSDT' });
  assert.match(futures.url, /\/futures\/BTCUSDT$/);
  const futuresFromDelimitedPair = getBinanceLink({ symbol: 'BTC', binance_available: true, binance_market: 'futures', futures_pair: 'BTC/USDT' });
  assert.match(futuresFromDelimitedPair.url, /\/futures\/BTCUSDT$/);

  const alpha = getBinanceLink({
    symbol: 'BEATUSDT',
    binance_available: true,
    listingType: 'BINANCE_ALPHA',
    alphaPair: 'ALPHA_451/USDT',
    alphaTokenId: 'ALPHA_451',
  });
  assert.ok(alpha.available);
  assert.equal(alpha.market, 'alpha-search');
  assert.doesNotMatch(alpha.url, /\/futures\/BEATUSDT/);
  assert.match(alpha.url, /\/search\?query=/);

  const unsupported = getBinanceLink({ symbol: 'NOPE', binance_available: false });
  assert.equal(unsupported.available, false);
  assert.equal(unsupported.url, null);
});

test('scanner 24h sort is numeric, reversible, null-last, and default sort is unchanged', () => {
  const { _scannerCompare, _scannerC24Value } = loadScannerSortHelpers();
  const rows = [
    { symbol: 'MID', _sig_score: 9, market_cap: 10, _c24: '12.3%' },
    { symbol: 'LOW', _sig_score: 1, market_cap: 100, price_change_percentage_24h: -8 },
    { symbol: 'HIGH', _sig_score: 2, market_cap: 50, change24h: 30 },
    { symbol: 'MISS', _sig_score: 99, market_cap: 999 },
  ];

  assert.equal(_scannerC24Value(rows[0]), 12.3);
  assert.deepEqual(rows.slice().sort((a, b) => _scannerCompare(a, b, { key: 'c24', dir: 'desc' })).map(r => r.symbol), ['HIGH', 'MID', 'LOW', 'MISS']);
  assert.deepEqual(rows.slice().sort((a, b) => _scannerCompare(a, b, { key: 'c24', dir: 'asc' })).map(r => r.symbol), ['LOW', 'MID', 'HIGH', 'MISS']);
  assert.deepEqual(rows.slice().sort((a, b) => _scannerCompare(a, b, { key: null, dir: null })).map(r => r.symbol), ['MISS', 'MID', 'HIGH', 'LOW']);
});

test('market briefing diagnostics sanitize secrets and expose source states', () => {
  const leaky = 'coingecko HTTP 500 ?auth_token=SECRET&key=AIzaSECRETKEY1234567890abcdef Bearer abc.def.ghi GEMINI_API_KEY=secret';
  const clean = sanitizeBriefingDiagnosticReason(leaky);
  assert.doesNotMatch(clean, /SECRETKEY|abc\.def|GEMINI_API_KEY=secret|auth_token=SECRET/);
  assert.match(clean, /\[redacted/);
  assert.match(clean, /GEMINI_API_KEY=\[redacted\]/);

  const meta = withBriefingDiagnostics(
    { cache_layer: 'degraded' },
    { sources: { top100: briefingSourceState(false, leaky, true) } },
    { ai: briefingSourceState(false, 'gemini-rate-limited', true) },
  );
  assert.equal(meta.sources.top100.ok, false);
  assert.equal(meta.sources.top100.degraded, true);
  assert.equal(meta.sources.ai.reason, 'gemini-rate-limited');
  assert.deepEqual(meta.diagnostics.sources, meta.sources);
});

test('market briefing frontend classifies source, AI, and client-side degradation precisely', async () => {
  globalThis.document = {
    getElementById: () => null,
    addEventListener() {},
    body: { classList: { add() {}, remove() {} } },
    documentElement: { lang: 'cs' },
  };
  globalThis.window = { addEventListener() {} };
  const mod = await import(`../apps/edge/public/js/ai-analysis.js?ui_diag=${Date.now()}`);

  assert.equal(mod.classifyBriefingDegradation({ fallback_reason: 'source-fetch-failed' }).title, 'Market snapshot unavailable');
  assert.equal(mod.classifyBriefingDegradation({ fallback_reason: 'gemini-rate-limited' }).title, 'AI provider rate-limited');
  assert.equal(mod.classifyBriefingDegradation({ fallback_reason: 'gemini-failed' }).title, 'AI synthesis failed');
  assert.equal(mod.classifyBriefingDegradation({}, 'network').title, 'Briefing network degraded');
  assert.equal(mod.classifyBriefingDegradation({}, 'parse').title, 'Briefing response parse degraded');
  assert.equal(mod.classifyBriefingDegradation({}, 'render').title, 'Briefing render degraded');
});
