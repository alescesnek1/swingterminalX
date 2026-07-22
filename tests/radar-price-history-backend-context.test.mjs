import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  RADAR_PRICE_HISTORY_TOP_N,
  attachPriceHistoryContextsToRadarCandidates,
  buildPriceHistoryContext,
  loadPriceHistoryContextsForCandidates,
} from '../netlify/functions/_price-history-radar-context.mjs';

function points(prices, volumes = []) {
  return prices.map((price_usd, index) => ({
    symbol: 'BTC',
    sampled_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    price_usd,
    volume_24h_usd: volumes[index] ?? 100,
  }));
}

function candidate(symbol, extra = {}) {
  return {
    symbol,
    RECLAIM_STATUS: 'RECLAIM_NOT_STARTED',
    reclaimV2: { RECLAIM_STATUS: 'RECLAIM_NOT_STARTED' },
    STRICT_ABSORB_CONFIRMED: false,
    STATUS: 'WATCH',
    entryReadyV1: false,
    telegramEligible: false,
    ...extra,
  };
}

test('backend price-history context is attached only to the ranked top five candidates', async () => {
  const candidates = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT'].map(candidate);
  const calls = [];
  const contexts = await loadPriceHistoryContextsForCandidates(candidates, async (args) => {
    calls.push(args);
    return { ok: true, points: points([90, 95, 100, 98, 99, 100, 101, 102]) };
  });
  const radar = { candidates };
  attachPriceHistoryContextsToRadarCandidates(radar, contexts);

  assert.equal(calls.length, RADAR_PRICE_HISTORY_TOP_N);
  assert.deepEqual(calls.map((call) => call.symbol), ['BTC', 'ETH', 'SOL', 'XRP', 'ADA']);
  assert.equal(radar.candidates[0].priceHistoryContext.status, 'OK');
  assert.equal(radar.candidates[0].priceHistoryContext.reclaim.status, 'CONFIRMED');
  assert.equal(radar.candidates[0].priceHistoryContext.absorption.mode, 'history_only');
  assert.equal(Object.hasOwn(radar.candidates[5], 'priceHistoryContext'), false);
});

test('DB unavailable, no history, and insufficient history are explicit UNKNOWN contexts', () => {
  const unavailable = buildPriceHistoryContext('BTC', { ok: false, reason: 'DB_UNAVAILABLE' });
  const none = buildPriceHistoryContext('BTC', { ok: true, points: [] });
  const thin = buildPriceHistoryContext('BTC', { ok: true, points: points([100, 101]) });
  for (const context of [unavailable, none, thin]) {
    assert.ok(['DB_UNAVAILABLE', 'NO_HISTORY', 'INSUFFICIENT_HISTORY'].includes(context.status));
    assert.equal(context.reclaim.status, 'UNKNOWN');
    assert.equal(context.absorption.status, 'UNKNOWN');
    assert.equal(context.affectsServerGate, false);
    assert.equal(context.affectsTelegram, false);
  }
});

test('history-only absorption is confirmed only as a capped proxy and never overwrites RADAR gates', () => {
  const context = buildPriceHistoryContext('BTC', {
    ok: true,
    points: points([110, 108, 106, 104, 104, 104.2, 104.4, 104.6], [100, 100, 100, 100, 130, 130, 130, 130]),
  });
  const before = candidate('BTCUSDT', { telegramEligible: true, STATUS: 'STANDARD_ENTRY_READY', entryReadyV1: true });
  const radar = { candidates: [before] };
  attachPriceHistoryContextsToRadarCandidates(radar, new Map([['BTC', context]]));

  assert.equal(before.priceHistoryContext.absorption.status, 'CONFIRMED');
  assert.equal(before.priceHistoryContext.absorption.mode, 'history_only');
  assert.notEqual(before.priceHistoryContext.absorption.confidence, 'high');
  assert.equal(before.priceHistoryContext.affectsServerGate, false);
  assert.equal(before.priceHistoryContext.affectsTelegram, false);
  assert.equal(before.reclaimV2.RECLAIM_STATUS, 'RECLAIM_NOT_STARTED');
  assert.equal(before.STRICT_ABSORB_CONFIRMED, false);
  assert.equal(before.STATUS, 'STANDARD_ENTRY_READY');
  assert.equal(before.entryReadyV1, true);
  assert.equal(before.telegramEligible, true);
});

test('refresh enriches after evaluation and adapter has no orderbook, worker token, POST, or private Binance dependency', async () => {
  const [adapter, bot] = await Promise.all([
    readFile(new URL('../netlify/functions/_price-history-radar-context.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../netlify/functions/bot.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(adapter, /analyzeReclaimFromPoints/);
  assert.match(adapter, /analyzeAbsorptionFromPointsAndOrderbook/);
  assert.doesNotMatch(adapter, /orderbook-client|BOT_WORKER_TOKEN|fetch\(|\.post\(|\/fapi|\/dapi|\/sapi|\/order/i);
  const evaluatedAt = bot.indexOf('const radar = evaluateTradingRadar({');
  const enrichedAt = bot.indexOf('loadPriceHistoryContextsForCandidates(radar.candidates');
  assert.ok(evaluatedAt !== -1 && enrichedAt > evaluatedAt, 'context must be loaded after RADAR evaluation');
  assert.match(bot, /attachPriceHistoryContextsToRadarCandidates\(radar, priceHistoryContexts\)/);
});