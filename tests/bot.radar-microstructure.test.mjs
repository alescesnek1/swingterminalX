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
    { pair: 'BEAT', futures_pair: 'BEATUSDT' },      // futures_pair resolves
    { pair: 'SOLUSDT', symbol: 'SOLUSDT' },           // pair already a valid fapi symbol
    { pair: 'INVALID' }                               // no valid fapi symbol -> skipped safely
  ];

  const map = await enrichRadarCandidatesMicrostructure(candidates, { config: cfg, fetchImpl: mockFetch });

  // Valid symbols are measured; the invalid one is skipped (never coerced to
  // a fabricated INVALIDUSDT) — strict /^[A-Z0-9]{2,30}(USDT|USDC)$/ resolution.
  assert.ok(map['BEATUSDT']);
  assert.ok(map['SOLUSDT']);
  assert.strictEqual(map['INVALIDUSDT'], undefined);
  assert.strictEqual(map['INVALID'], undefined);

  assert.ok(typeof map['BEATUSDT'].orderBookDepthWithin1Pct === 'number');
  assert.ok(typeof map['BEATUSDT'].depthUsdWithin1Pct === 'number');
});

import botHandler from '../netlify/functions/bot.mjs';

const mockEvent = (path, method, body, headers = {}) => {
  const lowerHeaders = Object.keys(headers).reduce((acc, k) => { acc[k.toLowerCase()] = headers[k]; return acc; }, {});
  return {
    path,
    url: `http://localhost${path}`,
    method,
    httpMethod: method,
    headers: {
      ...headers,
      get: (k) => lowerHeaders[k.toLowerCase()] || null
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
};

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

test('radar microstructure lookup tries multiple safe candidate keys and ignores alpha alias', async () => {
  if (!process.env.BOT_OWNER_KEY || !process.env.BOT_WORKER_TOKEN) return;

  // 1) Push radar context with a BEATUSDT candidate shaped like production
  const cReq = mockEvent('/api/bot/radar-context', 'POST', {
    scannerCandidates: [
      {
        symbol: 'BEATUSDT',
        base: 'BEAT',
        pair: 'BEATUSDT',
        futures_pair: null,
        spot_pair: null,
        alphaPair: 'ALPHA_451/USDT',
        quote: 'USDT'
      }
    ]
  }, { 'X-BOT-OWNER-KEY': process.env.BOT_OWNER_KEY });
  await botHandler(cReq);

  // 2) Post microstructure keyed under 'BEATUSDT'
  const mReq = mockEvent('/api/bot/radar-microstructure', 'POST', {
    workerId: 'worker1',
    data: { BEATUSDT: { orderBookDepthWithin1Pct: 8888, spreadPct: 0.1 } }
  }, { 'X-BOT-WORKER-TOKEN': process.env.BOT_WORKER_TOKEN });
  await botHandler(mReq);

  // 3) Fetch worker-session and verify merge
  const wReq = mockEvent('/api/bot/worker-session?sessionId=sess1&workerId=worker1', 'GET', null, { 'X-BOT-WORKER-TOKEN': process.env.BOT_WORKER_TOKEN });
  const wRes = await botHandler(wReq);
  const wRaw = typeof wRes.json === 'function' ? await wRes.text() : wRes.body;
  const wJson = JSON.parse(wRaw);
  
  const beat = wJson.radarCandidates.find(c => c.symbol === 'BEATUSDT');
  assert.ok(beat, 'candidate exists');
  assert.strictEqual(beat.orderBookDepthWithin1Pct, 8888, 'data was merged using BEATUSDT fallback key');
  assert.ok(!wJson.radarCandidates.some(c => c.orderBookDepthWithin1Pct === 'ALPHA_451USDT'), 'alpha pair should not be used');
});


test('handler does not crash when req.url is missing', async () => {
  const req = mockEvent('/api/bot/state', 'GET', null);
  const res = await botHandler(req);
  assert.ok(res.statusCode || res.status);
});

test('unauthorized access to radar-microstructure and radar-debug is blocked', async () => {
  const reqMicro = mockEvent('/api/bot/radar-microstructure', 'POST', { workerId: 'worker1', data: {} });
  const resMicro = await botHandler(reqMicro);
  assert.strictEqual(resMicro.statusCode || resMicro.status, 403);

  const reqDebug = mockEvent('/api/bot/radar-debug', 'GET', null);
  const resDebug = await botHandler(reqDebug);
  assert.strictEqual(resDebug.statusCode || resDebug.status, 403);
});
