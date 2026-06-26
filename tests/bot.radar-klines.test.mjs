import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.BOT_WORKER_TOKEN = 'test-worker-token-radar-klines';
process.env.BOT_ALLOW_MEMORY_STORE = 'true';
process.env.AUTH_DECODE_ONLY = 'true';
process.env.SUPABASE_JWT_SECRET = 'unit-test-secret';

const { default: handler } = await import('../netlify/functions/bot.mjs');
const fleetStore = await import('../netlify/functions/_fleet-store.mjs');

const TOKEN = process.env.BOT_WORKER_TOKEN;
const HOUR = 60 * 60 * 1000;

function req(method, path, body, token = TOKEN) {
  const headers = { Accept: 'application/json' };
  if (token) headers['X-BOT-WORKER-TOKEN'] = token;
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return new Request(`https://ctl.example${path}`, init);
}

async function call(request) {
  const res = await handler(request);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function closedCandle(now, offsetHours, close = 100.5) {
  const openTime = now - offsetHours * HOUR;
  return {
    openTime,
    open: 100,
    high: 101,
    low: 99,
    close,
    volume: 1234,
    closeTime: openTime + HOUR - 1,
  };
}

async function resetFleet() {
  await fleetStore.saveFleet(fleetStore.emptyFleet());
}

test('unauthorized radar-klines POST is rejected', async () => {
  await resetFleet();
  const res = await call(req('POST', '/api/bot/radar-klines', { workerId: 'w1', data: {} }, null));

  assert.equal(res.status, 403);
  assert.equal(res.json.ok, false);
});

test('unauthorized radar-klines GET is rejected', async () => {
  await resetFleet();
  const res = await call(req('GET', '/api/bot/radar-klines', undefined, null));

  assert.equal(res.status, 403);
  assert.equal(res.json.ok, false);
});

test('authorized POST stores normalized snapshot', async () => {
  await resetFleet();
  const now = Date.now();
  const res = await call(req('POST', '/api/bot/radar-klines', {
    workerId: 'worker-klines-1',
    updatedAtMs: now - 1000,
    timeframe: '1h',
    data: {
      btcusdt: [
        [now - 3 * HOUR, '100', '101', '99', '100.5', '1234', now - 2 * HOUR - 1],
        closedCandle(now, 2, 101.5),
      ],
      'BAD-SYMBOL': [closedCandle(now, 2)],
    },
  }));

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.stored, true);
  assert.equal(res.json.diagnostics.requested, 2);
  assert.equal(res.json.diagnostics.stored, 1);
  assert.deepEqual(res.json.diagnostics.invalidSymbols, ['BAD-SYMBOL']);

  const fleet = await fleetStore.loadFleet();
  assert.equal(fleet.radarKlinesSnapshot.source, 'local_worker_radar_klines');
  assert.equal(fleet.radarKlinesSnapshot.workerId, 'worker-klines-1');
  assert.deepEqual(Object.keys(fleet.radarKlinesSnapshot.data), ['BTCUSDT']);
  assert.deepEqual(Object.keys(fleet.radarKlinesSnapshot.data.BTCUSDT[0]), ['openTime', 'open', 'high', 'low', 'close', 'volume', 'closeTime']);
});

test('immediate authorized GET sees stored snapshot', async () => {
  await resetFleet();
  const now = Date.now();
  await call(req('POST', '/api/bot/radar-klines', {
    workerId: 'worker-klines-2',
    updatedAtMs: now - 1000,
    symbols: { ETHUSDT: [closedCandle(now, 3), closedCandle(now, 2)] },
  }));

  const res = await call(req('GET', '/api/bot/radar-klines'));
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.snapshot.workerId, 'worker-klines-2');
  assert.equal(res.json.snapshot.data.ETHUSDT.length, 2);
});

test('invalid payload does not crash and is fail-safe', async () => {
  await resetFleet();
  const res = await call(req('POST', '/api/bot/radar-klines', { workerId: 'worker-klines-3', nonsense: true }));

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.stored, false);
  const get = await call(req('GET', '/api/bot/radar-klines'));
  assert.equal(get.json.snapshot, null);
});

test('endpoint does not touch worker/session/order paths', async () => {
  await resetFleet();
  const now = Date.now();
  await call(req('POST', '/api/bot/radar-klines', {
    workerId: 'worker-klines-4',
    updatedAtMs: now - 1000,
    data: { SOLUSDT: [closedCandle(now, 2)] },
  }));

  const fleet = await fleetStore.loadFleet();
  assert.deepEqual(fleet.botSessions, {});
  assert.deepEqual(fleet.workerStatuses, {});
  assert.deepEqual(fleet.executionIntents, {});
  assert.deepEqual(fleet.executionResults, {});
  assert.deepEqual(fleet.positionResults, {});
  assert.deepEqual(fleet.commandQueue, {});
  assert.equal(fleet.radarKlinesSnapshot.data.SOLUSDT.length, 1);
});

test('source guard: radar-klines patch has no signed/order/fapi/dapi/sapi endpoint references', () => {
  const source = readFileSync(new URL('../netlify/functions/bot.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("if (base === 'radar-klines')");
  const end = source.indexOf("if (base === 'radar-microstructure')", start);
  assert.ok(start > 0, 'radar-klines branch exists');
  assert.ok(end > start, 'radar-klines branch is before radar-microstructure');
  const branch = source.slice(start, end);

  assert.doesNotMatch(branch, /fetch\s*\(/i);
  assert.doesNotMatch(branch, /\/fapi\/|\/dapi\/|\/sapi\//i);
  assert.doesNotMatch(branch, /\/api\/v3\/order|signature|apiKey|apiSecret/i);
  assert.doesNotMatch(branch, /execution-intent|worker-session|position-result|execution-result/i);
});