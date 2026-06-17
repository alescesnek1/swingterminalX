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
  // The detail-button helper depends on _esc / _safeUrl, which live far
  // above the extracted block. Provide equivalent definitions so the
  // helpers can be exercised in isolation.
  const prelude = `
    function _esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function _safeUrl(u){const s=String(u||'').trim();if(!s)return '';if(s.startsWith('https://')||s.startsWith('http://')||s.startsWith('/'))return _esc(s);return '';}
  `;
  return Function('BINANCE_USDC_PAIRS', 'BINANCE_USDT_PAIRS', `${prelude}${block}; return { getBinanceLink, _isBinanceAlphaRow, _binanceSearchLink, _binanceDetailButtonHtml };`)(BINANCE_USDC_PAIRS, BINANCE_USDT_PAIRS);
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

test('Binance Alpha link helpers handle alpha-only row shapes safely', () => {
  const { getBinanceLink, _isBinanceAlphaRow, _binanceSearchLink, _binanceDetailButtonHtml } = loadTerminalLinkHelpers();

  // A — exchange: "ALPHA" is recognised as an Alpha row.
  assert.equal(_isBinanceAlphaRow({ symbol: 'BEATUSDT', exchange: 'ALPHA' }), true);
  // Other reliable indicators also detect.
  assert.equal(_isBinanceAlphaRow({ exchange: 'BINANCE_ALPHA' }), true);
  assert.equal(_isBinanceAlphaRow({ listingType: 'BINANCE_ALPHA' }), true);
  assert.equal(_isBinanceAlphaRow({ listingSource: 'Binance Alpha' }), true);
  assert.equal(_isBinanceAlphaRow({ binanceAlphaListed: true }), true);
  assert.equal(_isBinanceAlphaRow({ alphaPair: 'ALPHA_451/USDT' }), true);
  assert.equal(_isBinanceAlphaRow({ alphaTokenId: 'ALPHA_451' }), true);
  assert.equal(_isBinanceAlphaRow({ binance_market: 'alpha' }), true);
  assert.equal(_isBinanceAlphaRow({ market: 'alpha' }), true);
  assert.equal(_isBinanceAlphaRow({ source: 'binance-alpha' }), true);
  assert.equal(_isBinanceAlphaRow({ safetyReason: 'LISTED_VIA_BINANCE_ALPHA' }), true);
  assert.equal(_isBinanceAlphaRow({ tags: ['ALPHA', 'NEW'] }), true);
  // Non-Alpha rows stay false.
  assert.equal(_isBinanceAlphaRow({ symbol: 'BTC', exchange: 'BINANCE' }), false);
  assert.equal(_isBinanceAlphaRow({ symbol: 'BTC' }), false);

  // B — object input never collapses to [object Object] and keeps BEATUSDT.
  const objLink = _binanceSearchLink({ symbol: 'BEATUSDT', exchange: 'ALPHA' });
  assert.doesNotMatch(objLink, /\[object Object\]/);
  assert.doesNotMatch(objLink, /%5[Bb]object/);
  assert.match(objLink, /query=BEATUSDT/);
  // String input still works.
  assert.match(_binanceSearchLink('BEATUSDT ALPHA_451/USDT'), /query=BEATUSDT\+ALPHA_451/);

  // C — exchange-only Alpha row gets a safe alpha-search fallback.
  const alphaExchange = getBinanceLink({ symbol: 'BEATUSDT', exchange: 'ALPHA' });
  assert.equal(alphaExchange.available, true);
  assert.equal(alphaExchange.market, 'alpha-search');
  assert.match(alphaExchange.url, /query=BEATUSDT/);
  assert.doesNotMatch(alphaExchange.url, /\/futures\/BEATUSDT/);

  // D — alphaPair-only row keeps the existing good behaviour.
  const alphaPair = getBinanceLink({ symbol: 'BEATUSDT', alphaPair: 'ALPHA_451/USDT' });
  assert.equal(alphaPair.available, true);
  assert.equal(alphaPair.market, 'alpha-search');
  assert.match(alphaPair.url, /query=BEATUSDT/);
  assert.match(alphaPair.url, /ALPHA_451/);
  assert.doesNotMatch(alphaPair.url, /\/futures\/BEATUSDT/);

  // E + F — right detail panel HTML for an Alpha row.
  const alphaHtml = _binanceDetailButtonHtml(alphaExchange);
  assert.doesNotMatch(alphaHtml, /\/futures\/BEATUSDT/);
  assert.doesNotMatch(alphaHtml, /BINANCE FUTURES \(ALPHA\)/);
  assert.match(alphaHtml, /BINANCE ALPHA SEARCH/);
  assert.match(alphaHtml, /BEATUSDT/);

  // G — futures BTCUSDT still resolves to /futures/BTCUSDT.
  const futures = getBinanceLink({ symbol: 'BTC', binance_available: true, binance_market: 'futures', futures_pair: 'BTCUSDT' });
  assert.match(futures.url, /\/futures\/BTCUSDT$/);
  assert.match(_binanceDetailButtonHtml(futures), /BINANCE FUTURES/);
  assert.doesNotMatch(_binanceDetailButtonHtml(futures), /\(ALPHA\)/);

  // H — spot BTCUSDT still resolves to /trade/BTC_USDT.
  const spot = getBinanceLink({ symbol: 'BTC', pair: 'BTCUSDT', quote: 'USDT', binance_available: true, binance_market: 'spot' });
  assert.match(spot.url, /\/trade\/BTC_USDT/);

  // Unsupported non-Binance row renders a disabled chip, not a broken href.
  const disabledHtml = _binanceDetailButtonHtml({ url: null, available: false });
  assert.match(disabledHtml, /binance-btn unavail/);
  assert.doesNotMatch(disabledHtml, /<a /);
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
