import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertKuCoinPublicCandleUrl, buildKuCoinHistoricalDataset, fetchKuCoinPublicCandles, normalizeKuCoinCandleRow, parseKuCoinUtcDate } from '../scripts/radar/kucoin-public-candles.mjs';
import { validateHistoricalMarketDataset } from '../scripts/radar/historical-data-contract.mjs';

const fromMs = parseKuCoinUtcDate('2024-01-01');
const toMs = parseKuCoinUtcDate('2024-01-02');
const row = (seconds, close = '141') => [String(seconds), '140', '145', '135', close, '10', '1400'];

test('only the exact KuCoin public HTTPS candle endpoint is allowed', () => {
  assert.equal(assertKuCoinPublicCandleUrl('https://api.kucoin.com/api/ua/v1/market/kline').hostname, 'api.kucoin.com');
  for (const value of ['http://api.kucoin.com/api/ua/v1/market/kline', 'https://api.kucoin.com.evil.example/api/ua/v1/market/kline', 'https://evil.example@api.kucoin.com/api/ua/v1/market/kline', 'file:///api/ua/v1/market/kline']) assert.throws(() => assertKuCoinPublicCandleUrl(value), /untrusted_kucoin_public_url/);
});

test('public candle requests are bounded GETs without authentication and normalize deterministically', async () => {
  const seen = [];
  const result = await fetchKuCoinPublicCandles({ product: 'spot', symbol: 'BTC-USDT', quote: 'USDT', interval: '1hour', fromMs, toMs, now: () => new Date('2026-07-24T12:00:00.000Z'), fetchImpl: async (url, options) => { seen.push({ url: new URL(url), options }); return { ok: true, status: 200, json: async () => ({ code: '200000', data: { list: [row(fromMs / 1000 + 3600), row(fromMs / 1000)] } }) }; } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url.hostname, 'api.kucoin.com');
  assert.equal(seen[0].url.searchParams.get('tradeType'), 'SPOT');
  assert.equal(seen[0].options.method, 'GET');
  assert.deepEqual(seen[0].options.headers, { Accept: 'application/json' });
  assert.equal(result.dataset.candles[0].openTime, '2024-01-01T00:00:00.000Z');
  assert.equal(result.dataset.candles[0].high, 145);
  assert.equal(result.dataset.provenance.sourceUrl, 'https://api.kucoin.com/api/ua/v1/market/kline');
});

test('invalid rows fail closed and source gaps remain visible to the historical contract', () => {
  assert.throws(() => normalizeKuCoinCandleRow(['bad'], 3600000), /invalid_kucoin_candle_row/);
  const dataset = buildKuCoinHistoricalDataset({ symbol: 'BTC-USDT', quote: 'USDT', interval: '1hour', fromMs, toMs, fetchedAt: '2026-07-24T12:00:00.000Z', rows: [row(fromMs / 1000), row(fromMs / 1000 + 7200)] });
  assert.equal(dataset.gaps.length, 1);
  assert.ok(validateHistoricalMarketDataset(dataset).reasonCodes.includes('candle_gap'));
});

test('public candles module contains no auth or private client behavior', () => {
  const source = fs.readFileSync(new URL('../scripts/radar/kucoin-public-candles.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /authorization|api[-_]?key|secret|private.*(?:account|order)|telegram|worker/i);
  assert.match(source, /https:\/\/api\.kucoin\.com\/api\/ua\/v1\/market\/kline/);
});
