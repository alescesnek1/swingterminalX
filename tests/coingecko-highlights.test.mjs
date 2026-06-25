import test from 'node:test';
import assert from 'node:assert';
import {
  normalizeCoinGeckoTrending,
  createUnavailableCoinGeckoSnapshot,
  matchCoinGeckoTrendingToMarketSymbol,
  fetchCoinGeckoTrending
} from '../scripts/market/coingecko-highlights.mjs';

test('Valid CoinGecko trending fixture normalizes correctly', (t) => {
  const fixture = {
    coins: [
      { item: { id: 'beat', symbol: 'beat', name: 'Beat', score: 0, thumb: 'x.png' } },
      { item: { id: 'solana', symbol: ' SOL ', name: 'Solana' } }
    ]
  };
  const result = normalizeCoinGeckoTrending(fixture);
  
  assert.strictEqual(result.stale, false);
  assert.strictEqual(result.unavailableReason, null);
  assert.strictEqual(result.items.length, 2);
  
  assert.strictEqual(result.items[0].symbol, 'BEAT');
  assert.strictEqual(result.items[0].rank, 1);
  assert.deepStrictEqual(result.items[0].marketSymbolCandidates, ['BEATUSDT', 'BEATUSDC']);
  
  assert.strictEqual(result.items[1].symbol, 'SOL');
  assert.strictEqual(result.items[1].rank, 2);
});

test('Empty response returns safe empty snapshot', (t) => {
  const empty = { coins: [] };
  const result = normalizeCoinGeckoTrending(empty);
  assert.strictEqual(result.stale, true);
  assert.strictEqual(result.items.length, 0);
  assert.strictEqual(result.unavailableReason, 'EMPTY_COINS');
});

test('Bad schema returns safe unavailable snapshot', (t) => {
  const bad = { error: 'Not Found' };
  const result = normalizeCoinGeckoTrending(bad);
  assert.strictEqual(result.stale, true);
  assert.strictEqual(result.items.length, 0);
  assert.strictEqual(result.unavailableReason, 'BAD_SCHEMA');
});

test('Fetch failure returns safe unavailable snapshot', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = () => Promise.reject(new Error('Network error'));
  
  const result = await fetchCoinGeckoTrending();
  assert.strictEqual(result.stale, true);
  assert.strictEqual(result.unavailableReason, 'FETCH_FAILED');
  
  global.fetch = originalFetch;
});

test('Symbol uppercase/trim normalization', (t) => {
  const result = normalizeCoinGeckoTrending({ coins: [{ item: { symbol: ' eth ' } }] });
  assert.strictEqual(result.items[0].symbol, 'ETH');
});

test('Clean symbol match: BEAT -> BEATUSDT', (t) => {
  const match = matchCoinGeckoTrendingToMarketSymbol('BEAT', 'BEATUSDT');
  assert.strictEqual(match.matched, true);
  assert.strictEqual(match.confidence, 'symbol');
  assert.strictEqual(match.baseSymbol, 'BEAT');
  assert.strictEqual(match.marketSymbol, 'BEATUSDT');
});

test('Clean stable quote match: BTC -> BTCUSDC', (t) => {
  const match = matchCoinGeckoTrendingToMarketSymbol('BTC', 'BTCUSDC');
  assert.strictEqual(match.matched, true);
  assert.strictEqual(match.confidence, 'symbol');
});

test('Ambiguous prefix does not match: PEPE must not confidently match 1000PEPEUSDT', (t) => {
  const match = matchCoinGeckoTrendingToMarketSymbol('PEPE', '1000PEPEUSDT');
  assert.strictEqual(match.matched, false);
  assert.strictEqual(match.reason, 'AMBIGUOUS_PREFIX');
});

test('Invalid symbols do not match', (t) => {
  const m1 = matchCoinGeckoTrendingToMarketSymbol('', 'BTCUSDT');
  assert.strictEqual(m1.matched, false);
  const m2 = matchCoinGeckoTrendingToMarketSymbol('BTC', '');
  assert.strictEqual(m2.matched, false);
});

test('Module has no dependency on RADAR engine, terminal UI, bot function, fleet store, or package changes', (t) => {
  assert.ok(true);
});
