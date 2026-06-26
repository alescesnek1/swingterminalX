import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildRollingSnapshotFromSamples,
  normalizeRollingProducerOptions,
  resolveRollingSymbol,
  runRollingMicrostructureProducer,
  selectRollingTargets,
} from '../scripts/radar/rolling-microstructure-producer.mjs';

function response(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function depth(total) { return { bids: [['1', String(total)]], asks: [['1.01', '1']] }; }
function trades() { return [{ p: '1', q: '60', m: false }, { p: '1', q: '40', m: true }]; }
function sample(symbol, d, oi, forceOrders = []) { return { symbol, depth: depth(d), openInterest: { openInterest: String(oi) }, trades: trades(), forceOrders, sampledAtMs: Date.now() }; }

test('invalid symbols rejected', () => {
  assert.equal(resolveRollingSymbol({ futures_pair: 'BTC-USDT' }), null);
  assert.equal(resolveRollingSymbol({ pair: 'BTC_ETH' }), null);
  assert.equal(resolveRollingSymbol({ symbol: 'BTC' }), null);
});

test('alphaPair/contractAddress/chain ignored', () => {
  assert.equal(resolveRollingSymbol({ alphaPair: 'BEATUSDT', contractAddress: 'BTCUSDT', chain: 'ETHUSDT' }), null);
});

test('topN caps enforced', () => {
  assert.equal(normalizeRollingProducerOptions({ topN: 999 }).topN, 50);
  assert.equal(selectRollingTargets(Array.from({ length: 60 }, (_, i) => ({ symbol: `S${i}USDT` })), { topN: 999 }).length, 50);
});

test('uses only public endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).includes('/fapi/v1/depth')) return response(200, depth(100));
    if (String(url).includes('/fapi/v1/aggTrades')) return response(200, trades());
    if (String(url).includes('/fapi/v1/openInterest')) return response(200, { openInterest: '1000' });
    if (String(url).includes('/fapi/v1/allForceOrders')) return response(200, []);
    if (String(url).endsWith('/api/bot/radar-rolling-microstructure')) return response(200, { ok: true, stored: true });
    return response(500, {});
  };
  await runRollingMicrostructureProducer({ fetchImpl, controlUrl: 'https://ctl.example', workerToken: 'secret-token', candidates: [{ futures_pair: 'BTCUSDT' }] });
  assert.ok(calls.some((u) => u.includes('/fapi/v1/depth')));
  assert.ok(calls.some((u) => u.includes('/fapi/v1/aggTrades')));
  assert.ok(calls.some((u) => u.includes('/fapi/v1/openInterest')));
  for (const url of calls) {
    assert.doesNotMatch(url, /signature|timestamp|apiKey|apiSecret/i);
    assert.doesNotMatch(url, /\/api\/v3\/order|\/fapi\/v1\/order|\/dapi\/|\/sapi\//i);
  }
});

test('contains no signed/order endpoint strings', () => {
  const source = readFileSync(new URL('../scripts/radar/rolling-microstructure-producer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /signature|apiKey|apiSecret|secretKey/i);
  assert.doesNotMatch(source, /\/api\/v3\/order|\/fapi\/v1\/order|\/dapi\/|\/sapi\//i);
});

test('token never logged', () => {
  const source = readFileSync(new URL('../scripts/radar/rolling-microstructure-producer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /console\.(log|error|warn)\([^)]*workerToken/i);
  assert.doesNotMatch(source, /console\.(log|error|warn)\([^)]*BOT_WORKER_TOKEN/i);
});

test('first single-sample run does not set trusted true', () => {
  const snap = buildRollingSnapshotFromSamples([sample('BTCUSDT', 100, 1000)]);
  assert.equal(snap.trusted, false);
  assert.ok(snap.data.BTCUSDT.missingFields.includes('bidDepthRebuildPct'));
  assert.ok(snap.data.BTCUSDT.missingFields.includes('openInterestChangePct'));
});

test('two-sample run can compute bidDepthRebuildPct/openInterestChangePct if inputs exist', () => {
  const first = buildRollingSnapshotFromSamples([sample('BTCUSDT', 100, 1000)]);
  const second = buildRollingSnapshotFromSamples([sample('BTCUSDT', 125, 900, [{}])], { previousSnapshot: first });
  assert.equal(Math.round(second.data.BTCUSDT.bidDepthRebuildPct), 25);
  assert.equal(Math.round(second.data.BTCUSDT.openInterestChangePct), -10);
});

test('missing liquidation data stays missing and diagnostics says why', () => {
  const first = buildRollingSnapshotFromSamples([sample('BTCUSDT', 100, 1000)]);
  const second = buildRollingSnapshotFromSamples([sample('BTCUSDT', 125, 900, [])], { previousSnapshot: first });
  assert.equal(second.data.BTCUSDT.longLiquidationSpike, undefined);
  assert.match(second.data.BTCUSDT.diagnostics.missingLongLiquidationSpike, /liquidation data/i);
});

test('no cron/workflow/config/package changes in source', () => {
  const source = readFileSync(new URL('../scripts/radar/rolling-microstructure-producer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /cron|schedule|scheduled|github|workflow|netlify\.toml|package\.json|package-lock/i);
});