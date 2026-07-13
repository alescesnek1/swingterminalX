import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.BOT_WORKER_TOKEN = 'test-worker-token-radar-long-short';
process.env.BOT_ALLOW_MEMORY_STORE = 'true';
process.env.AUTH_DECODE_ONLY = 'true';
process.env.SUPABASE_JWT_SECRET = 'unit-test-secret';

const { default: handler } = await import('../netlify/functions/bot.mjs');
const fleetStore = await import('../netlify/functions/_fleet-store.mjs');

const TOKEN = process.env.BOT_WORKER_TOKEN;

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

async function resetFleet() {
  await fleetStore.saveFleet(fleetStore.emptyFleet());
}

function snapshot(symbol = 'BEATUSDT') {
  return {
    source: 'binance-futures-data',
    contextOnly: true,
    updatedAt: new Date().toISOString(),
    period: '5m',
    topN: 20,
    symbols: {
      [symbol]: {
        contextOnly: true,
        source: 'binance-futures-data',
        symbol,
        period: '5m',
        updatedAt: new Date().toISOString(),
        stale: false,
        available: true,
        topTraderPositionRatio: 1.8,
        globalAccountRatio: 1.2,
        takerBuySellRatio: 0.9,
        interpretation: 'balanced',
        warnings: [],
        missing: [],
      },
    },
  };
}

test('unauthorized radar-long-short POST and GET are rejected', async () => {
  await resetFleet();
  const post = await call(req('POST', '/api/bot/radar-long-short', { workerId: 'w', snapshot: snapshot() }, null));
  const get = await call(req('GET', '/api/bot/radar-long-short', undefined, null));
  assert.equal(post.status, 403);
  assert.equal(get.status, 403);
});

test('authorized compact payload is normalized and stored', async () => {
  await resetFleet();
  const res = await call(req('POST', '/api/bot/radar-long-short', {
    workerId: 'long-short-1',
    snapshot: snapshot('btcusdt'),
  }));
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.stored, true);
  assert.equal(res.json.diagnostics.stored, 1);

  const fleet = await fleetStore.loadFleet();
  assert.equal(fleet.radarLongShortSnapshot.source, 'local_worker_radar_long_short');
  assert.equal(fleet.radarLongShortSnapshot.workerId, 'long-short-1');
  assert.deepEqual(Object.keys(fleet.radarLongShortSnapshot.symbols), ['BTCUSDT']);
  assert.equal(fleet.radarLongShortSnapshot.symbols.BTCUSDT.globalAccountRatio, 1.2);
  assert.equal(fleet.radarLongShortSnapshot.symbols.BTCUSDT.globalAccountRatioSeries, undefined);
});

test('immediate authorized GET sees stored snapshot', async () => {
  await resetFleet();
  await call(req('POST', '/api/bot/radar-long-short', {
    workerId: 'long-short-2',
    snapshot: snapshot('ETHUSDT'),
  }));
  const res = await call(req('GET', '/api/bot/radar-long-short'));
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.snapshot.workerId, 'long-short-2');
  assert.equal(res.json.snapshot.symbols.ETHUSDT.available, true);
});

test('malformed payload is fail-safe and route has no execution side effects', async () => {
  await resetFleet();
  const res = await call(req('POST', '/api/bot/radar-long-short', { workerId: 'long-short-3', nonsense: true }));
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.stored, false);

  const fleet = await fleetStore.loadFleet();
  assert.equal(fleet.radarLongShortSnapshot, null);
  assert.deepEqual(fleet.botSessions, {});
  assert.deepEqual(fleet.workerStatuses, {});
  assert.deepEqual(fleet.executionIntents, {});
  assert.deepEqual(fleet.executionResults, {});
  assert.deepEqual(fleet.positionResults, {});
  assert.deepEqual(fleet.commandQueue, {});
});

test('source guard: radar-long-short route has no Binance fetch or order/signed paths', () => {
  const source = readFileSync(new URL('../netlify/functions/bot.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("if (base === 'radar-long-short')");
  const end = source.indexOf("if (base === 'radar-klines')", start);
  assert.ok(start > 0, 'radar-long-short branch exists');
  assert.ok(end > start, 'radar-long-short branch is before radar-klines');
  const branch = source.slice(start, end);

  assert.doesNotMatch(branch, /fetch\s*\(/i);
  assert.doesNotMatch(branch, /\/fapi\/|\/dapi\/|\/sapi\/|\/futures\/data/i);
  assert.doesNotMatch(branch, /\/order|signature|apiKey|apiSecret|X-MBX-APIKEY/i);
  assert.doesNotMatch(branch, /execution-intent|worker-session|position-result|execution-result/i);
  assert.doesNotMatch(branch, /telegram/i);
});
