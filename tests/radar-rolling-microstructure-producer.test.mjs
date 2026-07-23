import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRollingSnapshotFromSamples, isAllowedBinanceFuturesBaseUrl, normalizeRollingProducerOptions, runRollingMicrostructureProducer, selectRollingTargets } from '../scripts/radar/rolling-microstructure-producer.mjs';
const NOW = 1_800_000_000_000; const envEnabled = { WORKER_RADAR_ROLLING_ENABLED: 'true' }; const candidates = [{ futures_pair: 'BTCUSDT' }];
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const depth = (total) => ({ bids: [['100', String(total)]], asks: [['100.05', '1']] });
function trades({ malformed = false, stale = false, thin = false } = {}) { const count = thin ? 4 : 12; return Array.from({ length: count }, (_, index) => ({ T: stale ? NOW - 400000 - index : NOW - 299000 + index * 1000, p: index < 8 ? '100' : '101', q: index < 8 ? '10' : '15', m: malformed && index === 0 ? 'false' : index < 8 })); }
function klines() { return Array.from({ length: 30 }, (_, index) => [NOW - (30 - index) * 60000, '100', '102', index < 20 ? '99' : '99.2', index < 29 ? '100' : '101']); }
function mockFetch({ rows = trades() } = {}) { const calls = []; let depthCalls = 0; const fetchImpl = async (url, init = {}) => { const value = String(url); calls.push({ url: value, method: init.method || 'GET' }); if (value.includes('/fapi/v1/aggTrades')) return response(rows); if (value.includes('/fapi/v1/klines')) return response(klines()); if (value.includes('/fapi/v1/depth')) return response(depth(depthCalls++ === 0 ? 100 : 120)); if (value.endsWith('/api/bot/radar-rolling-microstructure')) return response({ stored: true }); return response({}, 404); }; return { fetchImpl, calls }; }
const options = () => normalizeRollingProducerOptions({ env: envEnabled, depthIntervalMs: 0 });
test('disabled by default returns success with no network', async () => { let calls = 0; const result = await runRollingMicrostructureProducer({ env: {}, fetchImpl: async () => { calls += 1; throw new Error('must not fetch'); }, candidates }); assert.deepEqual(result, { ok: true, disabled: true, posted: false, snapshot: null }); assert.equal(calls, 0); });
test('complete validated public samples create a trusted local snapshot without POST', async () => { const { fetchImpl, calls } = mockFetch(); const result = await runRollingMicrostructureProducer({ env: envEnabled, fetchImpl, candidates, now: NOW, depthIntervalMs: 0, waitFn: async () => {}, logger: { log() {} } }); const row = result.snapshot.data.BTCUSDT; assert.equal(result.dryRun, true); assert.equal(result.snapshot.trusted, true); assert.equal(row.rollingWindowSec, 300); assert.deepEqual(row.samples, { aggTrades: 12, depthSnapshots: 2, klines: 30 }); assert.equal(row.source, 'binance-futures-public'); assert.equal(row.validation.makerFlagsValid, true); for (const field of ['absorptionScore', 'bidDepthRebuildPct', 'aggressiveSellsFailed', 'deltaImprovementPct', 'marketBuyVolumeDominance', 'supportRetestHeld', 'spreadAndSlippageHealthy', 'spreadPct', 'depthUsdWithin1Pct']) assert.ok(Object.hasOwn(row, field), field); assert.ok(row.marketBuyVolumeDominance >= 0 && row.marketBuyVolumeDominance <= 1); assert.ok(calls.every((call) => call.method === 'GET')); });
test('thin, malformed-maker, and stale samples are omitted and cannot become trusted', async () => { for (const variant of [{ thin: true }, { malformed: true }, { stale: true }]) { const { fetchImpl } = mockFetch({ rows: trades(variant) }); const snapshot = await buildRollingSnapshotFromSamples({ candidates, fetchImpl, options: options(), now: NOW, waitFn: async () => {} }); assert.equal(snapshot.trusted, false, JSON.stringify(variant)); assert.deepEqual(snapshot.data, {}, JSON.stringify(variant)); } });
test('explicit post remains separately opt-in and fails before network when token is absent', async () => { let calls = 0; const result = await runRollingMicrostructureProducer({ env: { ...envEnabled, WORKER_RADAR_ROLLING_POST_ENABLED: 'true', CONTROL_BASE_URL: 'https://ctl.example' }, fetchImpl: async () => { calls += 1; return response({}); }, candidates }); assert.equal(result.reason, 'BOT_WORKER_TOKEN_REQUIRED'); assert.equal(calls, 0); });
test('only stable futures symbols are targeted and top-N is bounded', () => { assert.deepEqual(selectRollingTargets([{ symbol: 'BTC-USDT' }, { symbol: 'BTCUSDT' }, { symbol: 'BTCUSDT' }], { topN: 99 }).map((x) => x.symbol), ['BTCUSDT']); assert.equal(normalizeRollingProducerOptions({ env: { ...envEnabled, WORKER_RADAR_ROLLING_TOP_N: '999' } }).topN, 10); });
test('source has only public unsigned reads, no scheduler or signed endpoint', () => { const source = readFileSync(new URL('../scripts/radar/rolling-microstructure-producer.mjs', import.meta.url), 'utf8'); assert.match(source, /\/fapi\/v1\/(aggTrades|depth|klines)/); assert.doesNotMatch(source, /\/fapi\/v1\/order|\/dapi\/|\/sapi\/|signature|apiKey|apiSecret/i); assert.doesNotMatch(source, /cron|schedule|workflow|netlify\.toml/i); });
test('trusted rolling measurements require the exact HTTPS Binance Futures host', () => {
  assert.equal(isAllowedBinanceFuturesBaseUrl('https://fapi.binance.com'), true);
  for (const hostile of ['http://fapi.binance.com', 'https://evil.com', 'https://fapi.binance.com.evil.com', 'https://localhost', 'https://127.0.0.1', '//fapi.binance.com', 'javascript:alert(1)']) {
    assert.equal(isAllowedBinanceFuturesBaseUrl(hostile), false, hostile);
  }
});

test('hostile base URLs fail closed before any injected fetch and cannot produce trusted data', async () => {
  for (const baseUrl of ['http://fapi.binance.com', 'https://evil.com', 'https://fapi.binance.com.evil.com', 'https://localhost', 'https://127.0.0.1', '//fapi.binance.com', 'javascript:alert(1)']) {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; throw new Error('must not fetch hostile host'); };
    const producerOptions = normalizeRollingProducerOptions({ env: envEnabled, baseUrl, depthIntervalMs: 0 });
    const snapshot = await buildRollingSnapshotFromSamples({ candidates, fetchImpl, options: producerOptions, now: NOW, waitFn: async () => {} });
    assert.equal(snapshot.trusted, false, baseUrl);
    assert.deepEqual(snapshot.data, {}, baseUrl);
    assert.equal(calls, 0, baseUrl);
    const result = await runRollingMicrostructureProducer({ env: envEnabled, baseUrl, fetchImpl, candidates, now: NOW, waitFn: async () => {}, logger: { log() {} } });
    assert.equal(result.reason, 'BINANCE_FUTURES_BASE_URL_NOT_ALLOWED', baseUrl);
    assert.equal(calls, 0, baseUrl);
  }
});
function candidateAwareFetch({ candidateRows = candidates, candidateStatus = 200, rows = trades(), fapiStatus = 200 } = {}) {
  const calls = []; let depthCalls = 0;
  let fetchImpl = async (url, init = {}) => {
    const value = String(url); calls.push({ url: value, method: init.method || 'GET', headers: init.headers || {} });
    if (value.endsWith('/api/bot/radar-candidates')) return response({ ok: true, radarCandidates: candidateRows }, candidateStatus);
    if (value.includes('/fapi/v1/')) return response({}, fapiStatus);
    if (value.endsWith('/api/bot/radar-rolling-microstructure')) return response({ ok: true, stored: true });
    return response({}, 404);
  };
  if (fapiStatus === 200) {
    fetchImpl = async (url, init = {}) => {
      const value = String(url); calls.push({ url: value, method: init.method || 'GET', headers: init.headers || {} });
      if (value.endsWith('/api/bot/radar-candidates')) return response({ ok: true, radarCandidates: candidateRows }, candidateStatus);
      if (value.includes('/fapi/v1/aggTrades')) return response(rows);
      if (value.includes('/fapi/v1/klines')) return response(klines());
      if (value.includes('/fapi/v1/depth')) return response(depth(depthCalls++ === 0 ? 100 : 120));
      if (value.endsWith('/api/bot/radar-rolling-microstructure')) return response({ ok: true, stored: true });
      return response({}, 404);
    };
  }
  return { fetchImpl, calls };
}
const fetchedEnv = { ...envEnabled, CONTROL_BASE_URL: 'https://control.example', BOT_WORKER_TOKEN: 'test-token-must-not-log' };

test('missing explicit candidates loads token-protected candidates without logging the token', async () => {
  const { fetchImpl, calls } = candidateAwareFetch(); const logs = [];
  const result = await runRollingMicrostructureProducer({ env: fetchedEnv, fetchImpl, now: NOW, depthIntervalMs: 0, waitFn: async () => {}, logger: { log(value) { logs.push(String(value)); } } });
  assert.equal(result.dryRun, true); assert.equal(result.snapshot.trusted, true); const call = calls.find((entry) => entry.url.endsWith('/api/bot/radar-candidates'));
  assert.equal(call.method, 'GET'); assert.equal(call.headers['X-BOT-WORKER-TOKEN'], fetchedEnv.BOT_WORKER_TOKEN); assert.ok(logs.every((line) => !line.includes(fetchedEnv.BOT_WORKER_TOKEN)));
});

test('candidate fetch failure and zero candidates fail closed without POST', async () => {
  for (const variant of [{ candidateStatus: 503, reason: 'CANDIDATE_FETCH_FAILED_NO_POST' }, { candidateRows: [], reason: 'NO_CANDIDATES_NO_POST' }]) {
    const { fetchImpl, calls } = candidateAwareFetch(variant); const result = await runRollingMicrostructureProducer({ env: { ...fetchedEnv, WORKER_RADAR_ROLLING_POST_ENABLED: 'true' }, fetchImpl, now: NOW, depthIntervalMs: 0, waitFn: async () => {}, logger: { log() {} } });
    assert.equal(result.reason, variant.reason); assert.equal(result.posted, false); assert.equal(calls.some((entry) => entry.method === 'POST'), false);
  }
});

test('empty, invalid, thin, and 451 measurements never POST', async () => {
  const variants = [
    { candidateRows: [{ alphaPair: 'ALPHA_BTCUSDT' }, { spot_pair: 'BTCUSDT' }], reason: 'NO_CANDIDATES_NO_POST' },
    { rows: trades({ thin: true }), reason: 'NO_TRUSTED_ROWS_NO_POST' },
    { fapiStatus: 451, reason: 'BINANCE_EGRESS_BLOCKED_NO_POST' },
  ];
  for (const variant of variants) {
    const { fetchImpl, calls } = candidateAwareFetch(variant); const result = await runRollingMicrostructureProducer({ env: { ...fetchedEnv, WORKER_RADAR_ROLLING_POST_ENABLED: 'true' }, fetchImpl, now: NOW, depthIntervalMs: 0, waitFn: async () => {}, logger: { log() {} } });
    assert.equal(result.reason, variant.reason); assert.equal(result.posted, false); assert.equal(calls.some((entry) => entry.method === 'POST'), false);
  }
});

test('valid fetched futures candidate posts exactly one trusted snapshot', async () => {
  const { fetchImpl, calls } = candidateAwareFetch({ candidateRows: [{ alphaPair: 'ALPHA_BTCUSDT' }, { spot_pair: 'BTCUSDT' }, { futures_pair: 'BTCUSDT' }] });
  const result = await runRollingMicrostructureProducer({ env: { ...fetchedEnv, WORKER_RADAR_ROLLING_POST_ENABLED: 'true' }, fetchImpl, now: NOW, depthIntervalMs: 0, waitFn: async () => {}, logger: { log() {} } });
  assert.equal(result.snapshot.trusted, true); assert.equal(result.posted, true); assert.equal(result.candidateCount, 1); assert.equal(calls.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/api/bot/radar-rolling-microstructure')).length, 1);
});

test('explicit symbols bypass candidate fetch and invalid symbols stay fail closed', async () => {
  const { fetchImpl, calls } = candidateAwareFetch(); const result = await runRollingMicrostructureProducer({ env: envEnabled, candidates: [{ futures_pair: 'BTCUSDT' }], fetchImpl, now: NOW, depthIntervalMs: 0, waitFn: async () => {}, logger: { log() {} } });
  assert.equal(result.snapshot.trusted, true); assert.equal(calls.some((entry) => entry.url.endsWith('/api/bot/radar-candidates')), false);
});
