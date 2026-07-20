import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdminPriceHistorySignals } from '../netlify/functions/admin-price-history-signals.mjs';

const URL = 'https://swingterminalx.netlify.app/api/admin-price-history-signals';
const ADMIN = { ok: true, verified: true };
const NON_ADMIN = { ok: true, verified: true };
const UNVERIFIED_ADMIN = { ok: true, verified: false };
const POINTS = [110, 108, 106, 104, 104, 104.2, 104.4, 104.6].map((price_usd, i) => ({ symbol: 'BTC', sampled_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), price_usd, volume_24h_usd: i < 4 ? 100 : 220 }));
function req(method, query = 'symbol=btc') { return new Request(`${URL}?${query}`, { method }); }
function call(method, { identity = ADMIN, isAdmin = (id) => id === ADMIN || id === UNVERIFIED_ADMIN, reads, query, ...extra } = {}) {
  return runAdminPriceHistorySignals(req(method, query), { getIdentity: async () => identity, isAdmin, reads: reads || { listRecentPricePoints: async () => ({ ok: true, points: POINTS }) }, ...extra });
}

test('non-GET returns 405 before auth or database work', async () => {
  let authCalled = false; let dbCalled = false;
  const res = await runAdminPriceHistorySignals(req('POST'), { getIdentity: async () => { authCalled = true; return ADMIN; }, isAdmin: () => true, reads: { listRecentPricePoints: async () => { dbCalled = true; return { ok: true, points: [] }; } } });
  assert.equal(res.status, 405); assert.equal(authCalled, false); assert.equal(dbCalled, false);
});

test('unauthenticated, non-admin, and unverified-admin requests fail closed', async () => {
  assert.equal((await call('GET', { identity: { ok: false } })).status, 401);
  assert.equal((await call('GET', { identity: NON_ADMIN })).status, 403);
  assert.equal((await call('GET', { identity: UNVERIFIED_ADMIN })).status, 403);
});

test('missing symbol returns 400 and database unavailable returns 503', async () => {
  assert.equal((await call('GET', { query: '' })).status, 400);
  const res = await call('GET', { reads: { listRecentPricePoints: async () => ({ ok: false }) } });
  assert.equal(res.status, 503); assert.deepEqual(await res.json(), { ok: false, reason: 'DB_UNAVAILABLE' });
});

test('success returns only summaries, bounds input, and does not wire an external book', async () => {
  let captured;
  const res = await call('GET', { query: 'symbol=btc&limit=999999&lookback=999999&confirmations=999', reads: { listRecentPricePoints: async (args) => { captured = args; return { ok: true, points: POINTS }; } } });
  assert.equal(res.status, 200); assert.deepEqual(captured, { symbol: 'BTC', limit: 200 });
  const body = await res.json();
  assert.equal(body.symbol, 'BTC'); assert.equal(body.points, POINTS.length);
  assert.equal(body.orderbookUsed, false); assert.equal(body.orderbookReason, 'NOT_WIRED_THIS_PHASE');
  assert.ok(body.reclaim); assert.ok(body.absorption);
});

test('injected test book exposes only the derived summary and source remains isolated', async () => {
  const res = await call('GET', { orderbook: { best_bid: 100, best_ask: 100.1, spread_bps: 10, imbalance: 0.35 } });
  const raw = await res.text(); assert.match(raw, /INJECTED_TEST_ORDERBOOK/);
  for (const forbidden of ['raw_meta', 'token', 'secret', 'password', 'db_url', 'chat_id', 'user_id', 'bids', 'asks']) assert.equal(raw.toLowerCase().includes(forbidden), false, forbidden);
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new globalThis.URL('../netlify/functions/admin-price-history-signals.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /writeMarketPriceSnapshot|_price-history-writer|bot\.mjs|cron-alerts|radar/i);
});
