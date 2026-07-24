// Public, bounded Binance REST source. This module has no credentials, signed
// endpoints, CoinGecko fallback, or trading thresholds. DEX/non-Binance assets
// are simply absent from this context and must be shown as UNSUPPORTED later.
export const BINANCE_SPOT_ORIGIN = 'https://data-api.binance.vision';
export const BINANCE_FUTURES_ORIGIN = 'https://fapi.binance.com';
export const DEFAULT_MICROSTRUCTURE_TOP_N = 5; // TODO calibrate only after shadow soak.
export const MAX_MICROSTRUCTURE_TOP_N = 8;
export const MICROSTRUCTURE_CONCURRENCY = 2;

const TIMEOUT_MS = 4_500;
const VENUES = {
  spot: { origin: BINANCE_SPOT_ORIGIN, exchangeInfo: '/api/v3/exchangeInfo', ticker: '/api/v3/ticker/24hr', klines: '/api/v3/klines', depth: '/api/v3/depth', trades: '/api/v3/aggTrades' },
  futures: { origin: BINANCE_FUTURES_ORIGIN, exchangeInfo: '/fapi/v1/exchangeInfo', ticker: '/fapi/v1/ticker/24hr', klines: '/fapi/v1/klines', depth: '/fapi/v1/depth', trades: '/fapi/v1/aggTrades' },
};
const ALLOWED_PATHS = new Set(Object.values(VENUES).flatMap((venue) => [venue.exchangeInfo, venue.ticker, venue.klines, venue.depth, venue.trades]));

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
async function collectVenue(market, { fetchImpl, microstructureTopN }) {
  const [info, tickersPayload] = await Promise.all([fetchBinancePublicJson(buildBinancePublicUrl(market, 'exchangeInfo'), { fetchImpl }), fetchBinancePublicJson(buildBinancePublicUrl(market, 'ticker'), { fetchImpl })]);
  const tickers = normalizeTickers(market, tickersPayload, instrumentIndex(market, info));
  if (!tickers.length) throw new Error('BINANCE_EMPTY_TICKER_UNIVERSE');
  const candidates = [...tickers].sort((a, b) => (finite(b.quoteVolume) || 0) - (finite(a.quoteVolume) || 0)).slice(0, boundedTopN(microstructureTopN));
  const microstructures = await mapBounded(candidates, MICROSTRUCTURE_CONCURRENCY, (ticker) => collectMicrostructurePair(market, ticker, fetchImpl));
  return { tickers, microstructures };
}

export async function collectBinanceMarketContext(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const topN = boundedTopN(options.microstructureTopN);
  let spot;
  try { spot = await collectVenue('spot', { fetchImpl, microstructureTopN: topN }); }
  catch (error) { return { ok: false, reason: failureCode(error), dataStatus: 'unavailable' }; }
  let futures = { tickers: [], microstructures: [], status: 'unsupported' };
  if (options.includeFutures === true) {
    try { const collected = await collectVenue('futures', { fetchImpl, microstructureTopN: topN }); futures = { ...collected, status: 'complete' }; }
    catch (error) { return { ok: false, reason: failureCode(error), dataStatus: 'unavailable' }; }
  }
  const microstructures = [...spot.microstructures, ...futures.microstructures];
  return {
    ok: true, observedAt: new Date(), collectedAt: new Date(), dataStatus: microstructures.every((row) => row.dataStatus === 'complete') ? 'complete' : 'partial',
    rows: [...spot.tickers, ...futures.tickers], microstructure: microstructures,
    diagnostics: { spotTickerCount: spot.tickers.length, futuresTickerCount: futures.tickers.length, microstructureCount: microstructures.length, futuresStatus: futures.status, microstructureTopN: topN },
  };
}
