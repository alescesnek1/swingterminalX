// Public, bounded Binance REST source. This module has no credentials, signed
// endpoints, CoinGecko fallback, or trading thresholds. DEX/non-Binance assets
// are simply absent from this context and must be shown as UNSUPPORTED later.
export const BINANCE_SPOT_ORIGIN = 'https://data-api.binance.vision';
export const BINANCE_FUTURES_ORIGIN = 'https://fapi.binance.com';
export const DEFAULT_MICROSTRUCTURE_TOP_N = 5; // Conservative default; the ceiling below is what the background collector uses.
// Futures must NOT inherit the spot symbol count. A futures symbol costs 27 request
// weight against a 1500/min allowance; a spot symbol costs 9 against 3600/min — so the
// same N is roughly seven times more expensive there. Falling back to the spot topN
// (which is what used to happen when this env was unset) put 200 symbols x 27 = 5400
// weight on a 1500/min budget: 180s of pure pacing for futures microstructure alone,
// on a collector scheduled every 180s. Cycles then never finished before the next one
// started, nothing published, and the terminal showed STALE.
export const DEFAULT_FUTURES_MICROSTRUCTURE_TOP_N = 20;
// The collector's own schedule (market-context-collect-scheduled.mjs: '*/3 * * * *').
// Used only to report a cycle that cannot finish inside it.
export const COLLECTOR_INTERVAL_MS = 180_000;
// Netlify's ceiling for a SCHEDULED function. The background function gets ~15 minutes;
// the scheduled one is killed at 30s with no error, no log and no partial write — the
// only symptom is that nothing publishes and the terminal freezes on its last good run.
export const SCHEDULED_FUNCTION_CEILING_MS = 30_000;

// Projects how long one cycle will spend being rate-paced, from the configuration
// alone. Pure arithmetic, no requests: it exists so an impossible configuration can be
// refused up front instead of being killed mid-flight.
export function estimateCyclePacingMs({ microstructureTopN = 0, futuresMicrostructureTopN = 0, multiTimeframeSymbols = 0, futuresTimeframeSymbols = 0, includeFutures = false, includeMultiTimeframe = false } = {}) {
  const paced = (weight, budgetPerMin) => Math.max(0, ((weight / budgetPerMin) - 1) * WEIGHT_WINDOW_MS);
  const spotWeight = Number(microstructureTopN || 0) * VENUE_REQUEST_WEIGHTS.spot
    + (includeMultiTimeframe ? Math.ceil(Number(multiTimeframeSymbols || 0) / MULTI_TF_BATCH) * MULTI_TF_WINDOWS.length * MULTI_TF_BATCH_WEIGHT : 0);
  const futuresWeight = includeFutures
    ? Number(futuresMicrostructureTopN || 0) * VENUE_REQUEST_WEIGHTS.futures
      + (includeMultiTimeframe ? Number(futuresTimeframeSymbols || 0) * FUTURES_TF_REQUEST_WEIGHT : 0)
    : 0;
  const spotMs = paced(spotWeight, VENUE_WEIGHT_BUDGETS_PER_MIN.spot);
  const futuresMs = paced(futuresWeight, VENUE_WEIGHT_BUDGETS_PER_MIN.futures);
  // The venues run sequentially in collectBinanceMarketContext, so their waits add.
  return { spotWeight, futuresWeight, spotMs, futuresMs, totalMs: spotMs + futuresMs };
}
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
// The terminal lists ~1000 coins; anything past this ceiling shows UNKNOWN for
// 1h/4h/12h/7d, which reads as a broken row rather than an honest gap. The
// rolling-window ticker is weight-capped at 200 per request, so covering the
// whole list costs ~8000 weight per cycle — real money against the per-minute
// allowance, which is why these requests go through the pacer too.
export const MAX_MULTI_TF_TOP_N = 1200;
export const MULTI_TF_BATCH_WEIGHT = 200;
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

// The microstructure budget decides which coins can ever produce an EXECUTION_SCORE
// at all: order-book support and flow confirmation are 25% + 25% of it, and a coin
// with no measurement cannot reach the 65 gate, so it can never become ENTRY_READY.
//
// Allocating that budget purely by liquidity spent every slot on the largest majors
// — which are precisely the coins that rarely produce the setup RADAR looks for (a
// 2-3x ATR dislocation followed by a long flush). The coins that DO flush sit far
// down the volume list and were never measured, so the entry branch was structurally
// dead for exactly the population the strategy targets.
//
// The budget is therefore split, both parts drawn from the liquid pool so an illiquid
// pair the universe filter would reject anyway never consumes a slot:
//   - a fixed number of top-liquidity slots, so BTC/ETH/major context never drops out
//   - the remainder to the deepest 24h DOWN moves, i.e. the real dislocation candidates
// A pump is not this setup, so only negative moves earn a dislocation slot. A symbol
// with no usable 24h change counts as zero dislocation: it stays eligible through the
// liquidity slots but never displaces a symbol with a measured real drop.
export const DEFAULT_MICROSTRUCTURE_POOL_SIZE = 400;
export const DEFAULT_MICROSTRUCTURE_MAJOR_SLOTS = 20;

function dislocationDepthPct(ticker) {
  const change = finite(ticker?.priceChangePercent);
  return change !== null && change < 0 ? -change : 0;
}

export function rankMicrostructureBudget(tickers, options = {}) {
  const topN = boundedTopN(options.topN);
  const poolSize = clampCount(options.poolSize, DEFAULT_MICROSTRUCTURE_POOL_SIZE, MAX_MICROSTRUCTURE_TOP_N);
  const majorSlots = clampCount(options.majorSlots, DEFAULT_MICROSTRUCTURE_MAJOR_SLOTS, poolSize);
  const pool = rankByQuoteVolume(tickers).slice(0, poolSize);
  const selected = pool.slice(0, majorSlots);
  const taken = new Set(selected.map((t) => t.symbol));
  const dislocated = pool.slice(majorSlots)
    .map((ticker) => ({ ticker, depth: dislocationDepthPct(ticker) }))
    // Deterministic: depth first, then symbol, so an identical universe always
    // yields an identical measured set (and the tests are not order-dependent).
    .sort((a, b) => b.depth - a.depth || String(a.ticker.symbol).localeCompare(String(b.ticker.symbol)));
  for (const { ticker } of dislocated) {
    if (selected.length >= topN) break;
    if (taken.has(ticker.symbol)) continue;
    taken.add(ticker.symbol);
    selected.push(ticker);
  }
  return selected.slice(0, topN);
}

function boundedTopN(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.trunc(number), MAX_MICROSTRUCTURE_TOP_N) : DEFAULT_MICROSTRUCTURE_TOP_N;
}
// Bounded positive count with an explicit fallback — a missing, zero, negative, or
// non-numeric value takes the fallback rather than collapsing the budget to nothing.
function clampCount(value, fallback, max) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : Math.min(fallback, max);
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
    // When THIS symbol's data was actually read. The cycle's single observedAt is
    // stamped after every symbol is done, and with request pacing that can be
    // minutes later — measuring an early symbol's trades against it puts them all
    // outside the window, leaving zero samples and no absorption fields at all.
    fetchedAtMs: Date.now(),
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
// Weight and allowance are PER VENUE and differ a lot. Spot publishes ~6000/min
// per IP; USD-M Futures publishes a much tighter one, and its aggTrades endpoint
// costs several times the spot equivalent. Treating both as "9 weight against
// 6000" is what made the first paced run useless: the pacer reported
// pacingWaitedMs 0 — believing it had ample headroom — while Binance rate-limited
// 111 futures symbols in the same cycle.
//
// These are deliberately CONSERVATIVE: calibrated to stay clear of the observed
// 429s rather than to squeeze the documented maximum, because the penalty for
// overrunning is an IP ban that stops all collection, not a single failed symbol.
export const VENUE_REQUEST_WEIGHTS = Object.freeze({ spot: 9, futures: 27 });
export const VENUE_WEIGHT_BUDGETS_PER_MIN = Object.freeze({ spot: 3600, futures: 1500 });
export const SYMBOL_REQUEST_WEIGHT = VENUE_REQUEST_WEIGHTS.spot;
export const DEFAULT_WEIGHT_BUDGET_PER_MIN = VENUE_WEIGHT_BUDGETS_PER_MIN.spot;
export function venueRequestWeight(market) { return VENUE_REQUEST_WEIGHTS[market] ?? VENUE_REQUEST_WEIGHTS.spot; }
export function venueWeightBudget(market) { return VENUE_WEIGHT_BUDGETS_PER_MIN[market] ?? VENUE_WEIGHT_BUDGETS_PER_MIN.spot; }
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

async function collectVenue(market, { fetchImpl, microstructureTopN, microstructurePoolSize, microstructureMajorSlots, concurrency, pacer }) {
  const [info, tickersPayload] = await Promise.all([fetchBinancePublicJson(buildBinancePublicUrl(market, 'exchangeInfo'), { fetchImpl }), fetchBinancePublicJson(buildBinancePublicUrl(market, 'ticker'), { fetchImpl })]);
  const tickers = normalizeTickers(market, tickersPayload, instrumentIndex(market, info));
  if (!tickers.length) throw new Error('BINANCE_EMPTY_TICKER_UNIVERSE');
  const rankable = rankByQuoteVolume(tickers);
  if (!rankable.length) console.warn('[MARKET_CONTEXT] microstructure_universe_empty', { market, tickerCount: tickers.length, quotes: RANKABLE_QUOTE_ASSETS });
  const candidates = rankMicrostructureBudget(tickers, { topN: microstructureTopN, poolSize: microstructurePoolSize, majorSlots: microstructureMajorSlots });
  // Which coins the budget actually bought is the difference between "RADAR found no
  // setup" and "RADAR could not have found one", so the split is logged every cycle.
  const dislocationSlots = candidates.filter((t) => dislocationDepthPct(t) > 0).length;
  console.info('[MARKET_CONTEXT] microstructure_budget', { market, measured: candidates.length, poolCandidates: rankable.length, withDrawdown: dislocationSlots, deepestDropPct: candidates.length ? +Math.max(...candidates.map(dislocationDepthPct)).toFixed(2) : null });
  const microstructures = await mapBounded(candidates, boundedConcurrency(concurrency), async (ticker) => {
    if (pacer) await pacer.take(venueRequestWeight(market));
    return collectMicrostructurePair(market, ticker, fetchImpl);
  });
  return { tickers, microstructures, pacing: pacer ? pacer.diagnostics : null };
}

function chunkList(items, size) { const out = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; }

// One rolling window (e.g. 1h) for a bounded symbol list, batched to respect the
// 100-symbols-per-request limit. A failed batch leaves its symbols UNKNOWN for
// this window — it is never backfilled from another source or invented.
// Retry budget for a rate-limited batch. A 429 is a "come back later", not a "this
// data does not exist" — dropping the batch on the first one silently left every
// symbol in it without that window, indistinguishable from a genuinely new listing
// Binance has no history for. Measured locally: an unpaced 750-symbol run lost 250
// symbols' 7d values that way, because 7d is fetched last and therefore loses first.
const MULTI_TF_RETRY_ATTEMPTS = 2;
// Binance's weight allowance is a ROLLING 60s window, so a 3s pause cleared almost
// nothing: a retry fired straight back into the same exhausted budget and failed
// again. Backoff is progressive (12s, then 24s) to actually let weight age out.
export const MULTI_TF_RETRY_BACKOFF_MS = 12_000;
// Retries are per BATCH and there are 32 of them in a full universe pass, so an
// unbounded backoff could add minutes to a cycle. The collector is scheduled every
// 180s and a measured full cycle already takes ~123s, so the retry wait is capped
// for the WHOLE collection: overrunning the interval starts a second, overlapping
// run that competes for the same IP allowance and causes the very 429s being
// retried. Once the cap is spent, remaining failures are reported instead of waited
// on — an honest shortfall beats a cycle that never finishes.
export const MULTI_TF_RETRY_WAIT_BUDGET_MS = 30_000;

async function fetchRollingWindow(market, symbols, windowSize, fetchImpl, pacer, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryBudget = { remainingMs: MULTI_TF_RETRY_WAIT_BUDGET_MS }) {
  const map = new Map();
  let failedBatches = 0;
  let unresolved = 0;
  let retryWaitedMs = 0;
  let budgetExhausted = false;
  for (const batch of chunkList(symbols, MULTI_TF_BATCH)) {
    let payload = null;
    let lastReason = null;
    for (let attempt = 0; attempt <= MULTI_TF_RETRY_ATTEMPTS; attempt += 1) {
      // Shares the venue's per-minute allowance with the microstructure reads, so
      // it must draw from the same pacer — otherwise widening this coverage simply
      // moves the rate-limit failure from one endpoint to another. Charged on every
      // attempt, so a retry cannot smuggle weight past the budget.
      if (pacer) await pacer.take(MULTI_TF_BATCH_WEIGHT);
      try { payload = await fetchBinancePublicJson(buildBinancePublicUrl(market, 'rollingTicker', { symbols: JSON.stringify(batch), windowSize }), { fetchImpl }); break; }
      catch (error) {
        lastReason = failureCode(error);
        payload = null;
        // Only a rate limit is worth retrying; a rejected or malformed request will
        // fail identically however long we wait.
        if (lastReason !== 'UPSTREAM_RATE_LIMITED' || attempt === MULTI_TF_RETRY_ATTEMPTS) break;
        // Never wait longer than the collection has left: a partial result reported
        // truthfully is better than a cycle that overruns its own schedule.
        const wait = Math.min(MULTI_TF_RETRY_BACKOFF_MS * (attempt + 1), Math.max(0, retryBudget.remainingMs));
        if (wait <= 0) { budgetExhausted = true; break; }
        retryBudget.remainingMs -= wait;
        retryWaitedMs += wait;
        await sleep(wait);
      }
    }
    if (!payload) {
      failedBatches += 1;
      unresolved += batch.length;
      console.warn('[MARKET_CONTEXT] multi_timeframe_batch_failed', { market, windowSize, symbolCount: batch.length, reason: lastReason, attempts: MULTI_TF_RETRY_ATTEMPTS + 1, retryBudgetExhausted: budgetExhausted });
      continue;
    }
    for (const row of Array.isArray(payload) ? payload : []) { const pct = finite(row?.priceChangePercent); if (row?.symbol && pct !== null) map.set(row.symbol, pct); }
  }
  // A shortfall must be reported, not inferred from a blank cell: a value missing
  // because the fetch failed and a value missing because the pair is days old are
  // different facts, and only the caller can label them.
  return { map, failedBatches, unresolved, requested: symbols.length, covered: map.size, retryWaitedMs, retryBudgetExhausted: budgetExhausted };
}

// Multi-timeframe (1h/4h/12h/7d) % change for the top-N symbols by 24h quote
// volume. Windows are fetched sequentially to stay well inside the weight budget.
export async function collectMultiTimeframe(market, tickers, { fetchImpl = fetch, topN = DEFAULT_MULTI_TF_TOP_N, pacer = null, sleep } = {}) {
  const bounded = Math.min(Math.max(Math.trunc(Number(topN) || DEFAULT_MULTI_TF_TOP_N), 1), MAX_MULTI_TF_TOP_N);
  const symbols = rankByQuoteVolume(tickers).slice(0, bounded).map((t) => t.symbol);
  const byWindow = {};
  const windowCoverage = {};
  let degradedWindows = 0;
  // ONE retry-wait budget for the whole collection, not one per window. Windows are
  // fetched in order, so a per-window budget would let the earlier windows spend four
  // times the intended wait and push the cycle past its own schedule.
  const retryBudget = { remainingMs: MULTI_TF_RETRY_WAIT_BUDGET_MS };
  let retryWaitedMs = 0;
  for (const window of MULTI_TF_WINDOWS) {
    const outcome = await fetchRollingWindow(market, symbols, window.windowSize, fetchImpl, pacer, sleep, retryBudget);
    byWindow[window.key] = outcome.map;
    windowCoverage[window.windowSize] = { covered: outcome.covered, requested: outcome.requested, failedBatches: outcome.failedBatches, unresolved: outcome.unresolved, retryWaitedMs: outcome.retryWaitedMs, retryBudgetExhausted: outcome.retryBudgetExhausted };
    retryWaitedMs += outcome.retryWaitedMs;
    if (outcome.failedBatches > 0) degradedWindows += 1;
  }
  const result = new Map();
  for (const symbol of symbols) { const entry = {}; for (const window of MULTI_TF_WINDOWS) { const value = byWindow[window.key].get(symbol); if (value !== undefined) entry[window.key] = value; } if (Object.keys(entry).length) result.set(symbol, entry); }
  // Windows are fetched in order, so a budget shortfall always costs the LAST window
  // (7d) first. Without this line a 7d column that is two thirds empty looks like a
  // property of the market rather than a failed fetch, which is exactly how the gap
  // went unnoticed.
  if (degradedWindows > 0) console.warn('[MARKET_CONTEXT] multi_timeframe_degraded', { market, requested: symbols.length, degradedWindows, retryWaitedMs, retryBudgetRemainingMs: retryBudget.remainingMs, windowCoverage });
  return { symbols: result, requested: symbols.length, covered: result.size, windows: MULTI_TF_WINDOWS.map((window) => window.windowSize), windowCoverage, degradedWindows, retryWaitedMs };
}

// Futures-only listings had NO 1h/4h/12h/7d at all. Multi-timeframe comes from the
// spot rolling-window ticker, and Binance futures has no equivalent endpoint, so any
// base asset that trades ONLY on futures (measured: 319 of them) showed a dash in
// every timeframe column while 24h was populated — which reads as broken rather than
// as an uncollected venue.
//
// One 1h-kline request per symbol yields all four windows, so this costs one request
// per futures-only symbol rather than one per symbol per window. The values are
// derived from that symbol's OWN futures candles — never borrowed from a spot pair,
// whose percentage change is a different number.
export const FUTURES_TF_INTERVAL = '1h';
export const FUTURES_TF_CANDLES = 169; // 168 closed hours + the forming one → 7d reach
export const FUTURES_TF_REQUEST_WEIGHT = 5;
const FUTURES_TF_WINDOWS = Object.freeze([
  { key: 'change1hPct', hoursAgo: 1 },
  { key: 'change4hPct', hoursAgo: 4 },
  { key: 'change12hPct', hoursAgo: 12 },
  { key: 'change7dPct', hoursAgo: 168 },
]);

export async function collectFuturesTimeframes(symbols, { fetchImpl = fetch, pacer = null, topN = MAX_MULTI_TF_TOP_N, concurrency = DEFAULT_MICROSTRUCTURE_CONCURRENCY } = {}) {
  const bounded = (Array.isArray(symbols) ? symbols : []).slice(0, Math.min(Math.max(Math.trunc(Number(topN) || MAX_MULTI_TF_TOP_N), 1), MAX_MULTI_TF_TOP_N));
  const result = new Map();
  let failed = 0;
  let shortHistory = 0;
  const rows = await mapBounded(bounded, boundedConcurrency(concurrency), async (symbol) => {
    if (pacer) await pacer.take(FUTURES_TF_REQUEST_WEIGHT);
    try {
      const payload = await fetchBinancePublicJson(buildBinancePublicUrl('futures', 'klines', { symbol, interval: FUTURES_TF_INTERVAL, limit: FUTURES_TF_CANDLES }), { fetchImpl });
      return { symbol, closes: (Array.isArray(payload) ? payload : []).map((row) => finite(row?.[4])).filter((value) => value !== null && value > 0) };
    } catch (error) { return { symbol, failureCode: failureCode(error) }; }
  });
  for (const row of rows) {
    if (row.failureCode) { failed += 1; continue; }
    const closes = row.closes;
    const last = closes.length ? closes[closes.length - 1] : null;
    if (last === null) { failed += 1; continue; }
    const entry = {};
    let short = false;
    for (const window of FUTURES_TF_WINDOWS) {
      const index = closes.length - 1 - window.hoursAgo;
      // A young listing genuinely has no 7d reference. That window stays ABSENT so it
      // renders UNKNOWN, rather than being computed against the oldest candle we
      // happen to have and presented as a 7-day move.
      if (index < 0) { short = true; continue; }
      const base = closes[index];
      if (!(base > 0)) { short = true; continue; }
      entry[window.key] = +(((last - base) / base) * 100).toFixed(3);
    }
    if (short) shortHistory += 1;
    if (Object.keys(entry).length) result.set(row.symbol, entry);
  }
  if (failed > 0 || shortHistory > 0) console.warn('[MARKET_CONTEXT] futures_timeframe_partial', { requested: bounded.length, covered: result.size, failed, shortHistory });
  return { symbols: result, requested: bounded.length, covered: result.size, failed, shortHistory };
}

export async function collectBinanceMarketContext(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const topN = boundedTopN(options.microstructureTopN);
  const concurrency = boundedConcurrency(options.microstructureConcurrency);
  // One pacer per venue: spot and futures are separate services with separate
  // per-IP weight allowances, so spending on one must not throttle the other.
  const makePacer = (market) => (options.weightBudgetPerMin === 0 ? null : createWeightPacer(options.weightBudgetPerMin ?? venueWeightBudget(market)));
  // ONE pacer per venue for the whole cycle. The microstructure reads and the
  // multi-timeframe reads draw on the same per-minute allowance, so they must
  // share a budget — two independent pacers each believe they have the full one.
  const spotPacer = makePacer('spot');
  // How the measurement budget is allocated across the liquid pool. Optional: unset
  // values take the module defaults, so existing callers keep working unchanged.
  const budgetShape = { microstructurePoolSize: options.microstructurePoolSize, microstructureMajorSlots: options.microstructureMajorSlots };
  let spot;
  try { spot = await collectVenue('spot', { fetchImpl, microstructureTopN: topN, ...budgetShape, concurrency, pacer: spotPacer }); }
  catch (error) { return { ok: false, reason: failureCode(error), dataStatus: 'unavailable' }; }
  let futures = { tickers: [], microstructures: [], status: 'unsupported', failureCode: null };
  // Held outside the block so the futures-only timeframe pass below shares the SAME
  // futures allowance as the microstructure reads that ran before it.
  let futuresPacer = null;
  if (options.includeFutures === true) {
    // Futures carries its own, much smaller topN: its per-minute allowance is a
    // fraction of spot's, so the same symbol count that spot absorbs comfortably
    // gets the futures venue rate-limited outright. Unset falls back to the small
    // futures default — NEVER to the spot count (see DEFAULT_FUTURES_MICROSTRUCTURE_TOP_N).
    const futuresTopN = Number.isFinite(Number(options.futuresMicrostructureTopN)) && Number(options.futuresMicrostructureTopN) > 0 ? boundedTopN(options.futuresMicrostructureTopN) : DEFAULT_FUTURES_MICROSTRUCTURE_TOP_N;
    futuresPacer = makePacer('futures');
    try { const collected = await collectVenue('futures', { fetchImpl, microstructureTopN: futuresTopN, ...budgetShape, concurrency, pacer: futuresPacer }); futures = { ...collected, status: 'complete', failureCode: null }; }
    catch (error) { futures = { tickers: [], microstructures: [], status: 'unavailable', failureCode: failureCode(error) }; }
  }
  const microstructures = [...spot.microstructures, ...futures.microstructures];
  const allMicrostructureComplete = microstructures.every((row) => row.dataStatus === 'complete');
  // Bounded multi-timeframe enrichment (spot only). Symbols outside the top-N
  // keep no 1h/4h/12h/7d fields → the reader surfaces them as UNKNOWN.
  let multiTf = { symbols: new Map(), requested: 0, covered: 0 };
  let futuresTf = { symbols: new Map(), requested: 0, covered: 0 };
  if (options.includeMultiTimeframe === true) {
    try { multiTf = await collectMultiTimeframe('spot', spot.tickers, { fetchImpl, topN: options.multiTimeframeTopN, pacer: spotPacer }); }
    catch (error) { multiTf = { symbols: new Map(), requested: 0, covered: 0, failureCode: failureCode(error) }; }
    for (const row of spot.tickers) { const entry = multiTf.symbols.get(row.symbol); if (entry) Object.assign(row, entry); }
    // Futures-only listings can never be covered by the spot rolling-window ticker, so
    // they are derived from their own futures candles. Restricted to symbols spot does
    // NOT list: a spot-listed base already gets its timeframes from the spot row, which
    // the reader prefers anyway, so covering it twice would just spend weight.
    if (futures.tickers.length) {
      const spotSymbols = new Set(spot.tickers.map((row) => row.symbol));
      const futuresOnly = futures.tickers.filter((row) => !spotSymbols.has(row.symbol) && RANKABLE_QUOTE_ASSETS.includes(row.quoteAsset));
      if (futuresOnly.length) {
        try {
          futuresTf = await collectFuturesTimeframes(rankByQuoteVolume(futuresOnly).map((row) => row.symbol), { fetchImpl, pacer: futuresPacer, topN: options.multiTimeframeTopN, concurrency });
          for (const row of futures.tickers) { const entry = futuresTf.symbols.get(row.symbol); if (entry) Object.assign(row, entry); }
        } catch (error) { futuresTf = { symbols: new Map(), requested: futuresOnly.length, covered: 0, failureCode: failureCode(error) }; }
      }
    }
  }
  // A cycle that spends longer being paced than its own schedule allows does not fail
  // loudly — it just never publishes in time, the next run starts on top of it, and the
  // terminal shows STALE with nothing saying why. Report the overrun instead.
  const pacingWaitedMs = (spotPacer?.diagnostics?.waitedMs || 0) + (futuresPacer?.diagnostics?.waitedMs || 0);
  if (pacingWaitedMs > COLLECTOR_INTERVAL_MS) {
    console.warn('[MARKET_CONTEXT] cycle_exceeds_schedule', {
      pacingWaitedMs, intervalMs: COLLECTOR_INTERVAL_MS,
      spotWaitedMs: spotPacer?.diagnostics?.waitedMs || 0, futuresWaitedMs: futuresPacer?.diagnostics?.waitedMs || 0,
      microstructureTopN: topN, futuresEnabled: options.includeFutures === true,
      hint: 'reduce MICROSTRUCTURE_TOP_N / FUTURES_MICROSTRUCTURE_TOP_N / MULTI_TF_TOP_N, or disable futures',
    });
  }
  return {
    ok: true, observedAt: new Date(), collectedAt: new Date(), dataStatus: futures.status === 'complete' && allMicrostructureComplete ? 'complete' : 'partial',
    rows: [...spot.tickers, ...futures.tickers], microstructure: microstructures,
    diagnostics: { spotTickerCount: spot.tickers.length, futuresTickerCount: futures.tickers.length, microstructureCount: microstructures.length, futuresStatus: futures.status, futuresFailureCode: futures.failureCode, microstructureTopN: topN, multiTimeframeRequested: multiTf.requested, multiTimeframeCovered: multiTf.covered, multiTimeframeFailureCode: multiTf.failureCode ?? null, multiTimeframeWindowCoverage: multiTf.windowCoverage ?? null, multiTimeframeDegradedWindows: multiTf.degradedWindows ?? 0, futuresTimeframeRequested: futuresTf.requested, futuresTimeframeCovered: futuresTf.covered, futuresTimeframeFailed: futuresTf.failed ?? 0, futuresTimeframeShortHistory: futuresTf.shortHistory ?? 0, futuresTimeframeFailureCode: futuresTf.failureCode ?? null, pacingWaitedMs, rateLimitedSymbols: microstructures.filter((row) => row.failureCode === 'UPSTREAM_RATE_LIMITED').length },
  };
}
