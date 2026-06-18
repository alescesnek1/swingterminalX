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
// How many candidates we may walk through (in rank order) looking for TOP_N
// measurable symbols. Bounded so a bad list can never trigger hundreds of calls.
const SCAN_LIMIT_HARD_CAP = 100;
const DEFAULT_SCAN_LIMIT = 50;
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
    if (!res.ok) {
      const e = new Error('HTTP ' + res.status);
      e.httpStatus = res.status;
      throw e;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Map a fetch/parse failure to a short, safe, fixed reason code. Never includes
// any response body, URL, token, or header — only a coarse classification.
export function classifyFetchError(err) {
  if (!err) return 'network-error';
  const status = err.httpStatus;
  if (status === 400) return 'invalid-symbol';      // Binance -1121 invalid symbol
  if (status === 451) return 'http-451-or-region-block';
  if (status === 403) return 'http-403';
  if (status === 429) return 'http-429';
  if (Number.isFinite(status)) return `http-${status}`;
  if (err.name === 'AbortError') return 'network-error'; // timeout
  if (err.name === 'SyntaxError') return 'parse-error';
  return 'network-error';
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
    // Observability additions (do not affect any market field):
    //   supported/unsupported — how many top-N rows were even measurable;
    //   fieldsPresent — total real fields emitted across all enriched rows;
    //   lastUpdatedAt — when the most recent real measurement landed.
    microstructureSupported: 0,
    microstructureUnsupported: 0,
    microstructureFieldsPresent: 0,
    microstructureLastUpdatedAt: null,
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
      diagnostics.microstructureUnsupported += 1;
      continue;
    }
    diagnostics.microstructureAttempted += 1;
    diagnostics.microstructureSupported += 1;
    const sym = support.depthSymbol;

    // Cache hit (within TTL) short-circuits any fetch for this symbol.
    if (cache) {
      const hit = cache.get(sym);
      if (hit && now() - hit.at <= config.cacheMs) {
        if (hit.fields && Object.keys(hit.fields).length) {
          overlayBySymbol.set(sym, hit.fields);
          diagnostics.microstructureEnriched += 1;
          diagnostics.microstructureFieldsPresent += Object.keys(hit.fields).length;
          diagnostics.microstructureLastUpdatedAt = new Date(now()).toISOString();
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
      diagnostics.microstructureFieldsPresent += Object.keys(fields).length;
      diagnostics.microstructureLastUpdatedAt = new Date(now()).toISOString();
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

export function radarMicrostructureConfigFromEnv(env = {}) {
  const enabled = String(env.WORKER_RADAR_MICROSTRUCTURE_ENABLED) === 'true';
  // TOP_N is the TARGET number of measured symbols to collect (not "scan only
  // the first N"). We walk the ranked candidate list until we have this many.
  let topN = Number(env.WORKER_RADAR_MICROSTRUCTURE_TOP_N);
  if (!Number.isInteger(topN) || topN <= 0) topN = 20;
  topN = Math.min(topN, TOP_N_HARD_CAP);
  // SCAN_LIMIT bounds how deep we may walk looking for those TOP_N measurable
  // symbols. Default 50, hard-capped at 100 so a bad list can't fan out.
  let scanLimit = Number(env.WORKER_RADAR_MICROSTRUCTURE_SCAN_LIMIT);
  if (!Number.isInteger(scanLimit) || scanLimit <= 0) scanLimit = DEFAULT_SCAN_LIMIT;
  scanLimit = Math.min(scanLimit, SCAN_LIMIT_HARD_CAP);
  let cacheMs = Number(env.WORKER_RADAR_MICROSTRUCTURE_CACHE_MS);
  if (!Number.isFinite(cacheMs) || cacheMs < 0) cacheMs = 10000;
  return { enabled, topN, scanLimit, cacheMs };
}

// A public-fapi perp symbol is 2..30 alphanumerics ending in a stablecoin
// quote. Contract addresses (too long, no stable suffix), alpha pairs, and
// slash/colon/spaced forms are all rejected here.
const FAPI_SYMBOL_RE = /^[A-Z0-9]{2,30}(USDT|USDC)$/;

// Normalize ONE raw candidate string into a safe fapi symbol, or null.
//   • uppercase; strip only slash/underscore/hyphen separators
//   • reject anything containing ALPHA, ':' or whitespace (never an fapi symbol)
//   • must match FAPI_SYMBOL_RE after normalization
// Never coerces — an unmatchable input returns null (caller skips).
export function normalizeFapiSymbolCandidate(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toUpperCase();
  if (!s) return null;
  if (s.includes('ALPHA')) return null;            // never use an alpha pair
  if (s.includes(':') || /\s/.test(s)) return null; // contract-address / spaced forms
  s = s.replace(/[/_-]/g, '');                       // strip separators only
  if (!FAPI_SYMBOL_RE.test(s)) return null;
  return s;
}

// Resolve the best public-fapi symbol for a RADAR candidate, in strict priority
// order. Pure / no network — the FINAL truth still comes from a successful
// public fapi depth/premiumIndex call. Returns { fapiSymbol, source, skipReason }.
//
// Priority: futures_pair → futuresPair → pair → symbol → `${base}USDT`
// (last resort only when base exists and quote is USDT or missing).
// alphaPair, chain, and contractAddress are NEVER read.
export function resolveFapiSymbolForCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return { fapiSymbol: null, source: null, skipReason: 'no-candidate' };
  }
  const ordered = [
    ['futures_pair', candidate.futures_pair],
    ['futuresPair', candidate.futuresPair],
    ['pair', candidate.pair],
    ['symbol', candidate.symbol],
  ];
  for (const [source, raw] of ordered) {
    const sym = normalizeFapiSymbolCandidate(raw);
    if (sym) return { fapiSymbol: sym, source, skipReason: null };
  }
  // Last resort: `${base}USDT`, only when base exists and quote is USDT or absent.
  const base = typeof candidate.base === 'string' ? candidate.base.trim().toUpperCase() : '';
  const quote = typeof candidate.quote === 'string' ? candidate.quote.trim().toUpperCase() : '';
  if (base && (quote === 'USDT' || quote === '')) {
    const sym = normalizeFapiSymbolCandidate(`${base}USDT`);
    if (sym) return { fapiSymbol: sym, source: 'base+USDT', skipReason: null };
  }
  return { fapiSymbol: null, source: null, skipReason: 'no-valid-fapi-symbol' };
}

export async function enrichRadarCandidatesMicrostructure(candidates, opts = {}) {
  const config = opts.config || radarMicrostructureConfigFromEnv(opts.env || {});
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 4000;
  const spotBase = String(opts.spotBaseUrl || DEFAULT_SPOT_BASE).replace(/\/+$/, '');
  const futBase = String(opts.futuresBaseUrl || DEFAULT_FUTURES_BASE).replace(/\/+$/, '');
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const cache = opts.cache instanceof Map ? opts.cache : null;

  // Optional structured diagnostics. When an object is supplied we populate
  // counts + a per-candidate trail (rank, symbol info, derived fapiSymbol, skip
  // reason, measured y/n). Never contains tokens/headers/response bodies.
  const diag = opts.diagnostics && typeof opts.diagnostics === 'object' ? opts.diagnostics : null;
  const scanLimit = Number.isInteger(config.scanLimit) && config.scanLimit > 0
    ? Math.min(config.scanLimit, SCAN_LIMIT_HARD_CAP)
    : DEFAULT_SCAN_LIMIT;
  const targetMeasured = Number.isInteger(config.topN) && config.topN > 0 ? config.topN : 20;
  if (diag) {
    diag.candidatesReceived = Array.isArray(candidates) ? candidates.length : 0;
    diag.scanLimit = scanLimit;
    diag.targetMeasured = targetMeasured;
    diag.candidatesScanned = 0;
    diag.attempted = 0;
    diag.measured = 0;
    diag.skippedNoFapiSymbol = 0;
    diag.failedFetch = 0;
    if (!Array.isArray(diag.perCandidate)) diag.perCandidate = [];
  }
  const recordDiag = (rec) => { if (diag) diag.perCandidate.push(rec); };

  if (!config.enabled || !Array.isArray(candidates) || candidates.length === 0) {
    return {};
  }

  // Measure ONE resolved fapi symbol. Public, read-only: futures depth +
  // premiumIndex, with a spot depth fallback only when futures yields no book.
  // Returns { fields, venue, reason } — reason is a safe classification used
  // only for diagnostics when nothing measurable was found.
  async function measureSymbol(fapiSymbol) {
    const fields = {};
    let venue = null;
    let reason = null; // most-informative failure classification so far

    // 1) Futures order-book depth (source of truth).
    try {
      const url = `${futBase}/fapi/v1/depth?symbol=${encodeURIComponent(fapiSymbol)}&limit=${DEPTH_LIMIT}`;
      const book = await getJson(url, { allowed: FUTURES_HOSTS, timeoutMs, fetchImpl });
      const depth = computeDepthWithin1Pct(book);
      if (depth) {
        fields.orderBookDepthWithin1Pct = depth.orderBookDepthWithin1Pct;
        fields.depthUsdWithin1Pct = depth.depthUsdWithin1Pct;
        if (Number.isFinite(depth.spreadPct)) fields.spreadPct = depth.spreadPct;
        venue = 'futures';
      } else {
        reason = 'no-depth';
      }
    } catch (err) {
      reason = classifyFetchError(err);
    }

    // 2) Futures funding rate (premiumIndex), USDT-perp only. Non-critical.
    if (fapiSymbol.endsWith('USDT')) {
      try {
        const url = `${futBase}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(fapiSymbol)}`;
        const prem = await getJson(url, { allowed: FUTURES_HOSTS, timeoutMs, fetchImpl });
        const funding = fundingRateFromPremiumIndex(prem);
        if (funding != null) { fields.fundingRate = funding; if (!venue) venue = 'futures'; }
      } catch (err) { /* funding is optional; depth/spot decides measured */ }
    }

    // 3) Spot depth fallback — only when futures produced no order book.
    if (fields.orderBookDepthWithin1Pct == null) {
      try {
        const url = `${spotBase}/api/v3/depth?symbol=${encodeURIComponent(fapiSymbol)}&limit=${DEPTH_LIMIT}`;
        const book = await getJson(url, { allowed: SPOT_HOSTS, timeoutMs, fetchImpl });
        const depth = computeDepthWithin1Pct(book);
        if (depth) {
          fields.orderBookDepthWithin1Pct = depth.orderBookDepthWithin1Pct;
          fields.depthUsdWithin1Pct = depth.depthUsdWithin1Pct;
          if (Number.isFinite(depth.spreadPct)) fields.spreadPct = depth.spreadPct;
          if (!venue) venue = 'spot';
          reason = null;
        } else if (!reason) {
          reason = 'no-depth';
        }
      } catch (err) {
        if (!reason || reason === 'no-depth') reason = classifyFetchError(err);
      }
    }

    const measured = Object.keys(fields).length > 0;
    return { fields, venue, reason: measured ? null : (reason || 'fapi-no-data') };
  }

  const microMap = {};
  // Walk the ranked candidate list (bounded by scanLimit) until we have
  // targetMeasured symbols. Invalid / no-data candidates are skipped, not fatal.
  const scanList = candidates.slice(0, scanLimit);
  let measuredCount = 0;

  for (let i = 0; i < scanList.length; i++) {
    if (measuredCount >= targetMeasured) break;
    if (diag) diag.candidatesScanned = i + 1;
    const c = scanList[i];

    if (!c || typeof c !== 'object') {
      if (diag) diag.skippedNoFapiSymbol += 1;
      recordDiag({ index: i, symbol: null, base: null, pair: null, futures_pair: null, quote: null, binance_market: null, fapiSymbol: null, source: null, measured: false, skipReason: 'no-candidate' });
      continue;
    }

    const { fapiSymbol, source, skipReason } = resolveFapiSymbolForCandidate(c);
    const baseRec = {
      index: i,
      symbol: c.symbol ?? null,
      base: c.base ?? null,
      pair: c.pair ?? null,
      futures_pair: c.futures_pair ?? null,
      quote: c.quote ?? null,
      binance_market: c.binance_market ?? null,
      fapiSymbol: fapiSymbol || null,
      source: source || null,
    };

    if (!fapiSymbol) {
      if (diag) diag.skippedNoFapiSymbol += 1;
      recordDiag({ ...baseRec, measured: false, skipReason: skipReason || 'no-valid-fapi-symbol' });
      continue;
    }

    // Cache hit (within TTL) short-circuits any fetch for this symbol.
    if (cache) {
      const hit = cache.get(fapiSymbol);
      if (hit && now() - hit.at <= config.cacheMs) {
        const cached = hit.fields && Object.keys(hit.fields).length ? hit.fields : null;
        if (cached) { microMap[fapiSymbol] = cached; measuredCount += 1; if (diag) diag.measured += 1; }
        recordDiag({ ...baseRec, measured: !!cached, skipReason: cached ? null : 'no-data-cached', venue: 'cache' });
        continue;
      }
    }

    if (diag) diag.attempted += 1;
    const { fields, venue, reason } = await measureSymbol(fapiSymbol);
    if (cache) cache.set(fapiSymbol, { at: now(), fields });

    if (Object.keys(fields).length) {
      microMap[fapiSymbol] = fields;
      measuredCount += 1;
      if (diag) diag.measured += 1;
      recordDiag({ ...baseRec, measured: true, skipReason: null, venue: venue || 'futures' });
    } else {
      if (diag) diag.failedFetch += 1;
      recordDiag({ ...baseRec, measured: false, skipReason: reason, venue: null });
    }
  }

  return microMap;
}
