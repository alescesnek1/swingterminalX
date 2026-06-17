// microstructure-enrichment.mjs — OFF-by-default public-data microstructure
// sidecar overlay for the worker market snapshot.
//
// PURPOSE
//   Give Trading RADAR a path to eventually evaluate `Absorb.` from REAL,
//   measured market data. This is the FIRST safe slice: it builds the pipe
//   (top-N, bounded, public-only, cached, fail-closed) and emits ONLY the
//   fields it can honestly measure right now. It NEVER fabricates absorption.
//
// SAFETY POSTURE
//   • PUBLIC DATA ONLY — no API key, no signature, no order/margin endpoints.
//   • OFF BY DEFAULT — returns rows unchanged unless explicitly enabled.
//   • TOP-N ONLY — never fans out to hundreds of symbols.
//   • FAIL-CLOSED — a missing/failed measurement OMITS the field (never 0).
//   • ISOLATED — pure module; touches no execution / signed / order path.
//
// FIELDS EMITTED NOW (only when really measured):
//   • orderBookDepthWithin1Pct  (base qty within ±1% of mid, spot depth)
//   • depthUsdWithin1Pct        (USD notional within ±1% of mid, spot depth)
//   • spreadPct                 (best ask vs best bid, from the depth book)
//   • fundingRate               (futures public premiumIndex, USDT-perp only)
//
// INTENTIONALLY DEFERRED (require rolling windows / streams / extra cache and
// must NOT be faked from a single reading): openInterestChangePct, liquidation
// spikes, taker buy/sell ratio, cumulativeDelta, bidDepthRebuildPct,
// absorptionScore, supportRetested, aggressiveSellsFailed, etc.

// ── Public endpoint allowlists (read-only market data) ───────────────────────
const SPOT_HOSTS = new Set([
  'api.binance.com',
  'api1.binance.com',
  'api2.binance.com',
  'api3.binance.com',
  'api4.binance.com',
  'data-api.binance.vision',
]);
const FUTURES_HOSTS = new Set(['fapi.binance.com']);
const DEFAULT_SPOT_BASE = 'https://api.binance.com';
const DEFAULT_FUTURES_BASE = 'https://fapi.binance.com';

// Bounded so a misconfiguration can never fan out to the whole universe.
const TOP_N_HARD_CAP = 50;
const DEPTH_LIMIT = 100; // Binance spot depth weight is small at limit<=100.

// ── Config (explicit, OFF by default) ────────────────────────────────────────
export function microstructureConfigFromEnv(env = {}) {
  const enabled = String(env.WORKER_MARKET_MICROSTRUCTURE_ENABLED) === 'true';
  let topN = Number(env.WORKER_MICROSTRUCTURE_TOP_N);
  if (!Number.isInteger(topN) || topN <= 0) topN = 20;
  topN = Math.min(topN, TOP_N_HARD_CAP);
  let cacheMs = Number(env.WORKER_MICROSTRUCTURE_CACHE_MS);
  if (!Number.isFinite(cacheMs) || cacheMs < 0) cacheMs = 10000;
  return { enabled, topN, cacheMs };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

// Top-N by 24h quote volume (falls back to base volume). Pure, non-mutating.
export function selectTopNMarkets(markets, topN) {
  if (!Array.isArray(markets)) return [];
  const n = Number.isInteger(topN) && topN > 0 ? topN : 0;
  if (n === 0) return [];
  const ranked = markets
    .map((m, i) => ({ m, i, v: Number(m && (m.quoteVolume ?? m.volume24hUsd ?? m.volume)) }))
    .sort((a, b) => {
      const av = Number.isFinite(a.v) ? a.v : -Infinity;
      const bv = Number.isFinite(b.v) ? b.v : -Infinity;
      if (bv !== av) return bv - av;
      return a.i - b.i; // stable for equal/missing volume
    });
  return ranked.slice(0, n).map((x) => x.m);
}

// Classify whether a snapshot row can be measured, and how. Spot depth works
// for any TRADING USDT/USDC spot row. Futures funding is only safe for a
// USDT-quoted symbol, where the spot symbol equals the USDT-margined perp
// symbol 1:1 (no fabricated mapping). Anything else is UNSUPPORTED, not an error.
export function classifyMicrostructureSupport(market) {
  if (!market || typeof market !== 'object' || !market.symbol) {
    return { supported: false, reason: 'missing-symbol', depthSymbol: null, fundingSymbol: null };
  }
  const symbol = String(market.symbol).toUpperCase();
  const status = String(market.status || '').toUpperCase();
  if (status && status !== 'TRADING') {
    return { supported: false, reason: 'not-trading', depthSymbol: null, fundingSymbol: null };
  }
  const quote = String(market.quoteAsset || '').toUpperCase();
  if (quote !== 'USDT' && quote !== 'USDC') {
    return { supported: false, reason: 'unsupported-quote', depthSymbol: null, fundingSymbol: null };
  }
  // Spot depth is always available for a listed spot symbol. Funding only for
  // USDT-quoted symbols (1:1 perp symbol); USDC has no safe perp mapping here.
  return {
    supported: true,
    reason: 'ok',
    depthSymbol: symbol,
    fundingSymbol: quote === 'USDT' ? symbol : null,
  };
}

// Depth within ±1% of mid from a raw spot order book ({ bids, asks } of
// [price, qty] string pairs; bids desc, asks asc). Returns null when the book
// is unusable — the caller then OMITS the fields (never coerces to 0).
export function computeDepthWithin1Pct(book) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return null;
  if (!book.bids.length || !book.asks.length) return null;
  const bestBid = Number(book.bids[0][0]);
  const bestAsk = Number(book.asks[0][0]);
  if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk < bestBid) return null;
  const mid = (bestBid + bestAsk) / 2;
  if (!(mid > 0)) return null;
  const lower = mid * 0.99;
  const upper = mid * 1.01;

  let baseQty = 0;
  let usd = 0;
  for (const lvl of book.bids) {
    const price = Number(lvl[0]);
    const qty = Number(lvl[1]);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0) continue;
    if (price < lower) break; // bids are descending — nothing further is in band
    baseQty += qty;
    usd += price * qty;
  }
  for (const lvl of book.asks) {
    const price = Number(lvl[0]);
    const qty = Number(lvl[1]);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0) continue;
    if (price > upper) break; // asks are ascending — nothing further is in band
    baseQty += qty;
    usd += price * qty;
  }
  const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
  return {
    orderBookDepthWithin1Pct: baseQty,
    depthUsdWithin1Pct: usd,
    spreadPct,
  };
}

// Funding rate from a futures premiumIndex payload. Returns a finite number or
// null (omit). Never invents a value.
export function fundingRateFromPremiumIndex(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload.lastFundingRate;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ── Bounded public fetch ─────────────────────────────────────────────────────
function assertHost(url, allowed) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('non-https endpoint blocked');
  if (!allowed.has(u.hostname)) throw new Error('disallowed host: ' + u.hostname);
  const qs = u.search.toLowerCase();
  if (qs.includes('signature') || qs.includes('timestamp') || qs.includes('apikey')) {
    throw new Error('signed/keyed query parameter blocked');
  }
  return u;
}

async function getJson(url, { allowed, timeoutMs, fetchImpl }) {
  assertHost(url, allowed);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' }, // NO API KEY
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Enrichment ───────────────────────────────────────────────────────────────
// Returns { markets, diagnostics }. When disabled, `markets` is the SAME array
// reference, untouched, and no fetch is performed. When enabled, only the top-N
// rows are (shallow-)cloned and enriched; all other rows pass through unchanged.
// Never throws — per-symbol failures become diagnostics, not exceptions.
export async function enrichMarketsWithMicrostructure(markets, opts = {}) {
  const config = opts.config || microstructureConfigFromEnv(opts.env || {});
  const diagnostics = {
    microstructureEnabled: !!config.enabled,
    microstructureTopN: config.topN,
    microstructureAttempted: 0,
    microstructureEnriched: 0,
    microstructureSkipped: 0,
    microstructureErrors: [],
  };

  if (!config.enabled || !Array.isArray(markets) || markets.length === 0) {
    return { markets: Array.isArray(markets) ? markets : [], diagnostics };
  }

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    diagnostics.microstructureErrors.push('no-fetch-available');
    return { markets, diagnostics };
  }
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const cache = opts.cache instanceof Map ? opts.cache : null;
  const spotBase = String(opts.spotBaseUrl || DEFAULT_SPOT_BASE).replace(/\/+$/, '');
  const futBase = String(opts.futuresBaseUrl || DEFAULT_FUTURES_BASE).replace(/\/+$/, '');
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 4000;

  const targets = selectTopNMarkets(markets, config.topN);
  const targetSymbols = new Set(targets.map((m) => String(m.symbol).toUpperCase()));
  const overlayBySymbol = new Map();

  for (const market of targets) {
    const support = classifyMicrostructureSupport(market);
    if (!support.supported) {
      diagnostics.microstructureSkipped += 1;
      continue;
    }
    diagnostics.microstructureAttempted += 1;
    const sym = support.depthSymbol;

    // Cache hit (within TTL) short-circuits any fetch for this symbol.
    if (cache) {
      const hit = cache.get(sym);
      if (hit && now() - hit.at <= config.cacheMs) {
        if (hit.fields && Object.keys(hit.fields).length) {
          overlayBySymbol.set(sym, hit.fields);
          diagnostics.microstructureEnriched += 1;
        } else {
          diagnostics.microstructureSkipped += 1;
        }
        continue;
      }
    }

    const fields = {};
    // 1) Spot order book depth within ±1% of mid.
    try {
      const url = `${spotBase}/api/v3/depth?symbol=${encodeURIComponent(sym)}&limit=${DEPTH_LIMIT}`;
      const book = await getJson(url, { allowed: SPOT_HOSTS, timeoutMs, fetchImpl });
      const depth = computeDepthWithin1Pct(book);
      if (depth) {
        fields.orderBookDepthWithin1Pct = depth.orderBookDepthWithin1Pct;
        fields.depthUsdWithin1Pct = depth.depthUsdWithin1Pct;
        if (Number.isFinite(depth.spreadPct)) fields.spreadPct = depth.spreadPct;
      }
    } catch (err) {
      diagnostics.microstructureErrors.push(`${sym}:depth:${String(err && err.message || err).slice(0, 80)}`);
    }

    // 2) Futures funding rate (public premiumIndex), USDT-perp symbols only.
    if (support.fundingSymbol) {
      try {
        const url = `${futBase}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(support.fundingSymbol)}`;
        const prem = await getJson(url, { allowed: FUTURES_HOSTS, timeoutMs, fetchImpl });
        const funding = fundingRateFromPremiumIndex(prem);
        if (funding != null) fields.fundingRate = funding;
      } catch (err) {
        diagnostics.microstructureErrors.push(`${support.fundingSymbol}:funding:${String(err && err.message || err).slice(0, 80)}`);
      }
    }

    if (cache) cache.set(sym, { at: now(), fields });

    if (Object.keys(fields).length) {
      overlayBySymbol.set(sym, fields);
      diagnostics.microstructureEnriched += 1;
    } else {
      diagnostics.microstructureSkipped += 1;
    }
  }

  // Bound the error list so diagnostics stay small.
  if (diagnostics.microstructureErrors.length > 10) {
    diagnostics.microstructureErrors = diagnostics.microstructureErrors.slice(0, 10);
  }

  if (overlayBySymbol.size === 0) {
    // Nothing measured — return original rows untouched (still attached diag).
    return { markets, diagnostics };
  }

  // Overlay measured fields onto a shallow clone of ONLY the affected rows.
  const enriched = markets.map((m) => {
    const sym = m && m.symbol ? String(m.symbol).toUpperCase() : null;
    if (!sym || !targetSymbols.has(sym)) return m;
    const overlay = overlayBySymbol.get(sym);
    if (!overlay) return m;
    return { ...m, ...overlay };
  });
  return { markets: enriched, diagnostics };
}
