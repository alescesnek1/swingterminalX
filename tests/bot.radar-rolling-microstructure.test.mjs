import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BOT_WORKER_TOKEN = 'test-worker-token-rolling';
process.env.BOT_ALLOW_MEMORY_STORE = 'true';
process.env.AUTH_DECODE_ONLY = 'true';
process.env.SUPABASE_JWT_SECRET = 'unit-test-secret';

const { default: handler } = await import('../netlify/functions/bot.mjs');
const fleetStore = await import('../netlify/functions/_fleet-store.mjs');

const TOKEN = process.env.BOT_WORKER_TOKEN;
const NOW = Date.now();

function req(method, path, body, token = TOKEN) {
  const headers = { Accept: 'application/json' };
  if (token) headers['X-BOT-WORKER-TOKEN'] = token;
  const init = { method, headers };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  return new Request(`https://ctl.example${path}`, init);
}
async function call(r) { const res = await handler(r); return { status: res.status, json: await res.json().catch(() => ({})) }; }
async function resetFleet() { await fleetStore.saveFleet(fleetStore.emptyFleet()); }
function snapshot() {
  return { provider: 'manual-public', updatedAtMs: NOW, trusted: true, data: { BTCUSDT: { bidDepthRebuildPct: 12, marketSellRatio: 0.45, openInterestChangePct: -2, longLiquidationSpike: 1.5, flow: { takerBuySellRatio: 1.4, cumulativeDeltaPct: 3, aggressiveSellExhaustion: true } } } };
}

test('unauthorized POST blocked', async () => {
  await resetFleet();
  const res = await call(req('POST', '/api/bot/radar-rolling-microstructure', { workerId: 'w', snapshot: snapshot() }, null));
  assert.equal(res.status, 403);
});

test('unauthorized GET blocked', async () => {
  await resetFleet();
  const res = await call(req('GET', '/api/bot/radar-rolling-microstructure', undefined, null));
  assert.equal(res.status, 403);
});

test('authorized POST stores snapshot', async () => {
  await resetFleet();
  const res = await call(req('POST', '/api/bot/radar-rolling-microstructure', { workerId: 'rolling-1', snapshot: snapshot() }));
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.stored, true);
  const fleet = await fleetStore.loadFleet();
  assert.equal(fleet.radarRollingMicrostructureSnapshot.workerId, 'rolling-1');
  assert.equal(fleet.radarRollingMicrostructureSnapshot.data.BTCUSDT.strictReady, true);
});

test('authorized GET returns snapshot', async () => {
  await resetFleet();
  await call(req('POST', '/api/bot/radar-rolling-microstructure', { workerId: 'rolling-2', snapshot: snapshot() }));
  const res = await call(req('GET', '/api/bot/radar-rolling-microstructure'));
  assert.equal(res.status, 200);
  assert.equal(res.json.snapshot.workerId, 'rolling-2');
  assert.equal(res.json.snapshot.data.BTCUSDT.marketSellRatio, 0.45);
});

test('invalid payload fail-safe', async () => {
  await resetFleet();
  const res = await call(req('POST', '/api/bot/radar-rolling-microstructure', { workerId: 'rolling-3', nonsense: true }));
  assert.equal(res.status, 200);
  assert.equal(res.json.stored, false);
  const get = await call(req('GET', '/api/bot/radar-rolling-microstructure'));
  assert.equal(get.json.snapshot, null);
});