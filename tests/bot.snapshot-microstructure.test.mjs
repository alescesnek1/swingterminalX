// bot.mjs snapshot sanitizer — RADAR microstructure pass-through contract.
//
// Proves sanitizeSnapshotMarket (exercised via POST /api/bot/auto-market-snapshot)
//   - preserves finite numeric microstructure fields, including a real measured 0;
//   - normalizes explicit 'true'/'false' string booleans;
//   - DROPS invalid values (NaN / non-numeric / non-boolean) rather than coercing;
//   - never INVENTS fields that were absent from the worker payload.
// No thresholds, Telegram, worker, or order-execution logic is involved. Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.BOT_WORKER_TOKEN = 'test-worker-token-micro';
process.env.BOT_ADMIN_EMAILS = 'admin@example.com';
process.env.SUPABASE_JWT_SECRET = 'unit-test-secret-micro';
process.env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDC';
delete process.env.AUTO_TRADER_ENABLED;
delete process.env.AUTO_TRADER_MODE;

const storeState = new Map();
const fakeBlobStore = {
  async get() { const raw = storeState.get('fleet-state'); return raw ? JSON.parse(raw) : null; },
  async setJSON(key, value) { storeState.set(key, JSON.stringify(value)); return { modified: true }; },
  async getWithMetadata() { const raw = storeState.get('fleet-state'); return { data: raw ? JSON.parse(raw) : null, etag: crypto.randomBytes(4).toString('hex') }; },
};
const fleetStore = await import('../netlify/functions/_fleet-store.mjs');
fleetStore.__setBlobStoreForTest(fakeBlobStore);
const { default: handler } = await import('../netlify/functions/bot.mjs');

const SOURCE = 'local_worker_binance_public';
function workerReq(body, token = process.env.BOT_WORKER_TOKEN) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers['X-BOT-WORKER-TOKEN'] = token;
  return new Request('https://ctl.example/api/bot/auto-market-snapshot', { method: 'POST', headers, body: JSON.stringify(body) });
}
async function call(req) { const res = await handler(req); const json = await res.json().catch(() => ({})); return { status: res.status, json }; }

test('snapshot sanitizer preserves valid microstructure, normalizes string booleans, drops invalid, and invents nothing', async () => {
  const payload = {
    workerId: 'worker_micro', sessionId: 'session_micro', source: SOURCE,
    fetchedAt: new Date().toISOString(),
    markets: [{
      symbol: 'ABCUSDC', baseAsset: 'ABC', quoteAsset: 'USDC', status: 'TRADING',
      quoteVolume: 5e8, bidPrice: 100, askPrice: 100.02, lastPrice: 100, spreadPct: 0.02, priceChangePercent: -7,
      // Valid numerics (incl. a genuine measured 0 that must be preserved):
      orderBookDepthWithin1Pct: 1_500_000, depthUsdWithin1Pct: 1_500_000,
      openInterestChangePct: -6.5, fundingRate: 0, longLiquidationSpike: 2.1, shortLiquidationSpike: 0,
      marketSellRatio: 0.66, takerBuySellRatio: 1.3, cumulativeDelta: -120000, deltaImprovementPct: 4,
      bidDepthRebuildPct: 12, absorptionScore: 80, distanceToSupportPct: 0.4,
      marketBuyVolumeDominance: 0.58, buyVolumeDominance: 0.57,
      // Booleans, real + string-normalized:
      bidAbsorption: true, aggressiveSellsFailed: 'true', supportRetested: 'false',
      // Invalid values that must be DROPPED, not coerced:
      liquidationLowRetested: 'maybe',
      fundingRateBogus: 'abc',
      cumulativeDeltaBad: NaN,
    }],
    diagnostics: { fetchedSymbols: 1, eligibleSymbols: 1, postedSymbols: 1 },
  };
  const res = await call(workerReq(payload));
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);

  const fleet = await fleetStore.loadFleet();
  const m = fleet.autoMarketSnapshot.markets.find((x) => x.symbol === 'ABCUSDC');
  assert.ok(m, 'sanitized market stored');

  // Valid numerics preserved, including measured zeros.
  assert.equal(m.orderBookDepthWithin1Pct, 1_500_000);
  assert.equal(m.depthUsdWithin1Pct, 1_500_000);
  assert.equal(m.openInterestChangePct, -6.5);
  assert.equal(m.fundingRate, 0);
  assert.equal(m.longLiquidationSpike, 2.1);
  assert.equal(m.shortLiquidationSpike, 0);
  assert.equal(m.marketSellRatio, 0.66);
  assert.equal(m.takerBuySellRatio, 1.3);
  assert.equal(m.cumulativeDelta, -120000);
  assert.equal(m.deltaImprovementPct, 4);
  assert.equal(m.bidDepthRebuildPct, 12);
  assert.equal(m.absorptionScore, 80);
  assert.equal(m.distanceToSupportPct, 0.4);
  assert.equal(m.marketBuyVolumeDominance, 0.58);
  assert.equal(m.buyVolumeDominance, 0.57);

  // Booleans: real + string-normalized.
  assert.equal(m.bidAbsorption, true);
  assert.equal(m.aggressiveSellsFailed, true);
  assert.equal(m.supportRetested, false);

  // Invalid boolean string dropped (not stored as a truthy/garbage value).
  assert.equal(Object.prototype.hasOwnProperty.call(m, 'liquidationLowRetested'), false);
  // Non-contract / invalid fields never invented or smuggled in.
  assert.equal(Object.prototype.hasOwnProperty.call(m, 'fundingRateBogus'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(m, 'cumulativeDeltaBad'), false);
});

test('missing microstructure fields are not invented on the stored snapshot', async () => {
  const payload = {
    workerId: 'worker_micro', sessionId: 'session_micro', source: SOURCE,
    fetchedAt: new Date().toISOString(),
    markets: [{
      symbol: 'BAREUSDC', baseAsset: 'BARE', quoteAsset: 'USDC', status: 'TRADING',
      quoteVolume: 3e8, bidPrice: 50, askPrice: 50.01, lastPrice: 50, spreadPct: 0.02, priceChangePercent: -3,
    }],
    diagnostics: { fetchedSymbols: 1, eligibleSymbols: 1, postedSymbols: 1 },
  };
  assert.equal((await call(workerReq(payload))).status, 200);
  const fleet = await fleetStore.loadFleet();
  const m = fleet.autoMarketSnapshot.markets.find((x) => x.symbol === 'BAREUSDC');
  assert.ok(m);
  for (const key of ['orderBookDepthWithin1Pct', 'openInterestChangePct', 'fundingRate',
    'longLiquidationSpike', 'shortLiquidationSpike', 'absorptionScore', 'bidAbsorption', 'aggressiveSellsFailed']) {
    assert.equal(Object.prototype.hasOwnProperty.call(m, key), false, `${key} must not be invented`);
  }
});
