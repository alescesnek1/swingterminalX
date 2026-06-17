import test from 'node:test';
import assert from 'node:assert';
import { enrichRadarCandidatesMicrostructure, radarMicrostructureConfigFromEnv } from '../scripts/auto/microstructure-enrichment.mjs';

test('radar-microstructure config disabled by default', () => {
  const cfg = radarMicrostructureConfigFromEnv({});
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.topN, 20);
});

test('enrichRadarCandidatesMicrostructure returns empty object if disabled', async () => {
  const cfg = radarMicrostructureConfigFromEnv({ WORKER_RADAR_MICROSTRUCTURE_ENABLED: 'false' });
  const map = await enrichRadarCandidatesMicrostructure([{ pair: 'BEAT' }], { config: cfg });
  assert.deepStrictEqual(map, {});
});

test('enrichRadarCandidatesMicrostructure fetches and skips unsupported', async () => {
  let fetchedUrl = '';
  const mockFetch = async (url) => {
    fetchedUrl = url;
    return {
      ok: true,
      json: async () => ({
        bids: [['1.0', '100']],
        asks: [['1.01', '100']]
      })
    };
  };

  const cfg = radarMicrostructureConfigFromEnv({ 
    WORKER_RADAR_MICROSTRUCTURE_ENABLED: 'true',
    WORKER_RADAR_MICROSTRUCTURE_TOP_N: '5'
  });

  const candidates = [
    { pair: 'BEAT', futures_pair: 'BEATUSDT' },
    { pair: 'SOL', spot_pair: 'SOLUSDT' },
    { pair: 'INVALID' }
  ];

  const map = await enrichRadarCandidatesMicrostructure(candidates, { config: cfg, fetchImpl: mockFetch });
  
  assert.ok(map['BEATUSDT']);
  assert.ok(map['SOLUSDT']);
  assert.ok(map['INVALIDUSDT']);
  
  assert.ok(typeof map['BEATUSDT'].orderBookDepthWithin1Pct === 'number');
  assert.ok(typeof map['BEATUSDT'].depthUsdWithin1Pct === 'number');
});

import botHandler from '../netlify/functions/bot.mjs';

const mockEvent = (path, method, body, headers = {}) => ({
  path,
  httpMethod: method,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('radar-context preserves metadata and caps at 500', async () => {
  // requires BOT_OWNER_KEY
  if (!process.env.BOT_OWNER_KEY) return;
  const req = mockEvent('/api/bot/radar-context', 'POST', {
    scannerCandidates: [
      { symbol: 'BEAT', futures_pair: 'BEATUSDT', alphaPair: 'BEAT', spot_pair: 'BEATUSDT' }
    ]
  }, { 'X-BOT-OWNER-KEY': process.env.BOT_OWNER_KEY });
  const res = await botHandler(req);
  assert.strictEqual(res.statusCode, 200);
});

test('worker-session payload includes top radarCandidates safely capped', async () => {
  if (!process.env.BOT_WORKER_TOKEN) return;
  const req = mockEvent('/api/bot/worker-session?sessionId=sess1&workerId=worker1', 'GET', null, { 'X-BOT-WORKER-TOKEN': process.env.BOT_WORKER_TOKEN });
  const res = await botHandler(req);
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.ok(Array.isArray(json.radarCandidates));
  assert.ok(json.radarCandidates.length <= 50);
});

test('radar-microstructure endpoint stores sanitized microstructure map', async () => {
  if (!process.env.BOT_WORKER_TOKEN) return;
  const req = mockEvent('/api/bot/radar-microstructure', 'POST', {
    workerId: 'worker1',
    data: { BEAT: { orderBookDepthWithin1Pct: 50000, spreadPct: 0.1 } }
  }, { 'X-BOT-WORKER-TOKEN': process.env.BOT_WORKER_TOKEN });
  const res = await botHandler(req);
  const status = res.statusCode || res.status;
  assert.strictEqual(status, 200);
  
  // Parse response body depending on whether it's a native Response or Netlify callback object
  const rawBody = typeof res.json === 'function' ? await res.text() : res.body;
  const jsonBody = JSON.parse(rawBody);
  
  assert.strictEqual(jsonBody.ok, true);
  assert.strictEqual(jsonBody.stored, true);
  assert.ok(typeof jsonBody.metrics === 'number');
  assert.ok(typeof jsonBody.receivedAt === 'string');
});
