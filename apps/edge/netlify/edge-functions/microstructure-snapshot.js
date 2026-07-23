// ─────────────────────────────────────────────────────────────
// Swing Terminal — /api/microstructure-snapshot Edge Function (Deno)
//
// ADVISORY-ONLY, READ-ONLY, same-origin GET proxy that surfaces a LIVE
// microstructure read the strict rolling-absorption producer does not
// provide: order-book summary, funding rate, open interest, and an
// aggregate-trade taker-flow proxy — all from PUBLIC Binance market-data
// GET endpoints, routed through OUR origin (never a direct browser→Binance
// fetch, which adblockers/Brave/corporate proxies block).
//
// What this is NOT, by construction:
//   • It NEVER writes anything (no POST, no bot-write route, no worker token).
//   • It NEVER changes a server gate, strict Absorb, ENTRY_READY, or Telegram
//     eligibility — the response carries advisory_only:true and four explicit
//     affects_*:false flags, and nothing here feeds the scoring pipeline.
//   • It NEVER fabricates Flow/OI/Funding: a value that cannot be fetched or
//     does not apply to the resolved market is honestly UNSUPPORTED/UNKNOWN,
//     never a zero or a bearish default. Liquidation is ALWAYS UNKNOWN because
//     no public liquidation feed is wired.
//
// The visible strict-Absorb "STALE" state is a DIFFERENT thing (trusted
// rolling microstructure not live) and is untouched by this route.
//
// Per the repo error-observability rule: every upstream failure is (a)
// surfaced to the caller with a specific reason so the UI can show it, and
// (b) logged via logWarn so it lands in Netlify function logs — never a
// silent empty/loading box.
//
// GET /api/microstructure-snapshot?pair=BTCUSDT&market=futures
// GET /api/microstructure-snapshot?pair=LITUSDT&market=spot
// ─────────────────────────────────────────────────────────────

import { normalizeBinanceSymbol, resolveOrderbook } from './lib/binance.js';
import { logWarn } from './lib/log.js';

const SPOT_BASE = 'https://api.binance.com';
const FUT_BASE = 'https://fapi.binance.com';
const FETCH_TIMEOUT_MS = 4500;
const AGG_TRADES_LIMIT = 1000;

// Short per-isolate cache so repeated focus/poll hits on the same coin don't
// hammer Binance. Microstructure moves fast, so keep it brief — same posture
// as /api/orderbook's 5s book cache.
const CACHE_TTL_MS = 5_000;
const _cache = new Map(); // key `${market}:${pair}` -> { at, body }

// Test-only: drop the per-isolate cache so behaviour tests stay isolated.
export function __resetMicrostructureCacheForTests() { _cache.clear(); }

// ── low-level public GET helper (injectable fetch for tests) ──
async function fetchPublicJson(url, label, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${label} HTTP ${res.status}: ${String(body).slice(0, 140)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── pure normalizers / builders (exported for direct unit tests) ──

// Map the rich resolveOrderbook() summary down to the advisory read's subset.
export function summarizeBookForRead(resolved) {
  const book = resolved && resolved.book ? resolved.book : {};
  return {
    status: 'OK',
    available: true,
    best_bid: Number.isFinite(book.best_bid) ? book.best_bid : null,
    best_ask: Number.isFinite(book.best_ask) ? book.best_ask : null,
    spread_bps: Number.isFinite(book.spread_bps) ? book.spread_bps : null,
    imbalance: Number.isFinite(book.imbalance) ? book.imbalance : null,
    reason: resolved && resolved.fallback ? 'Resolved on fallback market' : 'ok',
    source: 'edge_public_binance',
  };
}

// Funding is a FUTURES-only concept. On a spot-resolved pair it is honestly
// UNSUPPORTED (never faked). `premium` is the parsed /fapi/v1/premiumIndex body.
export function normalizeFunding(premium) {
  const rate = premium ? parseFloat(premium.lastFundingRate) : NaN;
  if (!premium || !Number.isFinite(rate)) {
    return { status: 'UNKNOWN', available: false, rate: null, next_funding_time: null,
      reason: 'Funding rate unavailable from Binance futures', source: 'edge_public_binance' };
  }
  const nft = Number(premium.nextFundingTime);
  return {
    status: 'OK', available: true, rate,
    next_funding_time: Number.isFinite(nft) ? nft : null,
    reason: 'ok', source: 'edge_public_binance',
  };
}

export function fundingUnsupported() {
  return { status: 'UNSUPPORTED', available: false, rate: null, next_funding_time: null,
    reason: 'Funding rate applies to Binance futures only; resolved market is spot', source: 'edge_public_binance' };
}

// Open interest is FUTURES-only. `oi` is the parsed /fapi/v1/openInterest body.
export function normalizeOpenInterest(oi) {
  const value = oi ? parseFloat(oi.openInterest) : NaN;
  if (!oi || !Number.isFinite(value)) {
    return { status: 'UNKNOWN', available: false, value: null,
      reason: 'Open interest unavailable from Binance futures', source: 'edge_public_binance' };
  }
  return { status: 'OK', available: true, value, reason: 'ok', source: 'edge_public_binance' };
}

export function openInterestUnsupported() {
  return { status: 'UNSUPPORTED', available: false, value: null,
    reason: 'Open interest applies to Binance futures only; resolved market is spot', source: 'edge_public_binance' };
}

// Aggregate-trade taker-flow proxy. Binance aggTrades carry `m` = "was the
// BUYER the maker?": m === true  → the taker was the SELLER (aggressive sell);
//                     m === false → the taker was the BUYER  (aggressive buy).
// Derived from REAL aggTrades only; empty/malformed input is honestly UNKNOWN,
// never a fabricated 50/50 or a bearish default.
export function computeFlowProxy(aggTrades) {
  if (!Array.isArray(aggTrades) || aggTrades.length === 0) {
    return { status: 'UNKNOWN', available: false, taker_buy_qty: null, taker_sell_qty: null,
      taker_buy_ratio: null, trades_used: 0,
      reason: 'No aggregate trades returned by Binance', source: 'edge_public_binance' };
  }
  let buy = 0, sell = 0, used = 0;
  for (const t of aggTrades) {
    if (!t || typeof t !== 'object') continue;
    const q = parseFloat(t.q);
    if (!Number.isFinite(q) || q < 0) continue;
    if (t.m === true) sell += q;          // taker sold
    else if (t.m === false) buy += q;     // taker bought
    else continue;                        // unusable maker flag → skip, never guess
    used++;
  }
  const total = buy + sell;
  if (used === 0 || total <= 0) {
    return { status: 'UNKNOWN', available: false, taker_buy_qty: null, taker_sell_qty: null,
      taker_buy_ratio: null, trades_used: 0,
      reason: 'Aggregate trades present but no usable maker-flag/qty fields', source: 'edge_public_binance' };
  }
  return {
    status: 'OK', available: true,
    taker_buy_qty: +buy.toFixed(8),
    taker_sell_qty: +sell.toFixed(8),
    taker_buy_ratio: +(buy / total).toFixed(4),
    trades_used: used,
    reason: 'ok', source: 'edge_public_binance',
  };
}

// Liquidation is ALWAYS UNKNOWN — Binance exposes no public per-symbol
// liquidation feed, and we never fabricate one.
export function liquidationUnknown() {
  return { status: 'UNKNOWN', available: false,
    reason: 'No public liquidation feed wired (Binance exposes none publicly)' };
}

// ── orchestrator: build the full advisory snapshot ──
// The order book is the GATE (mirrors /api/orderbook): a symbol on neither
// venue throws SYMBOL_NOT_ON_BINANCE (→404), a real upstream fault throws
// UPSTREAM_ERROR (→502). Once a book resolves, funding/OI/flow are best-effort
// enrichment that each degrade honestly; the RESOLVED market decides whether
// funding/OI apply (futures) or are UNSUPPORTED (spot). A single injected
// fetchImpl routes every Binance URL, so tests need only one mock fetch.
export async function buildMicrostructureSnapshot({ pair, requestedMarket, fetchImpl = fetch }) {
  const market = requestedMarket === 'futures' ? 'futures' : 'spot';

  // Gate: resolve the book (may fall back spot<->futures). Throws typed errors.
  const resolved = await resolveOrderbook({ pair, market, fetchImpl });
  const resolvedMarket = resolved.market;
  const isFutures = resolvedMarket === 'futures';

  // Enrichment — never let one failing leg fail the whole read.
  const fundingUrl = `${FUT_BASE}/fapi/v1/premiumIndex?symbol=${pair}`;
  const oiUrl = `${FUT_BASE}/fapi/v1/openInterest?symbol=${pair}`;
  const aggBase = isFutures ? FUT_BASE : SPOT_BASE;
  const aggPath = isFutures ? '/fapi/v1/aggTrades' : '/api/v3/aggTrades';
  const aggUrl = `${aggBase}${aggPath}?symbol=${pair}&limit=${AGG_TRADES_LIMIT}`;

  const warnings = [];

  const fundingP = isFutures
    ? fetchPublicJson(fundingUrl, `funding/${pair}`, fetchImpl).then(normalizeFunding)
        .catch((e) => { warnings.push('funding: ' + String(e?.message || e).slice(0, 120)); return normalizeFunding(null); })
    : Promise.resolve(fundingUnsupported());

  const oiP = isFutures
    ? fetchPublicJson(oiUrl, `oi/${pair}`, fetchImpl).then(normalizeOpenInterest)
        .catch((e) => { warnings.push('open_interest: ' + String(e?.message || e).slice(0, 120)); return normalizeOpenInterest(null); })
    : Promise.resolve(openInterestUnsupported());

  const flowP = fetchPublicJson(aggUrl, `aggTrades/${pair}`, fetchImpl).then(computeFlowProxy)
    .catch((e) => { warnings.push('flow_proxy: ' + String(e?.message || e).slice(0, 120)); return computeFlowProxy(null); });

  const [funding, open_interest, flow_proxy] = await Promise.all([fundingP, oiP, flowP]);

  return {
    ok: true,
    pair,
    requested_market: market,
    market: resolvedMarket,
    market_fallback: resolved.fallback === true,
    timestamp: new Date().toISOString(),
    source: 'edge_public_binance',
    advisory_only: true,
    affects_server_gates: false,
    affects_strict_absorb: false,
    affects_entry_ready: false,
    affects_telegram: false,
    orderbook: summarizeBookForRead(resolved),
    funding,
    open_interest,
    flow_proxy,
    liquidation: liquidationUnknown(),
    warnings,
  };
}

// ── HTTP glue ──
function corsHeaders(allowOrigin) {
  return {
    'Access-Control-Allow-Origin': allowOrigin || 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    'Vary': 'Origin, Authorization',
  };
}

// Advisory read is per-user gated: never let a shared/CDN cache store it.
function jsonHeaders(allowOrigin) {
  return { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(allowOrigin) };
}

// Core handler with INJECTABLE security + fetch. The default export wires in
// the real lib/security.js (Deno-only esm.sh import at module load) and global
// fetch; node:test calls runMicrostructure() directly with mock security +
// fetch so the fail-closed gate is actually executed, not just grepped.
export async function runMicrostructure(request, deps) {
  const { checkOrigin, verifyAuth, pickAllowOrigin, fetchImpl = fetch, now = Date.now() } = deps;
  const allowOrigin = pickAllowOrigin(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: jsonHeaders(allowOrigin) });
  }

  // FAIL-CLOSED gate: origin allowlist + Supabase JWT BEFORE any upstream
  // fetch. An unauthorized caller must never reach Binance through our origin.
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return new Response(JSON.stringify({ error: 'Forbidden origin', detail: originCheck.reason }), { status: 403, headers: jsonHeaders(allowOrigin) });
  }
  const auth = await verifyAuth(request);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: 'Unauthorized', detail: auth.reason }), { status: auth.status || 401, headers: jsonHeaders(allowOrigin) });
  }

  // Params. `pair` is the venue symbol; normalize to sanitize casing/quote.
  const url = new URL(request.url);
  const rawPair = url.searchParams.get('pair') || url.searchParams.get('symbol') || '';
  if (!rawPair || rawPair.length > 20) {
    return new Response(JSON.stringify({ error: 'Missing or invalid "pair"' }), { status: 400, headers: jsonHeaders(allowOrigin) });
  }
  const norm = normalizeBinanceSymbol(rawPair);
  if (!norm) {
    return new Response(JSON.stringify({ error: 'Invalid pair format' }), { status: 400, headers: jsonHeaders(allowOrigin) });
  }
  const market = url.searchParams.get('market') === 'futures' ? 'futures' : 'spot';

  // Serve from the short per-isolate cache if fresh.
  const cacheKey = `${market}:${norm.pair}`;
  const nowMs = now;
  const cached = _cache.get(cacheKey);
  if (cached && nowMs - cached.at < CACHE_TTL_MS) {
    return new Response(cached.body, { status: 200, headers: { 'X-Cache-Layer': 'memory', ...jsonHeaders(allowOrigin) } });
  }

  try {
    const snapshot = await buildMicrostructureSnapshot({ pair: norm.pair, requestedMarket: market, fetchImpl });
    const body = JSON.stringify(snapshot);
    _cache.set(cacheKey, { at: nowMs, body });
    return new Response(body, { status: 200, headers: { 'X-Cache-Layer': 'miss', ...jsonHeaders(allowOrigin) } });
  } catch (e) {
    const kind = e?.kind || 'UPSTREAM_ERROR';
    logWarn?.({
      location: 'microstructure-snapshot/build',
      message: String(e?.message || e),
      payload: { pair: norm.pair, market, kind },
    });
    if (kind === 'SYMBOL_NOT_ON_BINANCE') {
      return new Response(JSON.stringify({
        error: 'Symbol not listed on Binance',
        reason: 'SYMBOL_NOT_ON_BINANCE',
        detail: String(e?.message || e),
        pair: norm.pair,
        requested_market: market,
      }), { status: 404, headers: jsonHeaders(allowOrigin) });
    }
    return new Response(JSON.stringify({
      error: 'Microstructure upstream failed',
      reason: 'UPSTREAM_ERROR',
      detail: String(e?.message || e),
      pair: norm.pair,
      market,
    }), { status: 502, headers: jsonHeaders(allowOrigin) });
  }
}

export default async function handler(request) {
  // security.js pulls a Deno-only esm.sh dependency at module load, so import
  // it dynamically — the handler runs on Deno; node:test exercises
  // runMicrostructure with mock security + fetch instead.
  const { checkOrigin, verifyAuth, pickAllowOrigin } = await import('./lib/security.js');
  return runMicrostructure(request, { checkOrigin, verifyAuth, pickAllowOrigin });
}
