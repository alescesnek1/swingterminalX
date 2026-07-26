import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBinancePublicUrl, fetchBinancePublicJson, collectBinanceMarketContext, collectMultiTimeframe, rankByQuoteVolume } from '../netlify/functions/_binance-market-context-source.mjs';
const json = (body) => ({ ok: true, json: async () => body });
function mockFetch({ failDepth = false, failFutures = false } = {}) { return async (url) => { const parsed = new URL(url); const path = parsed.pathname; if (failFutures && parsed.origin === 'https://fapi.binance.com') return { ok: false, status: 451, json: async () => ({}) }; if (failDepth && path.endsWith('/depth')) return { ok: false, status: 451, json: async () => ({}) }; if (path.endsWith('/exchangeInfo')) return json({ symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', isSpotTradingAllowed: true, baseAsset: 'BTC', quoteAsset: 'USDT' }] }); if (path.endsWith('/ticker/24hr')) return json([{ symbol: 'BTCUSDT', lastPrice: '100', priceChangePercent: '1', highPrice: '101', lowPrice: '99', volume: '4', quoteVolume: '400', count: 2 }]); if (path.endsWith('/klines')) return json([[1, '1', '2', '0', '1', '5', 2, '5', 1]]); if (path.endsWith('/depth')) return json({ lastUpdateId: 7, bids: [['99', '1']], asks: [['101', '1']] }); if (path.endsWith('/aggTrades')) return json([{ a: 9, p: '100', q: '1', m: false, T: 1000, M: true }]); throw new Error('unexpected endpoint'); }; }
test('Binance source rejects a non-allowlisted host and path', async () => { await assert.rejects(() => fetchBinancePublicJson('https://evil.example/api/v3/ticker/24hr'), /NOT_ALLOWED/); await assert.rejects(() => fetchBinancePublicJson('https://api.binance.com/api/v3/ticker/24hr'), /NOT_ALLOWED/); assert.match(buildBinancePublicUrl('spot', 'ticker'), /^https:\/\/data-api\.binance\.vision\/api\/v3\/ticker\/24hr$/); });
test('source exposes bounded atomic raw inputs and partial evidence honestly', async () => { const full = await collectBinanceMarketContext({ fetchImpl: mockFetch(), microstructureTopN: 1 }); assert.equal(full.ok, true); assert.equal(full.microstructure[0].orderBook.lastUpdateId, 7); assert.equal(full.microstructure[0].aggTrades[0].a, 9); assert.equal('payload' in full.microstructure[0], false); const partial = await collectBinanceMarketContext({ fetchImpl: mockFetch({ failDepth: true }), microstructureTopN: 1 }); assert.equal(partial.dataStatus, 'partial'); assert.deepEqual(partial.microstructure[0].missingInputs, ['DEPTH']); assert.equal('confirmed' in partial.microstructure[0], false); });
// A fiat-quoted pair carries a raw 24h quoteVolume inflated by its exchange rate
// (IDR ~16k/USD), so an unfiltered ranking puts it above every USDT major and the
// bounded budgets get spent on symbols the RADAR universe cannot score.
const MIXED_QUOTES = [
  { symbol: 'BTCIDR', quoteAsset: 'IDR', quoteVolume: '9000000000000' },
  { symbol: 'EULTRY', quoteAsset: 'TRY', quoteVolume: '80000000000' },
  { symbol: 'BTCUSDT', quoteAsset: 'USDT', quoteVolume: '2000000000' },
  { symbol: 'ETHUSDC', quoteAsset: 'USDC', quoteVolume: '900000000' },
];
function mixedQuoteFetch() {
  return async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/exchangeInfo')) return json({ symbols: MIXED_QUOTES.map((t) => ({ symbol: t.symbol, status: 'TRADING', isSpotTradingAllowed: true, baseAsset: t.symbol.slice(0, 3), quoteAsset: t.quoteAsset })) });
    if (path.endsWith('/ticker/24hr')) return json(MIXED_QUOTES.map((t) => ({ symbol: t.symbol, lastPrice: '100', priceChangePercent: '1', highPrice: '101', lowPrice: '99', volume: '4', quoteVolume: t.quoteVolume, count: 2 })));
    if (path.endsWith('/klines')) return json([[1, '1', '2', '0', '1', '5', 2, '5', 1]]);
    if (path.endsWith('/depth')) return json({ lastUpdateId: 7, bids: [['99', '1']], asks: [['101', '1']] });
    if (path.endsWith('/aggTrades')) return json([{ a: 9, p: '100', q: '1', m: false, T: 1000, M: true }]);
    if (path.endsWith('/ticker')) return json(MIXED_QUOTES.map((t) => ({ symbol: t.symbol, priceChangePercent: '2' })));
    throw new Error('unexpected endpoint');
  };
}

test('bounded budgets rank by liquidity, not by the quote asset exchange rate', async () => {
  assert.deepEqual(rankByQuoteVolume(MIXED_QUOTES).map((t) => t.symbol), ['BTCUSDT', 'ETHUSDC']);
  const result = await collectBinanceMarketContext({ fetchImpl: mixedQuoteFetch(), microstructureTopN: 2 });
  assert.deepEqual(result.microstructure.map((m) => m.symbol), ['BTCUSDT', 'ETHUSDC']);
  // Every ticker is still stored — only the bounded measurement budget is ranked.
  assert.equal(result.rows.length, 4);
  const multiTf = await collectMultiTimeframe('spot', MIXED_QUOTES, { fetchImpl: mixedQuoteFetch(), topN: 2 });
  assert.deepEqual([...multiTf.symbols.keys()], ['BTCUSDT', 'ETHUSDC']);
  assert.equal(multiTf.requested, 2);
});

test('blocked futures remains explicit partial data and does not discard collected spot rows', async () => { const result = await collectBinanceMarketContext({ fetchImpl: mockFetch({ failFutures: true }), microstructureTopN: 1, includeFutures: true }); assert.equal(result.ok, true); assert.equal(result.dataStatus, 'partial'); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].market, 'spot'); assert.equal(result.diagnostics.futuresStatus, 'unavailable'); assert.equal(result.diagnostics.futuresFailureCode, 'UPSTREAM_REGION_BLOCKED'); });
