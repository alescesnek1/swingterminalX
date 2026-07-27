import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBinancePublicUrl, fetchBinancePublicJson, collectBinanceMarketContext, collectMultiTimeframe, rankByQuoteVolume, rankMicrostructureBudget } from '../netlify/functions/_binance-market-context-source.mjs';
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

// ── microstructure budget allocation ────────────────────────────────────────
// Order-book support + flow confirmation are 50% of EXECUTION_SCORE, so a coin the
// budget never measured can never reach the 65 gate. Ranking the budget purely by
// liquidity spent every slot on the largest majors — the coins least likely to show
// the dislocation+flush setup RADAR looks for — while the coins that actually
// flushed sat far down the volume list and were never measured at all.
const BUDGET_UNIVERSE = [
  { symbol: 'AAAUSDT', quoteAsset: 'USDT', quoteVolume: '1000', priceChangePercent: '1' },
  { symbol: 'BBBUSDT', quoteAsset: 'USDT', quoteVolume: '900', priceChangePercent: '-2' },
  { symbol: 'CCCUSDT', quoteAsset: 'USDT', quoteVolume: '800', priceChangePercent: '-30' },
  { symbol: 'DDDUSDT', quoteAsset: 'USDT', quoteVolume: '700', priceChangePercent: '-10' },
  { symbol: 'EEEUSDT', quoteAsset: 'USDT', quoteVolume: '600', priceChangePercent: '50' },
  { symbol: 'FFFUSDT', quoteAsset: 'USDT', quoteVolume: '10', priceChangePercent: '-90' },
];
const shape = { poolSize: 5, majorSlots: 2 };

test('microstructure budget keeps major slots and spends the rest on the deepest drops', () => {
  const picked = rankMicrostructureBudget(BUDGET_UNIVERSE, { topN: 4, ...shape });
  assert.deepEqual(picked.map((t) => t.symbol), ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT']);
});

test('an illiquid pair outside the pool never consumes a slot, however far it dropped', () => {
  // FFFUSDT fell 90% but sits outside the liquid pool: the universe filter would
  // reject it anyway, so measuring it would waste a slot a real candidate needs.
  const picked = rankMicrostructureBudget(BUDGET_UNIVERSE, { topN: 5, ...shape });
  assert.equal(picked.some((t) => t.symbol === 'FFFUSDT'), false);
});

test('a pump earns no dislocation slot and ranks behind every real drop', () => {
  const picked = rankMicrostructureBudget(BUDGET_UNIVERSE, { topN: 5, ...shape });
  assert.equal(picked.at(-1).symbol, 'EEEUSDT');
});

test('a missing or unusable 24h change counts as zero dislocation, never as a drop', () => {
  const universe = [
    { symbol: 'AAAUSDT', quoteAsset: 'USDT', quoteVolume: '1000', priceChangePercent: '0' },
    { symbol: 'GGGUSDT', quoteAsset: 'USDT', quoteVolume: '900', priceChangePercent: 'not-a-number' },
    { symbol: 'HHHUSDT', quoteAsset: 'USDT', quoteVolume: '800' },
    { symbol: 'IIIUSDT', quoteAsset: 'USDT', quoteVolume: '700', priceChangePercent: '-5' },
  ];
  const picked = rankMicrostructureBudget(universe, { topN: 2, poolSize: 4, majorSlots: 1 });
  assert.deepEqual(picked.map((t) => t.symbol), ['AAAUSDT', 'IIIUSDT']);
});

test('budget allocation is deterministic and never returns a duplicate symbol', () => {
  const tied = [
    { symbol: 'AAAUSDT', quoteAsset: 'USDT', quoteVolume: '1000', priceChangePercent: '1' },
    { symbol: 'ZZZUSDT', quoteAsset: 'USDT', quoteVolume: '900', priceChangePercent: '-7' },
    { symbol: 'MMMUSDT', quoteAsset: 'USDT', quoteVolume: '800', priceChangePercent: '-7' },
  ];
  const first = rankMicrostructureBudget(tied, { topN: 3, poolSize: 3, majorSlots: 1 }).map((t) => t.symbol);
  const again = rankMicrostructureBudget(tied, { topN: 3, poolSize: 3, majorSlots: 1 }).map((t) => t.symbol);
  assert.deepEqual(first, ['AAAUSDT', 'MMMUSDT', 'ZZZUSDT']);
  assert.deepEqual(first, again);
  assert.equal(new Set(first).size, first.length);
});

test('budget allocation still refuses non-USD-stable quotes and respects topN', () => {
  assert.deepEqual(rankMicrostructureBudget(MIXED_QUOTES, { topN: 10 }).map((t) => t.symbol), ['BTCUSDT', 'ETHUSDC']);
  assert.equal(rankMicrostructureBudget(BUDGET_UNIVERSE, { topN: 1, ...shape }).length, 1);
  assert.deepEqual(rankMicrostructureBudget([], { topN: 5 }), []);
});
