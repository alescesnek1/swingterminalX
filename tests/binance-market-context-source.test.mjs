import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBinancePublicUrl, fetchBinancePublicJson, collectBinanceMarketContext, collectMultiTimeframe, rankByQuoteVolume, rankMicrostructureBudget, MULTI_TF_RETRY_BACKOFF_MS, MULTI_TF_RETRY_WAIT_BUDGET_MS } from '../netlify/functions/_binance-market-context-source.mjs';
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

// ── multi-timeframe: a 429 is "later", not "no such data" ────────────────────
// Windows are fetched in order (1h, 4h, 12h, 7d), so a budget shortfall always costs
// the LAST window first. Dropping a rate-limited batch on the first failure left
// every symbol in it with no 7d value, indistinguishable from a new listing Binance
// has no history for. Measured live: an unpaced 750-symbol run lost 250 symbols' 7d.
function rollingFetch({ failWindow = null, failTimes = 0, status = 429 } = {}) {
  const attempts = { count: 0, weights: 0 };
  const impl = async (url) => {
    const parsed = new URL(url);
    const windowSize = parsed.searchParams.get('windowSize');
    const symbols = JSON.parse(parsed.searchParams.get('symbols') || '[]');
    if (windowSize === failWindow && attempts.count < failTimes) { attempts.count += 1; return { ok: false, status, json: async () => ({}) }; }
    return json(symbols.map((s) => ({ symbol: s, priceChangePercent: '1.5' })));
  };
  return { impl, attempts };
}
const MT_TICKERS = Array.from({ length: 3 }, (_, i) => ({ symbol: `M${i}USDT`, quoteAsset: 'USDT', quoteVolume: String(1e6 - i) }));

test('a rate-limited multi-timeframe batch is retried and recovers its window', async () => {
  const { impl } = rollingFetch({ failWindow: '7d', failTimes: 1 });
  const mt = await collectMultiTimeframe('spot', MT_TICKERS, { fetchImpl: impl, topN: 3, sleep: async () => {} });
  assert.equal(mt.degradedWindows, 0, 'the retry recovered the window');
  assert.equal(mt.windowCoverage['7d'].covered, 3);
  assert.equal(mt.windowCoverage['7d'].failedBatches, 0);
  for (const [, entry] of mt.symbols) assert.equal(entry.change7dPct, 1.5);
});

test('a shortfall that survives every retry is reported, never left as a blank', async () => {
  const { impl } = rollingFetch({ failWindow: '7d', failTimes: 99 });
  const mt = await collectMultiTimeframe('spot', MT_TICKERS, { fetchImpl: impl, topN: 3, sleep: async () => {} });
  assert.equal(mt.degradedWindows, 1, 'the degraded window is counted');
  assert.deepEqual(mt.windowCoverage['7d'], { covered: 0, requested: 3, failedBatches: 1, unresolved: 3, retryWaitedMs: 30_000, retryBudgetExhausted: false });
  // The other windows are unaffected and still complete.
  assert.equal(mt.windowCoverage['1h'].covered, 3);
  // The symbols keep their other windows rather than being dropped entirely.
  for (const [, entry] of mt.symbols) { assert.equal(entry.change1hPct, 1.5); assert.equal(entry.change7dPct, undefined); }
});

test('a non-rate-limit failure is not retried, because waiting cannot fix it', async () => {
  const { impl, attempts } = rollingFetch({ failWindow: '4h', failTimes: 99, status: 400 });
  const mt = await collectMultiTimeframe('spot', MT_TICKERS, { fetchImpl: impl, topN: 3, sleep: async () => {} });
  assert.equal(attempts.count, 1, 'a rejected request is attempted exactly once');
  assert.equal(mt.windowCoverage['4h'].failedBatches, 1);
});

test('every retry attempt is charged to the pacer, so it cannot outrun the budget', async () => {
  const { impl } = rollingFetch({ failWindow: '7d', failTimes: 1 });
  const charges = [];
  const pacer = { take: async (w) => { charges.push(w); }, get diagnostics() { return {}; } };
  await collectMultiTimeframe('spot', MT_TICKERS, { fetchImpl: impl, topN: 3, pacer, sleep: async () => {} });
  // 4 windows, one batch each, plus one extra charge for the retried attempt.
  assert.equal(charges.length, 5);
  assert.ok(charges.every((w) => w === 200), 'each charge is the documented batch weight');
});

// ── the retry wait is bounded for the WHOLE collection ──────────────────────
// Binance's allowance is a rolling 60s window, so the backoff has to be long enough
// for weight to age out (12s, then 24s). But retries are per BATCH and a full pass has
// 32 of them, so an unbounded backoff could add minutes to a cycle that is scheduled
// every 180s -- and overrunning starts a second, overlapping run that competes for the
// same IP allowance and causes the very 429s being retried.
test('the backoff is long enough to clear a rolling weight window', () => {
  assert.equal(MULTI_TF_RETRY_BACKOFF_MS, 12_000);
  // Progressive: the second attempt waits twice as long as the first.
  assert.ok(MULTI_TF_RETRY_BACKOFF_MS * 2 >= 24_000);
});

test('retry waiting is capped across every window, not per window', async () => {
  // Every batch of every window is rate limited forever, so the retry path is fully
  // exercised: without a shared cap this would wait 4 windows x 12s + 24s each.
  const { impl } = rollingFetch({ failWindow: null, failTimes: 0 });
  const alwaysLimited = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const waits = [];
  const mt = await collectMultiTimeframe('spot', MT_TICKERS, { fetchImpl: alwaysLimited, topN: 3, sleep: async (ms) => { waits.push(ms); } });
  const total = waits.reduce((sum, ms) => sum + ms, 0);
  assert.equal(total, MULTI_TF_RETRY_WAIT_BUDGET_MS, 'total wait equals the budget, never more');
  assert.equal(mt.retryWaitedMs, MULTI_TF_RETRY_WAIT_BUDGET_MS);
  assert.equal(mt.degradedWindows, 4, 'every window is reported degraded');
  // Once the cap is spent, later windows stop waiting and say so.
  assert.equal(mt.windowCoverage['7d'].retryWaitedMs, 0);
  assert.equal(mt.windowCoverage['7d'].retryBudgetExhausted, true);
  assert.ok(impl, 'unused helper kept for symmetry');
});

test('a cycle that never hits a rate limit spends no retry wait at all', async () => {
  const { impl } = rollingFetch();
  const waits = [];
  const mt = await collectMultiTimeframe('spot', MT_TICKERS, { fetchImpl: impl, topN: 3, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, []);
  assert.equal(mt.retryWaitedMs, 0);
  assert.equal(mt.degradedWindows, 0);
  for (const w of ['1h', '4h', '12h', '7d']) assert.equal(mt.windowCoverage[w].retryBudgetExhausted, false);
});

test('the first window may use the budget, and the shortfall stays truthful', async () => {
  // 1h fails twice then succeeds: it should consume 12s + 24s and recover.
  const { impl } = rollingFetch({ failWindow: '1h', failTimes: 2 });
  const waits = [];
  const mt = await collectMultiTimeframe('spot', MT_TICKERS, { fetchImpl: impl, topN: 3, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [12_000, 18_000], 'second wait is clamped by the remaining budget');
  assert.equal(mt.windowCoverage['1h'].covered, 3, 'the window recovered');
  assert.equal(mt.degradedWindows, 0);
});
