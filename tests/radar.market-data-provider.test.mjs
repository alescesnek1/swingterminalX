// Market Data Provider abstraction contract.
//
// Proves the provider layer is FAIL-CLOSED:
//   • default (unset) and explicit MARKET_DATA_PROVIDER=none make ZERO external
//     calls and report provider-unavailable;
//   • MARKET_DATA_PROVIDER=binance-public uses the existing PUBLIC fapi logic
//     only when explicitly set, and never a signed/keyed endpoint;
//   • snapshot status classification distinguishes present / stale / unavailable.
// Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMarketDataProvider,
  resolveProviderName,
  microstructureSnapshotStatus,
  PROVIDER_UNAVAILABLE,
} from '../scripts/radar/market-data-provider.mjs';

const CAND = { symbol: 'BEATUSDT', base: 'BEAT', pair: 'BEATUSDT', futures_pair: 'BEATUSDT', quote: 'USDT' };

function neverFetch() {
  return () => { throw new Error('external fetch must not happen'); };
}

test('resolveProviderName falls closed to none for unset/empty/unknown', () => {
  assert.equal(resolveProviderName({}), 'none');
  assert.equal(resolveProviderName({ MARKET_DATA_PROVIDER: '' }), 'none');
  assert.equal(resolveProviderName({ MARKET_DATA_PROVIDER: 'whatever' }), 'none');
  assert.equal(resolveProviderName({ MARKET_DATA_PROVIDER: 'binance-public' }), 'binance-public');
  assert.equal(resolveProviderName({ MARKET_DATA_PROVIDER: 'BINANCE-PUBLIC' }), 'binance-public');
  assert.equal(resolveProviderName({ MARKET_DATA_PROVIDER: 'snapshot' }), 'snapshot');
});

test('default provider is none: zero external calls, provider-unavailable', async () => {
  const provider = createMarketDataProvider({}, { fetchFn: neverFetch() });
  assert.equal(provider.name, 'none');
  const health = provider.health();
  assert.equal(health.status, 'unavailable');
  assert.equal(health.reason, PROVIDER_UNAVAILABLE);
  const res = await provider.getStaticMicrostructure(CAND);
  assert.equal(res.available, false);
  assert.equal(res.reason, PROVIDER_UNAVAILABLE);
  assert.equal(res.fields, null);
});

test('MARKET_DATA_PROVIDER=none: zero external calls', async () => {
  const provider = createMarketDataProvider({ MARKET_DATA_PROVIDER: 'none' }, { fetchFn: neverFetch() });
  assert.equal(provider.name, 'none');
  await provider.getStaticMicrostructure(CAND); // must not throw (no fetch)
  assert.equal(provider.health().status, 'unavailable');
});

test('binance-public uses PUBLIC fapi logic only when explicitly set', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/fapi/v1/depth')) {
      return new Response(JSON.stringify({ bids: [['1.0', '100']], asks: [['1.01', '100']] }), { status: 200 });
    }
    if (u.includes('/fapi/v1/premiumIndex')) {
      return new Response(JSON.stringify({ lastFundingRate: '0.0001' }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 400 });
  };
  const provider = createMarketDataProvider({ MARKET_DATA_PROVIDER: 'binance-public' }, { fetchFn });
  assert.equal(provider.name, 'binance-public');
  assert.equal(provider.health().status, 'available');

  const res = await provider.getStaticMicrostructure(CAND);
  assert.equal(res.available, true);
  assert.equal(res.symbol, 'BEATUSDT');
  assert.equal(res.fields.orderBookDepthWithin1Pct, 200);
  assert.equal(res.fields.fundingRate, 0.0001);

  // Public market data only — never a signed/keyed/order endpoint.
  for (const u of calls) {
    assert.ok(!/signature|timestamp|apikey/i.test(u), `no signed query: ${u}`);
    assert.ok(!/\/fapi\/v1\/order|\/sapi\/|\/dapi\//.test(u), `no order/signed endpoint: ${u}`);
  }
  assert.ok(calls.some((u) => u.includes('/fapi/v1/depth')), 'measured via public fapi depth');
});

test('snapshot provider serves stored data with NO external fetch', async () => {
  const snapshot = { receivedAt: new Date().toISOString(), data: { BEATUSDT: { spreadPct: 0.05, fundingRate: -0.0001 } } };
  const provider = createMarketDataProvider({ MARKET_DATA_PROVIDER: 'snapshot' }, { fetchFn: neverFetch(), snapshot });
  assert.equal(provider.name, 'snapshot');
  assert.equal(provider.health().status, 'available');
  const res = await provider.getStaticMicrostructure(CAND);
  assert.equal(res.available, true);
  assert.equal(res.symbol, 'BEATUSDT');
  assert.equal(res.fields.spreadPct, 0.05);
});

test('snapshot provider with no data is unavailable', async () => {
  const provider = createMarketDataProvider({ MARKET_DATA_PROVIDER: 'snapshot' }, { fetchFn: neverFetch(), snapshot: null });
  assert.equal(provider.health().status, 'unavailable');
  const res = await provider.getStaticMicrostructure(CAND);
  assert.equal(res.available, false);
  assert.equal(res.reason, PROVIDER_UNAVAILABLE);
});

// ── snapshot status classification (API/UI diagnostics) ──────────────────────

test('microstructureSnapshotStatus: missing snapshot => unavailable', () => {
  const s = microstructureSnapshotStatus(null, Date.now());
  assert.equal(s.present, false);
  assert.equal(s.providerStatus, 'unavailable');
  assert.equal(s.unavailableReason, PROVIDER_UNAVAILABLE);
  assert.equal(s.provider, 'none');
});

test('microstructureSnapshotStatus: fresh data => present', () => {
  const now = Date.now();
  const snap = { provider: 'binance-public', receivedAt: new Date(now - 1000).toISOString(), data: { BEATUSDT: {} } };
  const s = microstructureSnapshotStatus(snap, now);
  assert.equal(s.present, true);
  assert.equal(s.providerStatus, 'present');
  assert.equal(s.provider, 'binance-public');
  assert.equal(s.unavailableReason, null);
});

test('microstructureSnapshotStatus: old data => stale', () => {
  const now = Date.now();
  const snap = { provider: 'binance-public', receivedAt: new Date(now - 60 * 60 * 1000).toISOString(), data: { BEATUSDT: {} } };
  const s = microstructureSnapshotStatus(snap, now);
  assert.equal(s.present, true);
  assert.equal(s.stale, true);
  assert.equal(s.providerStatus, 'stale');
});

// ── trusted gate + serialized staticLabel (stale must read as diagnostic cache) ──

test('microstructureSnapshotStatus: provider=none + stale serializes as untrusted stale diagnostic cache', () => {
  const now = Date.now();
  // Pre-provider snapshot (no provider field => "none") that has gone stale.
  const snap = { receivedAt: new Date(now - 60 * 60 * 1000).toISOString(), data: { BEATUSDT: {} } };
  const s = microstructureSnapshotStatus(snap, now);
  assert.equal(s.provider, 'none');
  assert.equal(s.providerStatus, 'stale');
  assert.equal(s.trusted, false);
  assert.equal(s.staticLabel, 'stale diagnostic cache');
});

test('microstructureSnapshotStatus: fresh data from provider=none is still untrusted', () => {
  const now = Date.now();
  // Even fresh, a snapshot with no real provider tag is not trusted live data.
  const snap = { receivedAt: new Date(now - 1000).toISOString(), data: { BEATUSDT: {} } };
  const s = microstructureSnapshotStatus(snap, now);
  assert.equal(s.provider, 'none');
  assert.equal(s.trusted, false);
  assert.equal(s.staticLabel, 'stale diagnostic cache');
});

test('microstructureSnapshotStatus: missing snapshot => unavailable staticLabel, untrusted', () => {
  const s = microstructureSnapshotStatus(null, Date.now());
  assert.equal(s.trusted, false);
  assert.equal(s.staticLabel, 'provider unavailable');
});

test('microstructureSnapshotStatus: fresh data from a real provider is trusted/present', () => {
  const now = Date.now();
  const snap = { provider: 'binance-public', receivedAt: new Date(now - 1000).toISOString(), data: { BEATUSDT: {} } };
  const s = microstructureSnapshotStatus(snap, now);
  assert.equal(s.trusted, true);
  assert.equal(s.staticLabel, 'present');
});
