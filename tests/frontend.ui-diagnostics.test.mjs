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
  return Function('BINANCE_USDC_PAIRS', 'BINANCE_USDT_PAIRS', `${prelude}${block}; return { getBinanceLink, _isBinanceAlphaRow, _binanceSearchLink, _binanceDetailButtonHtml, _binanceDetailLinksHtml };`)(BINANCE_USDC_PAIRS, BINANCE_USDT_PAIRS);
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

  // True Alpha row WITH a validated chain + EVM contract -> direct page.
  const alphaDirect = getBinanceLink({ symbol: 'BEAT', alphaTokenId: 'ALPHA_451', alphaChain: 'BSC', alphaContractAddress: '0xcf3232b85b43bca90e51d38cc06cc8bb8c8a3e36' });
  assert.ok(alphaDirect.available);
  assert.equal(alphaDirect.market, 'alpha');
  assert.equal(alphaDirect.url, 'https://www.binance.com/en/alpha/bsc/0xcf3232b85b43bca90e51d38cc06cc8bb8c8a3e36');

  // True Alpha row WITHOUT chain+contract -> unavailable (no fake link).
  const alphaBare = getBinanceLink({ symbol: 'BEAT', alphaTokenId: 'ALPHA_451' });
  assert.equal(alphaBare.available, false);
  assert.equal(alphaBare.url, null);
  assert.equal(alphaBare.market, 'alpha-unavailable');

  const unsupported = getBinanceLink({ symbol: 'NOPE', binance_available: false });
  assert.equal(unsupported.available, false);
  assert.equal(unsupported.url, null);
});

test('exchange:"ALPHA" (futures nickname) is NOT treated as Binance Alpha', () => {
  const { getBinanceLink, _isBinanceAlphaRow } = loadTerminalLinkHelpers();

  // The /api/markets feed badges futures-listed coins exchange:'ALPHA'.
  // That alone must NOT classify a row as the Binance Alpha early-token
  // product — otherwise valid futures links get suppressed.
  assert.equal(_isBinanceAlphaRow({ symbol: 'BEATUSDT', exchange: 'ALPHA' }), false);
  assert.equal(_isBinanceAlphaRow({ symbol: 'BEATUSDT', exchange: 'ALPHA', binance_market: 'futures' }), false);
  assert.equal(_isBinanceAlphaRow({ binance_market: 'alpha' }), false);
  assert.equal(_isBinanceAlphaRow({ market: 'alpha' }), false);
  assert.equal(_isBinanceAlphaRow({ tags: ['ALPHA'] }), false);
  assert.equal(_isBinanceAlphaRow({ symbol: 'BTC', exchange: 'BINANCE' }), false);

  // A futures-badged BEAT row resolves to its REAL futures link.
  const beatFutures = getBinanceLink({ symbol: 'BEAT', exchange: 'ALPHA', binance_market: 'futures', futures_pair: 'BEATUSDT', binance_available: true });
  assert.equal(beatFutures.market, 'futures');
  assert.equal(beatFutures.url, 'https://www.binance.com/en/futures/BEATUSDT');

  // Strong, unambiguous Alpha signals still classify correctly.
  assert.equal(_isBinanceAlphaRow({ exchange: 'BINANCE_ALPHA' }), true);
  assert.equal(_isBinanceAlphaRow({ listingType: 'BINANCE_ALPHA' }), true);
  assert.equal(_isBinanceAlphaRow({ listingSource: 'Binance Alpha' }), true);
  assert.equal(_isBinanceAlphaRow({ binanceAlphaListed: true }), true);
  assert.equal(_isBinanceAlphaRow({ alphaTokenId: 'ALPHA_451' }), true);
  assert.equal(_isBinanceAlphaRow({ alphaPair: 'BEAT/USDT' }), true);
  assert.equal(_isBinanceAlphaRow({ source: 'binance-alpha' }), true);
  assert.equal(_isBinanceAlphaRow({ safetyReason: 'BINANCE_ALPHA_LISTED_ACTIVE' }), true);
});

test('BEAT-shaped row renders futures primary + Binance Alpha secondary deep link', () => {
  const { _binanceDetailLinksHtml } = loadTerminalLinkHelpers();

  // The canonical /api/markets BEAT row: futures-listed (exchange:'ALPHA'
  // nickname) AND a true Binance Alpha token with chain+contract.
  const beat = {
    symbol: 'BEAT',
    exchange: 'ALPHA',
    binance_market: 'futures',
    futures_pair: 'BEATUSDT',
    binance_available: true,
    binanceAlphaListed: true,
    alphaTokenId: 'ALPHA_451',
    alphaPair: 'BEAT/USDT',
    alphaChain: 'BSC',
    alphaContractAddress: '0xcf3232b85b43bca90e51d38cc06cc8bb8c8a3e36',
  };
  const html = _binanceDetailLinksHtml(beat);

  // Primary: real futures link, honest label (never "FUTURES (ALPHA)").
  assert.match(html, /BINANCE FUTURES → BEATUSDT/);
  assert.match(html, /\/en\/futures\/BEATUSDT/);
  assert.doesNotMatch(html, /BINANCE FUTURES \(ALPHA\)/);

  // Secondary: verified direct Binance Alpha deep link.
  assert.match(html, /BINANCE ALPHA → BEAT/);
  assert.match(html, /\/en\/alpha\/bsc\/0xcf3232b85b43bca90e51d38cc06cc8bb8c8a3e36/);

  // Never weak/landing/object fallbacks.
  assert.doesNotMatch(html, /\/search\?query=/);
  assert.doesNotMatch(html, /href="https:\/\/www\.binance\.com\/en\/alpha"/);
  assert.doesNotMatch(html, /\[object Object\]/);

  // A true Alpha row that is futures-listed but MISSING chain+contract:
  // futures primary stays, alpha secondary is an honest disabled chip.
  const beatNoContract = { ...beat, alphaChain: null, alphaContractAddress: null };
  const html2 = _binanceDetailLinksHtml(beatNoContract);
  assert.match(html2, /BINANCE FUTURES → BEATUSDT/);
  assert.match(html2, /BINANCE ALPHA LINK N\/A/);
  assert.match(html2, /Missing chain\/contract metadata/);
});

test('Binance Alpha helpers: object-safety, chain normalization, and disabled chips', () => {
  const { getBinanceLink, _binanceSearchLink, _binanceDetailButtonHtml } = loadTerminalLinkHelpers();

  // _binanceSearchLink stays object-safe (used elsewhere for query building).
  const objLink = _binanceSearchLink({ symbol: 'BEATUSDT', exchange: 'ALPHA' });
  assert.doesNotMatch(objLink, /\[object Object\]/);
  assert.doesNotMatch(objLink, /%5[Bb]object/);
  assert.match(objLink, /query=BEATUSDT/);

  // Chain aliases normalize to bsc for the direct Alpha deep link.
  assert.match(getBinanceLink({ alphaTokenId: 'X', symbol: 'X', alphaChain: 'BNB Smart Chain', alphaContractAddress: '0x0a43fc31a73013089df59194872ecae4cae14444' }).url, /\/alpha\/bsc\//);

  // Invalid contract -> no direct link, honest disabled chip.
  const bad = getBinanceLink({ symbol: 'BEAT', alphaTokenId: 'ALPHA_451', alphaChain: 'bsc', alphaContractAddress: 'bad' });
  assert.equal(bad.available, false);
  assert.equal(bad.market, 'alpha-unavailable');
  const badHtml = _binanceDetailButtonHtml(bad);
  assert.doesNotMatch(badHtml, /<a /);
  assert.match(badHtml, /BINANCE ALPHA LINK N\/A/);

  // Unsupported chain (valid EVM contract) -> still no direct link.
  const poly = getBinanceLink({ symbol: 'FOO', alphaTokenId: 'ALPHA_9', alphaChain: 'polygon', alphaContractAddress: '0x0a43fc31a73013089df59194872ecae4cae14444' });
  assert.equal(poly.available, false);
  assert.equal(poly.market, 'alpha-unavailable');

  // Disabled/unavailable rows never emit an anchor or broken href.
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
