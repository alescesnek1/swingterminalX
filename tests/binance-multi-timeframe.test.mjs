import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMultiTimeframe } from '../netlify/functions/_binance-market-context-source.mjs';

function fakeFetch(perWindow, seen) {
  return async (url) => {
    const u = new URL(url);
    if (u.pathname !== '/api/v3/ticker') throw new Error(`unexpected path ${u.pathname}`);
    const windowSize = u.searchParams.get('windowSize');
    const symbols = JSON.parse(u.searchParams.get('symbols'));
    if (seen) seen.push({ windowSize, count: symbols.length });
    const pct = perWindow[windowSize];
    return { ok: true, json: async () => symbols.map((s) => ({ symbol: s, priceChangePercent: String(pct) })) };
  };
}
// quoteAsset is required: the top-N ranking only compares symbols quoted in a
// USD stablecoin, so a fiat pair's exchange-rate-inflated quoteVolume cannot
// outrank a major. See rankByQuoteVolume in _binance-market-context-source.mjs.
const tickers = [
  { symbol: 'AUSDT', quoteAsset: 'USDT', quoteVolume: 100 }, { symbol: 'BUSDT', quoteAsset: 'USDT', quoteVolume: 90 }, { symbol: 'CUSDT', quoteAsset: 'USDT', quoteVolume: 80 },
  { symbol: 'DUSDT', quoteAsset: 'USDT', quoteVolume: 10 }, { symbol: 'EUSDT', quoteAsset: 'USDT', quoteVolume: 5 },
];

test('multi-timeframe is bounded to top-N by volume; the long tail stays UNKNOWN', async () => {
  const seen = [];
  const result = await collectMultiTimeframe('spot', tickers, { fetchImpl: fakeFetch({ '1h': 1.5, '4h': -2, '12h': 3, '7d': 10 }, seen), topN: 3 });
  assert.equal(result.requested, 3);
  assert.equal(result.covered, 3);
  const a = result.symbols.get('AUSDT');
  assert.equal(a.change1hPct, 1.5);
  assert.equal(a.change4hPct, -2);
  assert.equal(a.change12hPct, 3);
  assert.equal(a.change7dPct, 10);
  // Symbols outside the top-N are never requested and carry no fabricated values.
  assert.equal(result.symbols.get('DUSDT'), undefined);
  assert.equal(result.symbols.get('EUSDT'), undefined);
  // One request per window (4 windows), 3 symbols fit in a single batch.
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.map((s) => s.windowSize).sort(), ['12h', '1h', '4h', '7d']);
});

test('a failed window batch leaves those fields absent, not zero', async () => {
  const flaky = async (url) => {
    const u = new URL(url);
    if (u.searchParams.get('windowSize') === '4h') throw new Error('HTTP 429');
    const symbols = JSON.parse(u.searchParams.get('symbols'));
    return { ok: true, json: async () => symbols.map((s) => ({ symbol: s, priceChangePercent: '2' })) };
  };
  const result = await collectMultiTimeframe('spot', tickers, { fetchImpl: flaky, topN: 2 });
  const a = result.symbols.get('AUSDT');
  assert.equal(a.change1hPct, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(a, 'change4hPct'), false);
});
