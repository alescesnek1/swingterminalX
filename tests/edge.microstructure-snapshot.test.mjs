// Tests for the /api/microstructure-snapshot Edge function — an ADVISORY-ONLY,
// READ-ONLY live microstructure read (order-book summary + funding + OI +
// aggregate-trade taker-flow proxy) built from PUBLIC Binance GETs.
//
// The default handler can't run under node (Deno-only esm.sh import in
// lib/security.js), so we exercise the injectable core runMicrostructure()
// with mock security + a routed fetch spy, plus the pure builders directly.
// This proves, not greps: the auth/origin gate fails closed BEFORE any
// upstream fetch; the funding/OI legs are futures-only and honestly
// UNSUPPORTED on spot; the flow proxy is computed from real aggTrades with the
// correct maker-flag semantics; malformed data is UNKNOWN not fabricated;
// liquidation is always UNKNOWN; and the advisory_only / affects_* flags are
// present. No write, POST, worker token, Telegram, or private endpoint exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  runMicrostructure,
  buildMicrostructureSnapshot,
  computeFlowProxy,
  normalizeFunding,
  normalizeOpenInterest,
  liquidationUnknown,
  summarizeBookForRead,
  __resetMicrostructureCacheForTests,
} from '../apps/edge/netlify/edge-functions/microstructure-snapshot.js';

const ALLOW = 'https://swing-terminal-v6.netlify.app';
const req = (search = '?pair=BTCUSDT&market=futures', method = 'GET', headers = {}) =>
  new Request(`${ALLOW}/api/microstructure-snapshot${search}`, { method, headers });

const okOrigin = () => ({ ok: true, origin: ALLOW });
const badOrigin = () => ({ ok: false, reason: 'Origin not on allowlist' });
const okAuth = async () => ({ ok: true, status: 200, user: { id: 'u1' } });
const noAuth = async () => ({ ok: false, status: 401, reason: 'Missing Bearer token' });
const badAuth = async () => ({ ok: false, status: 403, reason: 'Role anon not allowed' });
const pick = () => ALLOW;

const VALID_DEPTH = { bids: [['100.0', '2.0'], ['99.5', '1.0']], asks: [['100.5', '2.0'], ['101.0', '1.0']] };
const INVALID_SYMBOL_BODY = '{"code":-1121,"msg":"Invalid symbol."}';
const PREMIUM = { markPrice: '100.2', indexPrice: '100.1', lastFundingRate: '0.0001', nextFundingTime: 1893456000000 };
const OI = { openInterest: '12345.678', symbol: 'BTCUSDT', time: 1893456000000 };
const AGG = [
  { q: '2', m: false }, // taker bought 2
  { q: '1', m: true },  // taker sold 1
  { q: '3', m: false }, // taker bought 3
];

// Route a single fetch across every Binance URL the route can hit. Each leg is
// { status, json } (2xx body) or { status, text } (non-2xx → thrown by the
// fetch helpers). Records calls so tests can assert "no upstream fetch".
function routeFetch(spec) {
  const calls = [];
  const impl = async (url) => {
    const u = String(url);
    calls.push(u);
    let r;
    if (u.includes('/fapi/v1/premiumIndex')) r = spec.premium;
    else if (u.includes('/fapi/v1/openInterest')) r = spec.oi;
    else if (u.includes('/fapi/v1/aggTrades')) r = spec.aggFut;
    else if (u.includes('/api/v3/aggTrades')) r = spec.aggSpot;
    else if (u.includes('/fapi/v1/depth')) r = spec.depthFut;
    else if (u.includes('/api/v3/depth')) r = spec.depthSpot;
    if (!r) throw new Error('unexpected fetch: ' + u);
    const ok = r.status >= 200 && r.status < 300;
    return { ok, status: r.status, json: async () => r.json, text: async () => (r.text != null ? r.text : JSON.stringify(r.json ?? {})) };
  };
  return { impl, calls };
}

test.beforeEach(() => __resetMicrostructureCacheForTests());

// ── 1. Auth failure → 401 and NO upstream fetch ──────────────
test('missing Authorization → 401 and Binance is NEVER fetched', async () => {
  const spy = routeFetch({});
  const res = await runMicrostructure(req(), { checkOrigin: okOrigin, verifyAuth: noAuth, pickAllowOrigin: pick, fetchImpl: spy.impl });
  assert.equal(res.status, 401);
  assert.equal(spy.calls.length, 0, 'auth failure must not reach any upstream fetch');
  const body = await res.json();
  assert.equal(body.error, 'Unauthorized');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('invalid Authorization → 403 and no fetch', async () => {
  const spy = routeFetch({});
  const res = await runMicrostructure(req(), { checkOrigin: okOrigin, verifyAuth: badAuth, pickAllowOrigin: pick, fetchImpl: spy.impl });
  assert.equal(res.status, 403);
  assert.equal(spy.calls.length, 0);
});

// ── 2. Origin failure → 403 before auth, no fetch ────────────
test('forbidden origin → 403 before auth is even checked, no fetch', async () => {
  const spy = routeFetch({});
  let authChecked = false;
  const verifyAuth = async () => { authChecked = true; return { ok: true }; };
  const res = await runMicrostructure(req(), { checkOrigin: badOrigin, verifyAuth, pickAllowOrigin: pick, fetchImpl: spy.impl });
  assert.equal(res.status, 403);
  assert.equal(authChecked, false, 'origin must be gated before auth');
  assert.equal(spy.calls.length, 0);
});

// ── 3. Unsupported symbol → honest 404 not-listed ────────────
test('symbol on neither venue → honest 404 SYMBOL_NOT_ON_BINANCE', async () => {
  const spy = routeFetch({
    depthSpot: { status: 400, text: INVALID_SYMBOL_BODY },
    depthFut: { status: 400, text: INVALID_SYMBOL_BODY },
  });
  const res = await runMicrostructure(req('?pair=ANSEMUSDT&market=spot'), { checkOrigin: okOrigin, verifyAuth: okAuth, pickAllowOrigin: pick, fetchImpl: spy.impl });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.reason, 'SYMBOL_NOT_ON_BINANCE');
});

test('real upstream failure on the book → honest 502, not 404', async () => {
  const spy = routeFetch({ depthSpot: { status: 451, text: 'Unavailable For Legal Reasons' } });
  const res = await runMicrostructure(req('?pair=BTCUSDT&market=spot'), { checkOrigin: okOrigin, verifyAuth: okAuth, pickAllowOrigin: pick, fetchImpl: spy.impl });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.reason, 'UPSTREAM_ERROR');
});

// ── 4. Futures success → normalized funding + OI ─────────────
test('futures success returns normalized funding rate and open interest', async () => {
  const spy = routeFetch({ depthFut: { status: 200, json: VALID_DEPTH }, premium: { status: 200, json: PREMIUM }, oi: { status: 200, json: OI }, aggFut: { status: 200, json: AGG } });
  const snap = await buildMicrostructureSnapshot({ pair: 'BTCUSDT', requestedMarket: 'futures', fetchImpl: spy.impl });
  assert.equal(snap.market, 'futures');
  assert.equal(snap.funding.status, 'OK');
  assert.equal(snap.funding.rate, 0.0001);
  assert.equal(snap.funding.next_funding_time, 1893456000000);
  assert.equal(snap.open_interest.status, 'OK');
  assert.equal(snap.open_interest.value, 12345.678);
  assert.equal(snap.orderbook.status, 'OK');
  assert.equal(snap.orderbook.best_bid, 100);
});

// ── 5. Spot success → funding/OI UNSUPPORTED (never faked, never fetched) ──
test('spot success marks funding and OI UNSUPPORTED and never hits the futures endpoints', async () => {
  const spy = routeFetch({ depthSpot: { status: 200, json: VALID_DEPTH }, aggSpot: { status: 200, json: AGG } });
  const snap = await buildMicrostructureSnapshot({ pair: 'BTCUSDT', requestedMarket: 'spot', fetchImpl: spy.impl });
  assert.equal(snap.market, 'spot');
  assert.equal(snap.funding.status, 'UNSUPPORTED');
  assert.equal(snap.funding.available, false);
  assert.equal(snap.funding.rate, null);
  assert.equal(snap.open_interest.status, 'UNSUPPORTED');
  assert.equal(snap.open_interest.value, null);
  assert.equal(spy.calls.some((u) => u.includes('premiumIndex') || u.includes('openInterest')), false, 'spot must not call futures funding/OI');
});

// ── 6. Flow proxy computes taker buy/sell qty + ratio from aggTrades ──
test('flow proxy: m===false is taker BUY, m===true is taker SELL; ratio is buy/(buy+sell)', () => {
  const fp = computeFlowProxy(AGG);
  assert.equal(fp.status, 'OK');
  assert.equal(fp.taker_buy_qty, 5);   // 2 + 3
  assert.equal(fp.taker_sell_qty, 1);  // 1
  assert.equal(fp.taker_buy_ratio, 0.8333); // 5 / 6
  assert.equal(fp.trades_used, 3);
});

// ── 7. Malformed / empty aggTrades → UNKNOWN (never fabricated) ──
test('flow proxy: empty/null/malformed aggTrades → UNKNOWN, no invented ratio', () => {
  for (const bad of [[], null, undefined, [{ noQty: 1 }], [{ q: 'x', m: false }], [{ q: '1' }]]) {
    const fp = computeFlowProxy(bad);
    assert.equal(fp.status, 'UNKNOWN');
    assert.equal(fp.available, false);
    assert.equal(fp.taker_buy_ratio, null);
  }
});

test('a failing aggTrades fetch degrades flow to UNKNOWN without failing the whole read', async () => {
  const spy = routeFetch({ depthFut: { status: 200, json: VALID_DEPTH }, premium: { status: 200, json: PREMIUM }, oi: { status: 200, json: OI }, aggFut: { status: 500, text: 'boom' } });
  const snap = await buildMicrostructureSnapshot({ pair: 'BTCUSDT', requestedMarket: 'futures', fetchImpl: spy.impl });
  assert.equal(snap.ok, true);
  assert.equal(snap.flow_proxy.status, 'UNKNOWN');
  assert.ok(snap.warnings.some((w) => w.startsWith('flow_proxy:')));
});

// ── 8. Liquidation is always UNKNOWN ─────────────────────────
test('liquidation is always UNKNOWN with an honest reason', () => {
  assert.equal(liquidationUnknown().status, 'UNKNOWN');
  assert.equal(liquidationUnknown().available, false);
});

// ── 9. Advisory-only flags present on every successful read ──
test('advisory_only + affects_* flags are present and all non-affecting', async () => {
  const spy = routeFetch({ depthFut: { status: 200, json: VALID_DEPTH }, premium: { status: 200, json: PREMIUM }, oi: { status: 200, json: OI }, aggFut: { status: 200, json: AGG } });
  const res = await runMicrostructure(req('?pair=BTCUSDT&market=futures'), { checkOrigin: okOrigin, verifyAuth: okAuth, pickAllowOrigin: pick, fetchImpl: spy.impl });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.advisory_only, true);
  assert.equal(body.affects_server_gates, false);
  assert.equal(body.affects_strict_absorb, false);
  assert.equal(body.affects_entry_ready, false);
  assert.equal(body.affects_telegram, false);
  assert.equal(body.liquidation.status, 'UNKNOWN');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('spot→futures book fallback is surfaced honestly (market_fallback:true)', async () => {
  const spy = routeFetch({ depthSpot: { status: 400, text: INVALID_SYMBOL_BODY }, depthFut: { status: 200, json: VALID_DEPTH }, premium: { status: 200, json: PREMIUM }, oi: { status: 200, json: OI }, aggFut: { status: 200, json: AGG } });
  const snap = await buildMicrostructureSnapshot({ pair: 'LITUSDT', requestedMarket: 'spot', fetchImpl: spy.impl });
  assert.equal(snap.requested_market, 'spot');
  assert.equal(snap.market, 'futures');
  assert.equal(snap.market_fallback, true);
  assert.equal(snap.funding.status, 'OK'); // funding applies once resolved to futures
});

test('normalizers fail closed on missing input (UNKNOWN, never a bearish 0)', () => {
  assert.equal(normalizeFunding(null).status, 'UNKNOWN');
  assert.equal(normalizeFunding({ lastFundingRate: 'nope' }).status, 'UNKNOWN');
  assert.equal(normalizeOpenInterest(null).status, 'UNKNOWN');
  assert.equal(normalizeOpenInterest({ openInterest: '' }).status, 'UNKNOWN');
  assert.equal(summarizeBookForRead({ book: VALID_DEPTH.bids ? { best_bid: 1, best_ask: 2, spread_bps: 3, imbalance: 0.1 } : {} }).status, 'OK');
});

// ── 10. No private endpoints / write / worker token / Telegram send ──
test('source contains no write, POST, worker token, private endpoint, or API-key/signature', () => {
  const src = fs.readFileSync(new URL('../apps/edge/netlify/edge-functions/microstructure-snapshot.js', import.meta.url), 'utf8');
  // Telegram host built at runtime so THIS test file never contains the literal
  // (a repo-wide guard flags that host string outside the authorized senders).
  const telegramHost = ['api', 'telegram', 'org'].join('.');
  for (const forbidden of [
    'BOT_WORKER_TOKEN', ['/', 'api/bot'].join(''), 'X-MBX-APIKEY', 'apikey', 'signature=',
    "method: 'POST'", 'method:"POST"', "method: \"POST\"",
    '/fapi/v1/order', '/api/v3/order', '/sapi/', '/fapi/v1/allOpenOrders',
    'sendMessage', telegramHost,
  ]) {
    assert.equal(src.includes(forbidden), false, `edge source must not contain ${forbidden}`);
  }
  // Only PUBLIC Binance market-data hosts.
  assert.ok(src.includes('https://api.binance.com'));
  assert.ok(src.includes('https://fapi.binance.com'));
});
