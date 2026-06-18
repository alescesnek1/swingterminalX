// Regression: RADAR microstructure POST must PERSIST so an immediate GET (and
// radar-debug) see the same data.
//
// The original bug: bot.mjs POST stored `fleet.radarMicrostructureSnapshot` and
// the response reported metrics:1 (read from the just-mutated in-memory object),
// but `normalize()` in _fleet-store.mjs only preserves keys declared in
// emptyFleet(). radarMicrostructureSnapshot was NOT declared there, so the very
// next load STRIPPED it -> GET returned metrics:0, keys:[]. radar-debug also
// returned 403 because it was not in FLEET_WORKER_BASES (browser auth gate).
//
// This test drives the real handler with real Web Request objects against the
// in-memory fleet backend, so it reproduces the persistence path end to end.
// Run: `npm test` (or `node --test tests/bot.radar-microstructure-persistence.test.mjs`).
import test from 'node:test';
import assert from 'node:assert/strict';

// Must be set BEFORE importing the handler-adjacent modules so checkWorkerToken
// has a non-empty expected token. Kept local to this file (node --test runs each
// test file in its own process).
process.env.BOT_WORKER_TOKEN = 'test-worker-token-persistence';
const TOKEN = process.env.BOT_WORKER_TOKEN;

const botHandler = (await import('../netlify/functions/bot.mjs')).default;
const { evaluateTradingRadar } = await import('../scripts/radar/trading-radar.mjs');

const BASE = 'https://swingterminalx.netlify.app/api/bot';

function workerReq(path, { method = 'GET', body = null } = {}) {
  const headers = { 'x-bot-worker-token': TOKEN };
  const init = { method, headers };
  if (body != null) {
    headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request(`${BASE}/${path}`, init);
}

async function asJson(res) {
  const status = res.status;
  const json = JSON.parse(await res.text());
  return { status, json };
}

const BEAT_MICRO = {
  orderBookDepthWithin1Pct: 84389,
  depthUsdWithin1Pct: 146225.7167,
  spreadPct: 0.05777,
  fundingRate: -0.00024028,
};

test('POST radar-microstructure persists BEATUSDT and an immediate GET sees it', async () => {
  // 1) POST the exact production payload.
  const post = await asJson(await botHandler(workerReq('radar-microstructure', {
    method: 'POST',
    body: { workerId: 'worker-persist-test', data: { BEATUSDT: BEAT_MICRO } },
  })));
  assert.equal(post.status, 200, 'POST status');
  assert.equal(post.json.ok, true);
  assert.equal(post.json.stored, true);
  assert.equal(post.json.metrics, 1, 'POST reports metrics from the persisted field');
  assert.ok(Array.isArray(post.json.keys) && post.json.keys.includes('BEATUSDT'), 'POST keys include BEATUSDT');
  assert.equal(post.json.hasBEATUSDT, true);

  // 2) Immediate GET must see the SAME persisted data (this is what regressed).
  const get = await asJson(await botHandler(workerReq('radar-microstructure', { method: 'GET' })));
  assert.equal(get.status, 200, 'GET status');
  assert.equal(get.json.ok, true);
  assert.equal(get.json.metrics, 1, 'GET metrics must be 1 after POST (persistence)');
  assert.ok(get.json.keys.includes('BEATUSDT'), 'GET keys include BEATUSDT');
  assert.equal(get.json.hasBEATUSDT, true, 'GET hasBEATUSDT must be true');
  assert.ok(get.json.beat && get.json.beat.depthUsdWithin1Pct === BEAT_MICRO.depthUsdWithin1Pct, 'GET returns sanitized BEAT data');
});

test('GET radar-debug?symbol=BEATUSDT is worker-token protected (200) and reports the micro key', async () => {
  // Seed the snapshot first.
  await botHandler(workerReq('radar-microstructure', {
    method: 'POST',
    body: { workerId: 'worker-persist-test', data: { BEATUSDT: BEAT_MICRO } },
  }));

  // With the worker token, radar-debug must be 200 (was 403 before the fix).
  const dbg = await asJson(await botHandler(workerReq('radar-debug?symbol=BEATUSDT', { method: 'GET' })));
  assert.equal(dbg.status, 200, 'radar-debug must be 200 with worker token');
  assert.equal(dbg.json.ok, true);
  assert.ok(Array.isArray(dbg.json.rawMicroKeys) && dbg.json.rawMicroKeys.includes('BEATUSDT'),
    'radar-debug rawMicroKeys must include BEATUSDT');
});

test('radar-debug rejects requests without the worker token (not browser-gated)', async () => {
  const res = await botHandler(new Request(`${BASE}/radar-debug?symbol=BEATUSDT`, { method: 'GET' }));
  // Worker-base gate returns 403 (Forbidden) when the token is missing/invalid.
  assert.equal(res.status, 403, 'no token => 403');
});

// ── Static-only microstructure must NOT unlock Absorb / ENTRY_READY / Telegram ──
// A BEATUSDT-shaped candidate carrying ONLY static depth/spread/funding (exactly
// what the read-only producer posts) reports hasStaticMicrostructure:true but is
// still blocked on the rolling absorption fields.
const NOW = new Date('2026-06-18T10:00:00Z').getTime();
const BTC = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70007, spreadPct: 0.01, change24hPct: 1.2 };
const ETH = { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 600e6, bidPrice: 3600, askPrice: 3601, spreadPct: 0.03, change24hPct: 0.8 };
const BEAT_STATIC_ONLY = {
  symbol: 'BEATUSDT', baseAsset: 'BEAT', quoteAsset: 'USDT', status: 'TRADING',
  quoteVolume24h: 250e6, bidPrice: 100, askPrice: 100.06, spreadPct: 0.05777,
  change24hPct: -9.5, volumeSpike: 2.4, atrPct: 4,
  orderBookDepthWithin1Pct: 84389, depthUsdWithin1Pct: 146225.7167, depthUsd: 146225.7167,
  fundingRate: -0.00024028,
};

test('static-only BEATUSDT: hasStaticMicrostructure true, but Absorb/ENTRY_READY/Telegram stay blocked', () => {
  const state = evaluateTradingRadar({ markets: [BTC, ETH, BEAT_STATIC_ONLY], source: 'test', now: NOW });
  const c = state.candidates.find((x) => x.symbol === 'BEATUSDT');
  assert.ok(c, 'BEATUSDT candidate present');
  assert.equal(c.hasStaticMicrostructure, true, 'static depth/spread/funding present');
  assert.equal(c.hasRollingMicrostructure, false, 'no rolling absorption data');
  assert.notEqual((c.conditionChecklist.absorption || {}).status, 'PASS', 'static fields cannot pass absorption');
  assert.notEqual(c.actionability, 'ENTRY_READY', 'never ENTRY_READY from static-only data');
  assert.equal(c.telegramEligible, false, 'never Telegram-eligible from static-only data');
});
