import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBinancePublicUrl, fetchBinancePublicJson, collectBinanceMarketContext } from '../netlify/functions/_binance-market-context-source.mjs';

const json = (body) => ({ ok: true, json: async () => body });
function mockFetch({ failDepth = false } = {}) {
  return async (url) => {
    const path = new URL(url).pathname;
    if (failDepth && path.endsWith('/depth')) return { ok: false, status: 451, json: async () => ({}) };
    if (path.endsWith('/exchangeInfo')) return json({ symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', isSpotTradingAllowed: true, baseAsset: 'BTC', quoteAsset: 'USDT' }] });
    if (path.endsWith('/ticker/24hr')) return json([{ symbol: 'BTCUSDT', lastPrice: '100', priceChangePercent: '1', highPrice: '101', lowPrice: '99', volume: '4', quoteVolume: '400', count: 2 }]);
    if (path.endsWith('/klines')) return json([[1, '1', '2', '0', '1', '5']]);
    if (path.endsWith('/depth')) return json({ bids: [['99', '1']], asks: [['101', '1']] });
    if (path.endsWith('/aggTrades')) return json([{ p: '100', q: '1', m: false, T: 1000 }]);
    throw new Error('unexpected endpoint');
  };
}

test('Binance source rejects a non-allowlisted host and path', async () => {
  await assert.rejects(() => fetchBinancePublicJson('https://evil.example/api/v3/ticker/24hr'), /NOT_ALLOWED/);
  await assert.rejects(() => fetchBinancePublicJson('https://api.binance.com/api/v3/account'), /NOT_ALLOWED/);
  assert.match(buildBinancePublicUrl('spot', 'ticker'), /^https:\/\/api\.binance\.com\/api\/v3\/ticker\/24hr$/);
});

test('missing depth becomes PARTIAL evidence, never confirmed absorb data', async () => {
  const result = await collectBinanceMarketContext({ fetchImpl: mockFetch({ failDepth: true }), microstructureTopN: 1 });
  assert.equal(result.ok, true); assert.equal(result.dataStatus, 'partial');
  assert.equal(result.microstructure[0].dataStatus, 'partial');
  assert.equal(result.microstructure[0].failureCode, 'UPSTREAM_REGION_BLOCKED');
  assert.deepEqual(result.microstructure[0].missingInputs, ['DEPTH']);
  assert.equal('confirmed' in result.microstructure[0], false);
});
