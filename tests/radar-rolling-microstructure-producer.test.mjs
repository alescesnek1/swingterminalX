import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRollingSnapshotFromSamples, normalizeRollingProducerOptions, runRollingMicrostructureProducer, selectRollingTargets } from '../scripts/radar/rolling-microstructure-producer.mjs';

const NOW = 1_800_000_000_000;
const envEnabled = { WORKER_RADAR_ROLLING_ENABLED: 'true' };
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function depth(total) { return { bids: [['100', String(total)]], asks: [['100.1', '1']] }; }
function trades({ malformed = false, stale = false, thin = false } = {}) {
  const count = thin ? 4 : 12;
  return Array.from({ length: count }, (_, index) => ({
    T: stale ? NOW - 400_000 - index : NOW - 1_000 - index,
    p: '100', q: '1', m: malformed ? 'false' : index < 9,
  }));
}
function mockFetch({ rows = trades() } = {}) {
  const calls = []; let depthCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const value = String(url); calls.push({ url: value, method: init.method || 'GET' });
    if (value.includes('/fapi/v1/aggTrades')) return response(rows);
    if (value.includes('/fapi/v1/depth')) return response(depth(depthCalls++ === 0 ? 100 : 120));
    if (value.endsWith('/api/bot/radar-rolling-microstructure')) return response({ ok: true, stored: true });
    return response({}, 404);
  };
  return { fetchImpl, calls };
}

const candidates = [{ futures_pair: 'BTCUSDT' }];

test('disabled by default returns success with no network and no POST', async () => {
  let calls = 0;
  const result = await runRollingMicrostructureProducer({ env: {}, fetchImpl: async () => { calls += 1; throw new Error('must not fetch'); }, candidates });
  assert.deepEqual(result, { ok: true, disabled: true, posted: false, snapshot: null });
  assert.equal(calls, 0);
});

test('dry-run builds a payload but does not POST', async () => {
  const { fetchImpl, calls } = mockFetch();
  const result = await runRollingMicrostructureProducer({ env: envEnabled, fetchImpl, candidates, now: NOW, logger: { log() {} } });
  assert.equal(result.ok, true); assert.equal(result.dryRun, true); assert.equal(result.posted, false);
  const row = result.snapshot.data.BTCUSDT;
  assert.equal(result.snapshot.trusted, false);
  assert.equal(row.rollingWindowSec, 300); assert.equal(row.samples.aggTrades, 12); assert.equal(row.samples.depthSnapshots, 2);
  assert.equal(row.source, 'binance-futures-public'); assert.ok(row.rollingMeasuredAt);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('post mode without worker token fails closed before any network call', async () => {
  let calls = 0;
  const result = await runRollingMicrostructureProducer({ env: { ...envEnabled, WORKER_RADAR_ROLLING_POST_ENABLED: 'true', CONTROL_BASE_URL: 'https://ctl.example' }, fetchImpl: async () => { calls += 1; return response({}); }, candidates });
  assert.equal(result.ok, false); assert.equal(result.reason, 'BOT_WORKER_TOKEN_REQUIRED'); assert.equal(calls, 0);
});

test('post mode without control URL fails closed before any network call', async () => {
  let calls = 0;
  const result = await runRollingMicrostructureProducer({ env: { ...envEnabled, WORKER_RADAR_ROLLING_POST_ENABLED: 'true', BOT_WORKER_TOKEN: 'test-token' }, fetchImpl: async () => { calls += 1; return response({}); }, candidates });
  assert.equal(result.ok, false); assert.equal(result.reason, 'CONTROL_BASE_URL_REQUIRED'); assert.equal(calls, 0);
});

test('explicit post uses only the mocked control-plane POST after public reads', async () => {
  const { fetchImpl, calls } = mockFetch();
  const result = await runRollingMicrostructureProducer({ env: { ...envEnabled, WORKER_RADAR_ROLLING_POST_ENABLED: 'true', BOT_WORKER_TOKEN: 'test-token', CONTROL_BASE_URL: 'https://ctl.example' }, fetchImpl, candidates, now: NOW, logger: { log() {} } });
  assert.equal(result.ok, true); assert.equal(result.posted, true);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.match(calls.find((call) => call.method === 'POST').url, /\/api\/bot\/radar-rolling-microstructure$/);
});

test('valid injected public samples produce only measured rolling fields', async () => {
  const { fetchImpl } = mockFetch();
  const options = normalizeRollingProducerOptions({ env: envEnabled });
  const snapshot = await buildRollingSnapshotFromSamples({ candidates, fetchImpl, options, now: NOW });
  const row = snapshot.data.BTCUSDT;
  for (const field of ['absorptionScore', 'bidDepthRebuildPct', 'aggressiveSellsFailed', 'deltaImprovementPct', 'marketBuyVolumeDominance', 'spreadAndSlippageHealthy']) assert.ok(Object.hasOwn(row, field), field);
  assert.ok(row.marketBuyVolumeDominance >= 0 && row.marketBuyVolumeDominance <= 1);
  assert.equal(row.supportRetestHeld, undefined, 'unmeasured support must remain absent');
});

test('thin, malformed-maker, and stale trades are omitted rather than posted as measurements', async () => {
  for (const variant of [{ thin: true }, { malformed: true }, { stale: true }]) {
    const { fetchImpl } = mockFetch({ rows: trades(variant) });
    const snapshot = await buildRollingSnapshotFromSamples({ candidates, fetchImpl, options: normalizeRollingProducerOptions({ env: envEnabled }), now: NOW });
    assert.deepEqual(snapshot.data, {}, JSON.stringify(variant));
  }
});

test('only stable futures symbols are targeted and top-N is bounded', () => {
  assert.deepEqual(selectRollingTargets([{ symbol: 'BTC-USDT' }, { symbol: 'BTCUSDT' }, { symbol: 'BTCUSDT' }], { topN: 99 }).map((x) => x.symbol), ['BTCUSDT']);
  assert.equal(normalizeRollingProducerOptions({ env: { ...envEnabled, WORKER_RADAR_ROLLING_TOP_N: '999' } }).topN, 10);
});

test('source contains no signed/private endpoint or scheduler wiring', () => {
  const source = readFileSync(new URL('../scripts/radar/rolling-microstructure-producer.mjs', import.meta.url), 'utf8');
  assert.match(source, /WORKER_RADAR_ROLLING_ENABLED/);
  assert.match(source, /WORKER_RADAR_ROLLING_POST_ENABLED/);
  assert.doesNotMatch(source, /\/api\/v3\/order|\/fapi\/v1\/order|\/dapi\/|\/sapi\/|signature|apiKey|apiSecret/i);
  assert.doesNotMatch(source, /cron|schedule|workflow|netlify\.toml/i);
});
