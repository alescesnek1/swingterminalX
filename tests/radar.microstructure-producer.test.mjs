import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main } from '../scripts/radar/radar-microstructure-producer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const producerPath = path.join(__dirname, '../scripts/radar/radar-microstructure-producer.mjs');

test('disabled exits without fetch/post', () => {
  const result = spawnSync('node', [producerPath], {
    env: { ...process.env, WORKER_RADAR_MICROSTRUCTURE_ENABLED: 'false' },
    encoding: 'utf8'
  });
  assert.ok(result.stdout.includes('WORKER_RADAR_MICROSTRUCTURE_ENABLED is not true. Exiting.'));
});

test('missing token fails closed', () => {
  const result = spawnSync('node', [producerPath], {
    env: { ...process.env, WORKER_RADAR_MICROSTRUCTURE_ENABLED: 'true', BOT_WORKER_TOKEN: '' },
    encoding: 'utf8'
  });
  assert.ok(result.stderr.includes('Missing BOT_WORKER_TOKEN.'));
  assert.strictEqual(result.status, 1);
});

test('missing base URL fails closed', () => {
  const result = spawnSync('node', [producerPath], {
    env: { ...process.env, WORKER_RADAR_MICROSTRUCTURE_ENABLED: 'true', BOT_WORKER_TOKEN: 'token', CONTROL_BASE_URL: '' },
    encoding: 'utf8'
  });
  assert.ok(result.stderr.includes('Missing CONTROL_BASE_URL or BOT_BASE_URL.'));
  assert.strictEqual(result.status, 1);
});

test('no order/signed endpoints imported', () => {
  const src = fs.readFileSync(producerPath, 'utf8');
  const forbidden = [/\/fapi\/v1\/order/, /\/dapi\//, /\/sapi\//, /futures\/order/i, /marginType/, /sideEffectType/, /\bleverage=/, /\/margin\/order/, /\/borrow/, /\/repay/, /\/withdraw/];
  for (const re of forbidden) {
    assert.doesNotMatch(src, re, `Must not import/use ${re}`);
  }
});

test('no ENTRY_READY/Telegram changes', () => {
  const src = fs.readFileSync(producerPath, 'utf8');
  assert.doesNotMatch(src, /ENTRY_READY/);
  assert.doesNotMatch(src, /Telegram/i);
});

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

test('candidates -> BEATUSDT map posts static fields', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
    const u = String(url);
    if (u.includes('/api/bot/radar-candidates')) {
      return jsonResponse({
        ok: true,
        radarCandidates: [{ pair: 'BEAT', futures_pair: 'BEATUSDT' }]
      });
    }
    if (u.includes('/fapi/v1/depth')) {
      return jsonResponse({
        bids: [['1.0', '100']],
        asks: [['1.01', '100']]
      });
    }
    if (u.includes('/fapi/v1/premiumIndex')) {
      return jsonResponse({ lastFundingRate: '0.0001' });
    }
    if (u.includes('/api/bot/radar-microstructure')) {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: true });
  };

  const oldEnv = { ...process.env };
  process.env.WORKER_RADAR_MICROSTRUCTURE_ENABLED = 'true';
  process.env.WORKER_RADAR_MICROSTRUCTURE_TOP_N = '5';
  process.env.BOT_WORKER_TOKEN = 'testtoken';
  process.env.CONTROL_BASE_URL = 'http://localhost';

  try {
    await main();
    
    // Check that we fetched candidates
    assert.ok(calls.some(c => c.url.includes('/api/bot/radar-candidates')));
    
    // Check that we posted microstructure
    const postCall = calls.find(c => c.url.includes('/api/bot/radar-microstructure'));
    assert.ok(postCall);
    assert.strictEqual(postCall.method, 'POST');
    
    const body = JSON.parse(postCall.body);
    assert.ok(body.data['BEATUSDT']);
    assert.strictEqual(body.data['BEATUSDT'].orderBookDepthWithin1Pct, 200);
    assert.strictEqual(body.data['BEATUSDT'].depthUsdWithin1Pct, 201);
    assert.strictEqual(body.data['BEATUSDT'].fundingRate, 0.0001);
    
  } finally {
    globalThis.fetch = realFetch;
    process.env = oldEnv;
  }
});
