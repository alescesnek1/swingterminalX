// Microstructure enrichment — OFF-by-default public-data sidecar overlay.
//
// Proves the FIRST safe slice is bounded, public-only, and fail-closed:
//   • disabled (default) → rows untouched, ZERO fetches;
//   • enabled → only top-N symbols fetched, real measured fields appended;
//   • order-book depth/spread math is correct on a fixture book;
//   • endpoint failure → original row preserved, diagnostics record the error,
//     nothing thrown, no field invented;
//   • unsupported symbols are skipped (not errored, no fake values);
//   • funding is attempted ONLY for USDT-perp symbols (no fabricated mapping).
// No execution / signed / order / Telegram / threshold logic is touched.
// Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  microstructureConfigFromEnv,
  selectTopNMarkets,
  classifyMicrostructureSupport,
  computeDepthWithin1Pct,
  fundingRateFromPremiumIndex,
  enrichMarketsWithMicrostructure,
} from '../scripts/auto/microstructure-enrichment.mjs';

const DEPTH_BOOK = {
  // bids descending, asks ascending. mid = 100.01, band = [99.0099, 101.0101].
  bids: [['100', '5'], ['99.5', '10'], ['98', '3']],
  asks: [['100.02', '4'], ['100.5', '6'], ['101.5', '2']],
};

// Fake routed fetch: depth → DEPTH_BOOK, premiumIndex → funding. Counts calls.
function makeFakeFetch({ depthBook = DEPTH_BOOK, funding = '-0.0001', failDepth = false, failFunding = false } = {}) {
  const calls = { depth: [], funding: [], all: [] };
  const fetchImpl = async (url) => {
    calls.all.push(url);
    if (url.includes('/api/v3/depth')) {
      calls.depth.push(url);
      if (failDepth) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => depthBook };
    }
    if (url.includes('/fapi/v1/premiumIndex')) {
      calls.funding.push(url);
      if (failFunding) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ symbol: 'X', lastFundingRate: funding }) };
    }
    throw new Error('unexpected url: ' + url);
  };
  return { fetchImpl, calls };
}

function mkt(symbol, quoteVolume, extra = {}) {
  const quoteAsset = symbol.endsWith('USDC') ? 'USDC' : 'USDT';
  const baseAsset = symbol.replace(/(USDT|USDC)$/, '');
  return { symbol, baseAsset, quoteAsset, status: 'TRADING', quoteVolume, ...extra };
}

// ── config ───────────────────────────────────────────────────────────────────
test('config is OFF by default and bounds top-N / cache', () => {
  const def = microstructureConfigFromEnv({});
  assert.equal(def.enabled, false);
  assert.equal(def.topN, 20);
  assert.equal(def.cacheMs, 10000);

  assert.equal(microstructureConfigFromEnv({ WORKER_MARKET_MICROSTRUCTURE_ENABLED: 'true' }).enabled, true);
  assert.equal(microstructureConfigFromEnv({ WORKER_MARKET_MICROSTRUCTURE_ENABLED: '1' }).enabled, false); // strict 'true'
  assert.equal(microstructureConfigFromEnv({ WORKER_MICROSTRUCTURE_TOP_N: '5' }).topN, 5);
  assert.equal(microstructureConfigFromEnv({ WORKER_MICROSTRUCTURE_TOP_N: '999' }).topN, 50); // hard cap
  assert.equal(microstructureConfigFromEnv({ WORKER_MICROSTRUCTURE_TOP_N: '0' }).topN, 20); // invalid -> default
});

// ── pure: order-book depth + spread ──────────────────────────────────────────
test('computeDepthWithin1Pct sums only the ±1% band and computes spreadPct', () => {
  const d = computeDepthWithin1Pct(DEPTH_BOOK);
  assert.ok(d);
  assert.equal(d.orderBookDepthWithin1Pct, 25); // 5 + 10 + 4 + 6
  assert.ok(Math.abs(d.depthUsdWithin1Pct - 2498.08) < 1e-6); // 500 + 995 + 400.08 + 603
  assert.ok(Math.abs(d.spreadPct - 0.02) < 1e-9);

  // Unusable books -> null (caller omits fields; never 0).
  assert.equal(computeDepthWithin1Pct(null), null);
  assert.equal(computeDepthWithin1Pct({ bids: [], asks: [] }), null);
  assert.equal(computeDepthWithin1Pct({ bids: [['0', '1']], asks: [['1', '1']] }), null);
});

test('fundingRateFromPremiumIndex returns finite or null, never invents', () => {
  assert.equal(fundingRateFromPremiumIndex({ lastFundingRate: '-0.0001' }), -0.0001);
  assert.equal(fundingRateFromPremiumIndex({ lastFundingRate: 0 }), 0); // measured 0 preserved
  assert.equal(fundingRateFromPremiumIndex({ lastFundingRate: '' }), null);
  assert.equal(fundingRateFromPremiumIndex({ lastFundingRate: 'abc' }), null);
  assert.equal(fundingRateFromPremiumIndex({}), null);
  assert.equal(fundingRateFromPremiumIndex(null), null);
});

// ── pure: support classification ─────────────────────────────────────────────
test('classifyMicrostructureSupport: USDT gets depth+funding, USDC depth-only, others unsupported', () => {
  const usdt = classifyMicrostructureSupport(mkt('BTCUSDT', 1));
  assert.equal(usdt.supported, true);
  assert.equal(usdt.depthSymbol, 'BTCUSDT');
  assert.equal(usdt.fundingSymbol, 'BTCUSDT');

  const usdc = classifyMicrostructureSupport(mkt('BTCUSDC', 1));
  assert.equal(usdc.supported, true);
  assert.equal(usdc.depthSymbol, 'BTCUSDC');
  assert.equal(usdc.fundingSymbol, null); // no fabricated perp mapping

  assert.equal(classifyMicrostructureSupport({ symbol: 'FOOBTC', quoteAsset: 'BTC', status: 'TRADING' }).supported, false);
  assert.equal(classifyMicrostructureSupport({ symbol: 'X', quoteAsset: 'USDT', status: 'BREAK' }).supported, false);
  assert.equal(classifyMicrostructureSupport({ quoteAsset: 'USDT' }).supported, false);
});

test('selectTopNMarkets ranks by quote volume, stable, non-mutating', () => {
  const ms = [mkt('AUSDT', 10), mkt('BUSDT', 50), mkt('CUSDT', 30)];
  const top = selectTopNMarkets(ms, 2);
  assert.deepEqual(top.map((m) => m.symbol), ['BUSDT', 'CUSDT']);
  assert.equal(ms[0].symbol, 'AUSDT'); // original order untouched
});

// ── enrichment: disabled (default) ───────────────────────────────────────────
test('disabled mode returns rows unchanged and performs ZERO fetches', async () => {
  const markets = [mkt('BTCUSDT', 9e8), mkt('ETHUSDT', 6e8)];
  const { fetchImpl, calls } = makeFakeFetch();
  const out = await enrichMarketsWithMicrostructure(markets, {
    config: microstructureConfigFromEnv({}), // disabled
    fetchImpl,
  });
  assert.equal(out.markets, markets); // same reference, untouched
  assert.equal(out.diagnostics.microstructureEnabled, false);
  assert.equal(calls.all.length, 0);
});

// ── enrichment: top-N limit ──────────────────────────────────────────────────
test('enabled mode fetches ONLY the top-N symbols', async () => {
  const markets = [mkt('AUSDT', 10), mkt('BUSDT', 100), mkt('CUSDT', 90), mkt('DUSDT', 80), mkt('EUSDT', 5)];
  const { fetchImpl, calls } = makeFakeFetch();
  const out = await enrichMarketsWithMicrostructure(markets, {
    config: microstructureConfigFromEnv({ WORKER_MARKET_MICROSTRUCTURE_ENABLED: 'true', WORKER_MICROSTRUCTURE_TOP_N: '2' }),
    fetchImpl,
  });
  // top-2 by volume = B(100), C(90). Exactly 2 depth calls, for B and C.
  assert.equal(calls.depth.length, 2);
  assert.ok(calls.depth.every((u) => /symbol=(BUSDT|CUSDT)/.test(u)));
  assert.equal(out.diagnostics.microstructureAttempted, 2);
  assert.equal(out.diagnostics.microstructureEnriched, 2);
});

// ── enrichment: enabled appends real fields, disabled does not ────────────────
test('enabled appends measured microstructure fields to the top rows', async () => {
  const markets = [mkt('BTCUSDT', 9e8), mkt('ETHUSDC', 6e8)];
  const { fetchImpl } = makeFakeFetch({ funding: '-0.00012' });
  const out = await enrichMarketsWithMicrostructure(markets, {
    config: microstructureConfigFromEnv({ WORKER_MARKET_MICROSTRUCTURE_ENABLED: 'true', WORKER_MICROSTRUCTURE_TOP_N: '20' }),
    fetchImpl,
  });
  const btc = out.markets.find((m) => m.symbol === 'BTCUSDT');
  const eth = out.markets.find((m) => m.symbol === 'ETHUSDC');

  // USDT row: depth + spread + funding.
  assert.equal(btc.orderBookDepthWithin1Pct, 25);
  assert.ok(Math.abs(btc.depthUsdWithin1Pct - 2498.08) < 1e-6);
  assert.ok(Math.abs(btc.spreadPct - 0.02) < 1e-9);
  assert.equal(btc.fundingRate, -0.00012);

  // USDC row: depth + spread, but NO funding (no safe perp mapping).
  assert.equal(eth.orderBookDepthWithin1Pct, 25);
  assert.equal(Object.prototype.hasOwnProperty.call(eth, 'fundingRate'), false);

  // No deferred/faked fields ever invented.
  for (const k of ['absorptionScore', 'bidAbsorption', 'openInterestChangePct', 'cumulativeDelta', 'marketSellRatio']) {
    assert.equal(Object.prototype.hasOwnProperty.call(btc, k), false, `${k} must not be invented`);
  }
});

test('disabled mode never appends microstructure fields', async () => {
  const markets = [mkt('BTCUSDT', 9e8)];
  const { fetchImpl } = makeFakeFetch();
  const out = await enrichMarketsWithMicrostructure(markets, { config: microstructureConfigFromEnv({}), fetchImpl });
  assert.equal(Object.prototype.hasOwnProperty.call(out.markets[0], 'orderBookDepthWithin1Pct'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out.markets[0], 'fundingRate'), false);
});

// ── enrichment: endpoint failure ─────────────────────────────────────────────
test('endpoint failure preserves the original row, records diagnostics, never throws', async () => {
  const markets = [mkt('BTCUSDT', 9e8)];
  const { fetchImpl, calls } = makeFakeFetch({ failDepth: true, failFunding: true });
  let out;
  await assert.doesNotReject(async () => {
    out = await enrichMarketsWithMicrostructure(markets, {
      config: microstructureConfigFromEnv({ WORKER_MARKET_MICROSTRUCTURE_ENABLED: 'true' }),
      fetchImpl,
    });
  });
  const btc = out.markets.find((m) => m.symbol === 'BTCUSDT');
  assert.equal(Object.prototype.hasOwnProperty.call(btc, 'orderBookDepthWithin1Pct'), false); // no field invented
  assert.equal(Object.prototype.hasOwnProperty.call(btc, 'fundingRate'), false);
  assert.ok(calls.depth.length >= 1, 'depth was attempted');
  assert.ok(out.diagnostics.microstructureErrors.some((e) => e.includes('BTCUSDT:depth')));
  assert.equal(out.diagnostics.microstructureEnriched, 0);
});

// ── enrichment: unsupported symbol ───────────────────────────────────────────
test('unsupported symbols are skipped (no fetch, no fake values)', async () => {
  const markets = [mkt('BTCUSDT', 9e8), { symbol: 'FOOBTC', baseAsset: 'FOO', quoteAsset: 'BTC', status: 'TRADING', quoteVolume: 8e8 }];
  const { fetchImpl, calls } = makeFakeFetch();
  const out = await enrichMarketsWithMicrostructure(markets, {
    config: microstructureConfigFromEnv({ WORKER_MARKET_MICROSTRUCTURE_ENABLED: 'true', WORKER_MICROSTRUCTURE_TOP_N: '20' }),
    fetchImpl,
  });
  // Only the supported USDT symbol is fetched; the BTC-quoted one is skipped.
  assert.ok(calls.depth.every((u) => /symbol=BTCUSDT/.test(u)));
  assert.equal(out.diagnostics.microstructureSkipped, 1);
  const foo = out.markets.find((m) => m.symbol === 'FOOBTC');
  assert.equal(Object.prototype.hasOwnProperty.call(foo, 'orderBookDepthWithin1Pct'), false);
});

// ── enrichment: cache ────────────────────────────────────────────────────────
test('cache within TTL prevents a second fetch for the same symbol', async () => {
  const markets = [mkt('BTCUSDT', 9e8)];
  const { fetchImpl, calls } = makeFakeFetch();
  const cache = new Map();
  let t = 1_000_000;
  const now = () => t;
  const config = microstructureConfigFromEnv({ WORKER_MARKET_MICROSTRUCTURE_ENABLED: 'true', WORKER_MICROSTRUCTURE_CACHE_MS: '10000' });

  await enrichMarketsWithMicrostructure(markets, { config, fetchImpl, cache, now });
  const firstDepthCalls = calls.depth.length;
  assert.ok(firstDepthCalls >= 1);

  t += 5000; // within TTL
  const out2 = await enrichMarketsWithMicrostructure(markets, { config, fetchImpl, cache, now });
  assert.equal(calls.depth.length, firstDepthCalls, 'no refetch within TTL');
  assert.equal(out2.markets[0].orderBookDepthWithin1Pct, 25); // served from cache

  t += 20000; // past TTL
  await enrichMarketsWithMicrostructure(markets, { config, fetchImpl, cache, now });
  assert.ok(calls.depth.length > firstDepthCalls, 'refetch after TTL expiry');
});
