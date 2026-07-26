// Public, bounded Binance REST source. This module has no credentials, signed
// endpoints, CoinGecko fallback, or trading thresholds. DEX/non-Binance assets
// are simply absent from this context and must be shown as UNSUPPORTED later.
export const BINANCE_SPOT_ORIGIN = 'https://data-api.binance.vision';
export const BINANCE_FUTURES_ORIGIN = 'https://fapi.binance.com';
export const DEFAULT_MICROSTRUCTURE_TOP_N = 5; // Conservative default; the ceiling below is what the background collector uses.
// Each measured symbol costs 3 public GETs (klines/depth/aggTrades) and ~9 request
// weight. A full USD-stable universe is ~500 symbols = ~4.5k weight per cycle,
// inside Binance's 6000/min budget. What it does NOT fit is the 30s scheduled
// function limit, so the large universe is only reachable from the background
// collector; the scheduled path stays small.
export const MAX_MICROSTRUCTURE_TOP_N = 600;
export const DEFAULT_MICROSTRUCTURE_CONCURRENCY = 2;
export const MAX_MICROSTRUCTURE_CONCURRENCY = 32;
export const MICROSTRUCTURE_CONCURRENCY = DEFAULT_MICROSTRUCTURE_CONCURRENCY;
// Multi-timeframe (1h/4h/12h/7d) comes from Binance rolling-window ticker, which
// is per-symbol (weight 4/symbol, capped at 200 for >50 symbols, max 100 symbols
// per request). Full-universe multi-TF would blow the 6000/min weight budget, so
// it is bounded to the top-N by 24h quote volume; every other symbol stays
// UNKNOWN for these fields (never faked).
export const DEFAULT_MULTI_TF_TOP_N = 300;
export const MAX_MULTI_TF_TOP_N = 500;
const MULTI_TF_BATCH = 100;
const MULTI_TF_WINDOWS = Object.freeze([{ key: 'change1hPct', windowSize: '1h' }, { key: 'change4hPct', windowSize: '4h' }, { key: 'change12hPct', windowSize: '12h' }, { key: 'change7dPct', windowSize: '7d' }]);

const TIMEOUT_MS = 4_500;
const VENUES = {
  spot: { origin: BINANCE_SPOT_ORIGIN, exchangeInfo: '/api/v3/exchangeInfo', ticker: '/api/v3/ticker/24hr', rollingTicker: '/api/v3/ticker', klines: '/api/v3/klines', depth: '/api/v3/depth', trades: '/api/v3/aggTrades' },
  futures: { origin: BINANCE_FUTURES_ORIGIN, exchangeInfo: '/fapi/v1/exchangeInfo', ticker: '/fapi/v1/ticker/24hr', klines: '/fapi/v1/klines', depth: '/fapi/v1/depth', trades: '/fapi/v1/aggTrades' },
};
const ALLOWED_PATHS = new Set(Object.values(VENUES).flatMap((venue) => [venue.exchangeInfo, venue.ticker, venue.rollingTicker, venue.klines, venue.depth, venue.trades]).filter(Boolean));

// Both bounded budgets below (microstructure depth/trades, multi-timeframe change)
// rank by 24h `quoteVolume` — a figure denominated in the QUOTE asset. Comparing
// that raw number across mixed quotes ranks by exchange rate, not by liquidity:
// an IDR pair (~16k IDR/USD) or a TRY pair (~40 TRY/USD) outranks every major
// purely through its denominator. Those pairs are also outside the RADAR universe
// (scripts/radar/trading-radar.mjs QUOTES), so measuring them spends the whole
// budget on symbols RADAR can never score. Rank only the USD-stable quotes.
export const RANKABLE_QUOTE_ASSETS = Object.freeze(['USDT', 'USDC']);
export function rankByQuoteVolume(tickers) {
  const eligible = (Array.isArray(tickers) ? tickers : []).filter((t) => RANKABLE_QUOTE_ASSETS.includes(t?.quoteAsset));
  return eligible.sort((a, b) => (finite(b.quoteVolume) || 0) - (finite(a.quoteVolume) || 0));
}

function boundedTopN(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.trunc(number), MAX_MICROSTRUCTURE_TOP_N) : DEFAULT_MICROSTRUCTURE_TOP_N;
}
function failureCode(error) {
  const message = String(error?.message || error || '');
  if (/ABORT|TIMEOUT/i.test(message)) return 'UPSTREAM_TIMEOUT';
  if (/HTTP 451/.test(message)) return 'UPSTREAM_REGION_BLOCKED';
  if (/HTTP 429|HTTP 418/.test(message)) return 'UPSTREAM_RATE_LIMITED';
  if (/HTTP 4\d\d/.test(message)) return 'UPSTREAM_REJECTED';
  return 'UPSTREAM_ERROR';
}
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }

export function buildBinancePublicUrl(market, resource, params = {}) {
  const venue = VENUES[market];
  if (!venue || !venue[resource]) throw new Error('BINANCE_ENDPOINT_NOT_ALLOWED');
  const url = new URL(venue[resource], venue.origin);
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  return url.toString();
}

export async function fetchBinancePublicJson(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const parsed = new URL(url);
  if (![BINANCE_SPOT_ORIGIN, BINANCE_FUTURES_ORIGIN].includes(parsed.origin) || !ALLOWED_PATHS.has(parsed.pathname) || parsed.username || parsed.password) throw new Error('BINANCE_ENDPOINT_NOT_ALLOWED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`BINANCE HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function instrumentIndex(market, payload) {
  const out = new Map();
  for (const symbol of payload?.symbols || []) {
    if (!symbol || symbol.status !== 'TRADING' || (market === 'spot' && symbol.isSpotTradingAllowed === false)) continue;
    if (typeof symbol.symbol !== 'string' || typeof symbol.baseAsset !== 'string' || typeof symbol.quoteAsset !== 'string') continue;
    out.set(symbol.symbol, { baseAsset: symbol.baseAsset, quoteAsset: symbol.quoteAsset });
  }
  return out;
}
function normalizeTickers(market, payload, instruments) {
  const rows = [];
  for (const ticker of Array.isArray(payload) ? payload : []) {
    const instrument = instruments.get(ticker?.symbol); if (!instrument) continue;
    rows.push({ market, symbol: ticker.symbol, ...instrument, lastPrice: ticker.lastPrice, priceChangePercent: ticker.priceChangePercent, highPrice: ticker.highPrice, lowPrice: ticker.lowPrice, baseVolume: ticker.volume, quoteVolume: ticker.quoteVolume, tradeCount: ticker.count, dataStatus: 'complete' });
  }
  return rows;
}
function depthSummary(depth) {
  const bids = Array.isArray(depth?.bids) ? depth.bids.slice(0, 100) : [];
  const asks = Array.isArray(depth?.asks) ? depth.asks.slice(0, 100) : [];
  const bestBid = finite(bids[0]?.[0]); const bestAsk = finite(asks[0]?.[0]);
  const bidQuote = bids.reduce((sum, row) => sum + (finite(row?.[0]) || 0) * (finite(row?.[1]) || 0), 0);
  const askQuote = asks.reduce((sum, row) => sum + (finite(row?.[0]) || 0) * (finite(row?.[1]) || 0), 0);
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  return { levels: { bids: bids.length, asks: asks.length }, bestBid, bestAsk, spreadBps: mid && mid > 0 ? +(((bestAsk - bestBid) / mid) * 10000).toFixed(2) : null, bidQuote: +bidQuote.toFixed(2), askQuote: +askQuote.toFixed(2) };
}
function tradesSummary(trades) {
  const rows = Array.isArray(trades) ? trades.slice(0, 500) : [];
  let buyQuote = 0; let sellQuote = 0; let oldest = null; let newest = null;
  for (const trade of rows) {
    const quote = (finite(trade?.p) || 0) * (finite(trade?.q) || 0);
    // Binance m=true means buyer was maker, therefore taker sold.
    if (trade?.m === true) sellQuote += quote; else if (trade?.m === false) buyQuote += quote;
    const time = finite(trade?.T); if (time !== null) { oldest = oldest === null ? time : Math.min(oldest, time); newest = newest === null ? time : Math.max(newest, time); }
  }
  return { count: rows.length, takerBuyQuote: +buyQuote.toFixed(2), takerSellQuote: +sellQuote.toFixed(2), windowStart: oldest ? new Date(oldest).toISOString() : null, windowEnd: newest ? new Date(newest).toISOString() : null };
}

async function collectMicrostructurePair(market, ticker, fetchImpl) {
  const get = (resource, params) => fetchBinancePublicJson(buildBinancePublicUrl(market, resource, { symbol: ticker.symbol, ...params }), { fetchImpl });
  const [klines, depth, trades] = await Promise.allSettled([get('klines', { interval: '1m', limit: 60 }), get('depth', { limit: 100 }), get('trades', { limit: 500 })]);
  const missingInputs = [];
  if (klines.status !== 'fulfilled') missingInputs.push('KLINES_1M');
  if (depth.status !== 'fulfilled') missingInputs.push('DEPTH');
  if (trades.status !== 'fulfilled') missingInputs.push('AGG_TRADES');
  const firstFailure = [klines, depth, trades].find((item) => item.status === 'rejected');
  const summary = trades.status === 'fulfilled' ? tradesSummary(trades.value) : { count: 0, takerBuyQuote: 0, takerSellQuote: 0, windowStart: null, windowEnd: null };
  return {
    market, symbol: ticker.symbol, dataStatus: missingInputs.length === 0 ? 'complete' : 'partial',
    failureCode: firstFailure ? failureCode(firstFailure.reason) : null, klines1m: klines.status === 'fulfilled' && Array.isArray(klines.value) ? klines.value.slice(0, 120) : [],
    depthSummary: depth.status === 'fulfilled' ? depthSummary(depth.value) : {}, tradesSummary: summary,
    windowStart: summary.windowStart, windowEnd: summary.windowEnd, missingInputs,
    orderBook: depth.status === 'fulfilled' ? { lastUpdateId: depth.value?.lastUpdateId ?? null, bids: Array.isArray(depth.value?.bids) ? depth.value.bids.slice(0, 100) : [], asks: Array.isArray(depth.value?.asks) ? depth.value.asks.slice(0, 100) : [] } : {}, aggTrades: trades.status === 'fulfilled' && Array.isArray(trades.value) ? trades.value.slice(0, 500) : [],
  };
}
async function mapBounded(items, limit, callback) {
  const result = new Array(items.length); let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; result[index] = await callback(items[index]); }
  });
  await Promise.all(workers); return result;
}
// Binance enforces a per-IP REQUEST WEIGHT budget per minute (6000 on spot).
// Exceeding it returns 418/429 and then bans the IP for minutes to hours, which
// would take the whole collector down — so the collector paces itself instead of
// relying on concurrency, which only bounds parallelism and not the rate.
//
// Weights used here: klines(limit<=100)=2, depth(limit=100)=5, aggTrades=2 → 9
// per measured symbol. The budget below leaves headroom for the ticker and
// multi-timeframe calls that share the same allowance.
export const SYMBOL_REQUEST_WEIGHT = 9;
export const DEFAULT_WEIGHT_BUDGET_PER_MIN = 3600;
const WEIGHT_WINDOW_MS = 60_000;

// Rolling-window pacer: admits work only while the last 60s of spent weight stays
// under budget, otherwise waits for the oldest entry to age out. Each venue gets
// its own instance — spot and futures are separate services with separate limits.
export function createWeightPacer(budgetPerMin = DEFAULT_WEIGHT_BUDGET_PER_MIN, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const budget = Number.isFinite(Number(budgetPerMin)) && Number(budgetPerMin) > 0 ? Number(budgetPerMin) : DEFAULT_WEIGHT_BUDGET_PER_MIN;
  const spent = [];
  let waitedMs = 0;
  const prune = (t) => { while (spent.length && t - spent[0].at >= WEIGHT_WINDOW_MS) spent.shift(); };
  const total = () => spent.reduce((sum, e) => sum + e.weight, 0);
  return {
    async take(weight) {
      const cost = Number.isFinite(Number(weight)) && Number(weight) > 0 ? Number(weight) : 1;
      for (;;) {
        const t = now();
        prune(t);
        if (total() + cost <= budget || !spent.length) { spent.push({ at: t, weight: cost }); return; }
        const waitMs = Math.max(1, WEIGHT_WINDOW_MS - (t - spent[0].at));
        waitedMs += waitMs;
        await sleep(waitMs);
      }
    },
    get diagnostics() { return { budgetPerMin: budget, waitedMs, windowWeight: total() }; },
  };
}

function boundedConcurrency(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), MAX_MICROSTRUCTURE_CONCURRENCY) : DEFAULT_MICROSTRUCTURE_CONCURRENCY;
}

async function collectVenue(market, { fetchImpl, microstructureTopN, concurrency, pacer }) {
  const [info, tickersPayload] = await Promise.all([fetchBinancePublicJson(buildBinancePublicUrl(market, 'exchangeInfo'), { fetchImpl }), fetchBinancePublicJson(buildBinancePublicUrl(market, 'ticker'), { fetchImpl })]);
  const tickers = normalizeTickers(market, tickersPayload, instrumentIndex(market, info));
  if (!tickers.length) throw new Error('BINANCE_EMPTY_TICKER_UNIVERSE');
  const rankable = rankByQuoteVolume(tickers);
  if (!rankable.length) console.warn('[MARKET_CONTEXT] microstructure_universe_empty', { market, tickerCount: tickers.length, quotes: RANKABLE_QUOTE_ASSETS });
  const candidates = rankable.slice(0, boundedTopN(microstructureTopN));
  const microstructures = await mapBounded(candidates, boundedConcurrency(concurrency), async (ticker) => {
    if (pacer) await pacer.take(SYMBOL_REQUEST_WEIGHT);
    return collectMicrostructurePair(market, ticker, fetchImpl);
  });
  return { tickers, microstructures, pacing: pacer ? pacer.diagnostics : null };
}

function chunkList(items, size) { const out = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; }

// One rolling window (e.g. 1h) for a bounded symbol list, batched to respect the
// 100-symbols-per-request limit. A failed batch leaves its symbols UNKNOWN for
// this window — it is never backfilled from another source or invented.
async function fetchRollingWindow(market, symbols, windowSize, fetchImpl) {
  const map = new Map();
  for (const batch of chunkList(symbols, MULTI_TF_BATCH)) {
    let payload;
    try { payload = await fetchBinancePublicJson(buildBinancePublicUrl(market, 'rollingTicker', { symbols: JSON.stringify(batch), windowSize }), { fetchImpl }); }
    catch (error) { console.warn('[MARKET_CONTEXT] multi_timeframe_batch_failed', { market, windowSize, symbolCount: batch.length, reason: failureCode(error) }); continue; }
    for (const row of Array.isArray(payload) ? payload : []) { const pct = finite(row?.priceChangePercent); if (row?.symbol && pct !== null) map.set(row.symbol, pct); }
  }
  return map;
}

// Multi-timeframe (1h/4h/12h/7d) % change for the top-N symbols by 24h quote
// volume. Windows are fetched sequentially to stay well inside the weight budget.
export async function collectMultiTimeframe(market, tickers, { fetchImpl = fetch, topN = DEFAULT_MULTI_TF_TOP_N } = {}) {
  const bounded = Math.min(Math.max(Math.trunc(Number(topN) || DEFAULT_MULTI_TF_TOP_N), 1), MAX_MULTI_TF_TOP_N);
  const symbols = rankByQuoteVolume(tickers).slice(0, bounded).map((t) => t.symbol);
  const byWindow = {};
  for (const window of MULTI_TF_WINDOWS) byWindow[window.key] = await fetchRollingWindow(market, symbols, window.windowSize, fetchImpl);
  const result = new Map();
  for (const symbol of symbols) { const entry = {}; for (const window of MULTI_TF_WINDOWS) { const value = byWindow[window.key].get(symbol); if (value !== undefined) entry[window.key] = value; } if (Object.keys(entry).length) result.set(symbol, entry); }
  return { symbols: result, requested: symbols.length, covered: result.size, windows: MULTI_TF_WINDOWS.map((window) => window.windowSize) };
}

export async function collectBinanceMarketContext(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const topN = boundedTopN(options.microstructureTopN);
  const concurrency = boundedConcurrency(options.microstructureConcurrency);
  // One pacer per venue: spot and futures are separate services with separate
  // per-IP weight allowances, so spending on one must not throttle the other.
  const makePacer = () => (options.weightBudgetPerMin === 0 ? null : createWeightPacer(options.weightBudgetPerMin));
  let spot;
  try { spot = await collectVenue('spot', { fetchImpl, microstructureTopN: topN, concurrency, pacer: makePacer() }); }
  catch (error) { return { ok: false, reason: failureCode(error), dataStatus: 'unavailable' }; }
  let futures = { tickers: [], microstructures: [], status: 'unsupported', failureCode: null };
  if (options.includeFutures === true) {
    try { const collected = await collectVenue('futures', { fetchImpl, microstructureTopN: topN, concurrency, pacer: makePacer() }); futures = { ...collected, status: 'complete', failureCode: null }; }
    catch (error) { futures = { tickers: [], microstructures: [], status: 'unavailable', failureCode: failureCode(error) }; }
  }
  const microstructures = [...spot.microstructures, ...futures.microstructures];
  const allMicrostructureComplete = microstructures.every((row) => row.dataStatus === 'complete');
  // Bounded multi-timeframe enrichment (spot only). Symbols outside the top-N
  // keep no 1h/4h/12h/7d fields → the reader surfaces them as UNKNOWN.
  let multiTf = { symbols: new Map(), requested: 0, covered: 0 };
  if (options.includeMultiTimeframe === true) {
    try { multiTf = await collectMultiTimeframe('spot', spot.tickers, { fetchImpl, topN: options.multiTimeframeTopN }); }
    catch (error) { multiTf = { symbols: new Map(), requested: 0, covered: 0, failureCode: failureCode(error) }; }
    for (const row of spot.tickers) { const entry = multiTf.symbols.get(row.symbol); if (entry) Object.assign(row, entry); }
  }
  return {
    ok: true, observedAt: new Date(), collectedAt: new Date(), dataStatus: futures.status === 'complete' && allMicrostructureComplete ? 'complete' : 'partial',
    rows: [...spot.tickers, ...futures.tickers], microstructure: microstructures,
    diagnostics: { spotTickerCount: spot.tickers.length, futuresTickerCount: futures.tickers.length, microstructureCount: microstructures.length, futuresStatus: futures.status, futuresFailureCode: futures.failureCode, microstructureTopN: topN, multiTimeframeRequested: multiTf.requested, multiTimeframeCovered: multiTf.covered, pacingWaitedMs: (spot.pacing?.waitedMs || 0) + (futures.pacing?.waitedMs || 0), rateLimitedSymbols: microstructures.filter((row) => row.failureCode === 'UPSTREAM_RATE_LIMITED').length },
  };
}
