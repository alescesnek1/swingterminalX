import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  normalizeProducerOptions,
  resolveKlineSymbol,
  runKlinesProducer,
  selectKlineTargets,
} from '../scripts/radar/klines-producer.mjs';

const NOW = Date.now() - 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function kline(i) {
  const openTime = NOW - (10 - i) * HOUR;
  return [openTime, '100', '101', '99', String(100 + i), '1234', openTime + HOUR - 1];
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('symbol resolver rejects invalid symbols', () => {
  assert.equal(resolveKlineSymbol({ futures_pair: 'BEAT/USDT' }), null);
  assert.equal(resolveKlineSymbol({ futures_pair: 'BEAT-USDT' }), null);
  assert.equal(resolveKlineSymbol({ futures_pair: 'BEAT_USDT' }), null);
  assert.equal(resolveKlineSymbol({ futures_pair: 'THIS_SYMBOL_NAME_IS_WAY_TOO_LONGUSDT' }), null);
  assert.equal(resolveKlineSymbol(null), null);
});

test('alphaPair is never used as fapi symbol', () => {
  assert.equal(resolveKlineSymbol({ alphaPair: 'BEATUSDT' }), null);
  assert.equal(resolveKlineSymbol({ alphaPair: 'ALPHA_451/USDT', symbol: 'BEAT' }), null);
});

test('contractAddress and chain are ignored', () => {
  assert.equal(resolveKlineSymbol({ contractAddress: '0xBEEFUSDT', chain: 'BNBUSDT' }), null);
});

test('futures_pair wins when valid', () => {
  assert.equal(resolveKlineSymbol({ futures_pair: 'BEATUSDT', pair: 'SOLUSDT', symbol: 'ETHUSDT' }), 'BEATUSDT');
});

test('pair/symbol fallback only works for valid stable pair', () => {
  assert.equal(resolveKlineSymbol({ pair: 'SOLUSDT' }), 'SOLUSDT');
  assert.equal(resolveKlineSymbol({ symbol: 'BTCUSDC' }), 'BTCUSDC');
  assert.equal(resolveKlineSymbol({ pair: 'SOLBTC' }), null);
  assert.equal(resolveKlineSymbol({ symbol: 'BEAT' }), null);
});

test('topN and limit caps enforced', () => {
  assert.deepEqual(normalizeProducerOptions({ topN: 999, limit: 999, timeframe: '4h' }), {
    topN: 50,
    limit: 120,
    timeframe: '4h',
    baseUrl: 'https://fapi.binance.com',
  });
  assert.equal(selectKlineTargets(Array.from({ length: 60 }, (_, i) => ({ symbol: `S${i}USDT` })), { topN: 999 }).length, 50);
});

test('producer uses only public klines endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/fapi/v1/klines')) return response(200, [kline(1), kline(2), kline(3)]);
    if (String(url).endsWith('/api/bot/radar-klines')) return response(200, { ok: true, stored: true });
    throw new Error(`unexpected URL ${url}`);
  };

  await runKlinesProducer({
    fetchImpl,
    controlUrl: 'https://ctl.example',
    workerToken: 'secret-token',
    candidates: [{ futures_pair: 'BEATUSDT' }],
  });

  assert.ok(calls.some((c) => c.url.startsWith('https://fapi.binance.com/fapi/v1/klines?')));
  assert.ok(calls.some((c) => c.url === 'https://ctl.example/api/bot/radar-klines'));
  for (const c of calls) {
    assert.doesNotMatch(c.url, /signature|timestamp|apiKey|apiSecret/i);
    assert.doesNotMatch(c.url, /\/api\/v3\/order|\/fapi\/v1\/order|\/dapi\/|\/sapi\//i);
  }
});

test('producer contains no signed/order endpoint strings', () => {
  const source = readFileSync(new URL('../scripts/radar/klines-producer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /signature|apiKey|apiSecret|secretKey/i);
  assert.doesNotMatch(source, /\/api\/v3\/order|\/fapi\/v1\/order|\/dapi\/|\/sapi\//i);
});

test('no cron/workflow/config/package changes are introduced by producer source', () => {
  const source = readFileSync(new URL('../scripts/radar/klines-producer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /cron|schedule|scheduled|github|workflow|netlify\.toml|package\.json|package-lock/i);
});

test('token is never logged', () => {
  const source = readFileSync(new URL('../scripts/radar/klines-producer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /console\.(log|error|warn)\([^)]*workerToken/i);
  assert.doesNotMatch(source, /console\.(log|error|warn)\([^)]*BOT_WORKER_TOKEN/i);
});

test('successful run posts to radar-klines endpoint', async () => {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('/fapi/v1/klines')) return response(200, [kline(1), kline(2)]);
    if (String(url).endsWith('/api/bot/radar-klines')) {
      posts.push(JSON.parse(init.body));
      return response(200, { ok: true, stored: true });
    }
    return response(500, {});
  };

  const result = await runKlinesProducer({
    fetchImpl,
    controlUrl: 'https://ctl.example',
    workerToken: 'secret-token',
    workerId: 'producer-test',
    candidates: [{ futures_pair: 'BEATUSDT' }],
  });

  assert.equal(result.diagnostics.posted, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].workerId, 'producer-test');
  assert.equal(posts[0].snapshot.data.BEATUSDT.length, 2);
});

test('failed fetch does not crash entire run; reports diagnostics', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('BEATUSDT')) return response(451, { error: 'blocked' });
    if (String(url).includes('/fapi/v1/klines')) return response(200, [kline(1), kline(2)]);
    if (String(url).endsWith('/api/bot/radar-klines')) return response(200, { ok: true, stored: true });
    return response(500, {});
  };

  const result = await runKlinesProducer({
    fetchImpl,
    controlUrl: 'https://ctl.example',
    workerToken: 'secret-token',
    candidates: [{ futures_pair: 'BEATUSDT' }, { futures_pair: 'SOLUSDT' }],
  });

  assert.equal(result.diagnostics.attempted, 2);
  assert.equal(result.diagnostics.failed, 1);
  assert.equal(result.diagnostics.fetched, 1);
  assert.equal(result.snapshot.diagnostics.stored, 1);
  assert.equal(result.diagnostics.errors[0].symbol, 'BEATUSDT');
});

test('robust CLI guard is used instead of fragile import.meta.url', () => {
  const source = readFileSync(new URL('../scripts/radar/klines-producer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /import\.meta\.url\s*===\s*`file:\/\/\$\{process\.argv\[1\]\}`/);
  assert.match(source, /path\.resolve\(fileURLToPath\(import\.meta\.url\)\)/);
});