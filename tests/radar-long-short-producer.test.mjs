import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  normalizeLongShortProducerOptions,
  resolveLongShortSymbol,
  runLongShortProducer,
  selectLongShortTargets,
} from '../scripts/radar/long-short-producer.mjs';

const NOW = 1_700_000_000_000;
const FRESH = NOW - 60_000;

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function ratioRow(symbol, ratio, ts = FRESH) {
  return { symbol, longShortRatio: String(ratio), timestamp: String(ts) };
}

function takerRow(symbol, ratio, ts = FRESH) {
  return { symbol, buySellRatio: String(ratio), timestamp: String(ts) };
}

test('producer options hard-cap topN at 20, default limit at 2, and allowlist periods', () => {
  assert.deepEqual(normalizeLongShortProducerOptions({ topN: 999, limit: 999, period: '2h' }), {
    topN: 20,
    limit: 2,
    period: '5m',
    baseUrl: 'https://fapi.binance.com',
  });
  assert.equal(normalizeLongShortProducerOptions({ period: '15m' }).period, '15m');
  assert.equal(selectLongShortTargets(Array.from({ length: 30 }, (_, i) => ({ symbol: `S${i}USDT` })), { topN: 999 }).length, 20);
});

test('symbol resolver mirrors rolling stable futures symbol parsing', () => {
  assert.equal(resolveLongShortSymbol({ futures_pair: 'BEATUSDT', pair: 'SOLUSDT' }), 'BEATUSDT');
  assert.equal(resolveLongShortSymbol({ futuresPair: 'BTCUSDC' }), 'BTCUSDC');
  assert.equal(resolveLongShortSymbol({ pair: 'SOLUSDT' }), 'SOLUSDT');
  assert.equal(resolveLongShortSymbol({ symbol: 'ETHUSDT' }), 'ETHUSDT');
  assert.equal(resolveLongShortSymbol({ symbol: 'ETHBTC' }), null);
  assert.equal(resolveLongShortSymbol({ alphaPair: 'BEATUSDT' }), null);
});

test('producer fetches only approved futures-data endpoints and posts compact snapshot', async () => {
  const calls = [];
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.includes('/futures/data/topLongShortPositionRatio')) return response(200, [ratioRow('BEATUSDT', 1.8)]);
    if (u.includes('/futures/data/globalLongShortAccountRatio')) return response(200, [ratioRow('BEATUSDT', 1.2)]);
    if (u.includes('/futures/data/takerlongshortRatio')) return response(200, [takerRow('BEATUSDT', 0.9)]);
    if (u.endsWith('/api/bot/radar-long-short')) {
      posts.push(JSON.parse(init.body));
      return response(200, { ok: true, stored: true });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await runLongShortProducer({
    fetchImpl,
    controlUrl: 'https://ctl.example',
    workerToken: 'secret-token',
    workerId: 'ls-test',
    candidates: [{ futures_pair: 'BEATUSDT' }],
    nowMs: NOW,
  });

  assert.equal(result.diagnostics.posted, true);
  assert.equal(result.snapshot.symbols.BEATUSDT.available, true);
  assert.equal(result.snapshot.symbols.BEATUSDT.globalAccountRatio, 1.2);
  assert.equal(result.snapshot.symbols.BEATUSDT.topTraderPositionRatio, 1.8);
  assert.equal(result.snapshot.symbols.BEATUSDT.takerBuySellRatio, 0.9);
  assert.equal(posts[0].workerId, 'ls-test');
  assert.equal(posts[0].snapshot.contextOnly, true);
  assert.equal(posts[0].snapshot.symbols.BEATUSDT.globalAccountRatio, 1.2);
  assert.equal(posts[0].snapshot.symbols.BEATUSDT.globalAccountRatioSeries, undefined);

  const endpointCalls = calls.filter((c) => c.url.startsWith('https://fapi.binance.com/'));
  assert.equal(endpointCalls.length, 3);
  for (const c of endpointCalls) {
    assert.match(c.url, /\/futures\/data\/(topLongShortPositionRatio|globalLongShortAccountRatio|takerlongshortRatio)\?/);
    assert.match(c.url, /symbol=BEATUSDT/);
    assert.match(c.url, /period=5m/);
    assert.match(c.url, /limit=2/);
    assert.doesNotMatch(c.url, /signature|timestamp|apiKey|apiSecret|\/order|\/sapi|\/dapi/i);
  }
});

test('partial endpoint failure is honest unavailable or missing without raw dumps', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/futures/data/topLongShortPositionRatio')) return response(451, { error: 'blocked' });
    if (u.includes('/futures/data/globalLongShortAccountRatio')) return response(451, { error: 'blocked' });
    if (u.includes('/futures/data/takerlongshortRatio')) return response(200, []);
    if (u.endsWith('/api/bot/radar-long-short')) return response(200, { ok: true, stored: true });
    return response(500, {});
  };
  const result = await runLongShortProducer({
    fetchImpl,
    controlUrl: 'https://ctl.example',
    workerToken: 'secret-token',
    candidates: [{ symbol: 'SOLUSDT' }],
    nowMs: NOW,
  });
  const row = result.snapshot.symbols.SOLUSDT;
  assert.equal(row.available, false);
  assert.equal(row.interpretation, 'unavailable');
  assert.ok(row.missing.includes('globalAccountRatio'));
  assert.ok(row.missing.includes('topTraderPositionRatio'));
  assert.equal(JSON.stringify(result.snapshot).includes('blocked'), false);
  assert.equal(result.diagnostics.errors.length, 2);
});

test('producer source guard: no signed/order/serverless/browser/telegram/execution references', () => {
  const source = readFileSync(new URL('../scripts/radar/long-short-producer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Coinee|liquidation heatmap|CVD|whale orders|confirmed liquidation|guaranteed absorption|retail sentiment truth/i);
  assert.doesNotMatch(source, /signature|apiKey|apiSecret|secretKey|X-MBX-APIKEY/i);
  assert.doesNotMatch(source, /\/order|\/sapi|\/dapi/i);
  assert.doesNotMatch(source, /telegram|execution|ENTRY_READY/i);
  assert.doesNotMatch(source, /window\.fetch|document\.|netlify\/functions/i);
});
