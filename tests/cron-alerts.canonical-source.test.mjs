import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeCanonicalRadarForAlerts,
  loadCanonicalRadarForAlerts,
  selectRadarEntryAlerts,
  CANONICAL_RADAR_STALE_MS,
  RADAR_STALE_MS,
} from '../netlify/functions/cron-alerts.mjs';

const NOW = Date.parse('2026-07-26T18:00:00.000Z');

function candidateRow(symbol, status = 'STANDARD_ENTRY_READY') {
  return {
    market: 'spot', symbol,
    payload: {
      symbol, market: 'spot', STATUS: status, FINAL_CONFIDENCE: 80,
      entryZone: { low: 1, high: 2 }, suggestedStop: 0.9, tpZonesExist: true,
      SETUP_SCORE: 75, EXECUTION_SCORE: 70, RISK_REWARD_SCORE: 60, MARKET_REGIME_SCORE: 65,
      allRadarConditionsPassed: true, safetyStatus: 'SAFE',
      // The full gate set is deliberately strict; a canonical candidate has to
      // satisfy exactly the same bar as a Fleet one.
      actionability: 'ENTRY_READY', telegramEligible: true, executionDataMissing: [],
    },
  };
}

test('the stored canonical radar is shaped into the alert contract', () => {
  const shaped = shapeCanonicalRadarForAlerts({
    status: 'ready', computedAt: new Date(NOW - 60_000).toISOString(),
    candidates: [candidateRow('BTCUSDT'), candidateRow('ETHUSDT', 'WATCH')],
  }, NOW);
  assert.equal(shaped.status, 'READY');
  assert.equal(shaped.source, 'canonical_context');
  assert.equal(shaped.dataFreshnessMs, 60_000);
  assert.equal(shaped.candidates.length, 2);
  assert.equal(shaped.entryReady.length, 1, 'only entry-ready statuses are promoted');
  assert.equal(shaped.entryReady[0].symbol, 'BTCUSDT');
});

// The publisher republishes once per 3-minute collector cycle, so the browser-feed
// threshold would call the canonical radar stale exactly when it is fresh.
test('the canonical freshness bound accommodates the collector cadence', () => {
  assert.ok(CANONICAL_RADAR_STALE_MS > RADAR_STALE_MS);
  assert.ok(CANONICAL_RADAR_STALE_MS >= 2 * 3 * 60 * 1000, 'at least two collector cycles');
});

test('a radar older than the bound is refused, not alerted on', async () => {
  const store = { getPublishedRadar: async () => ({ ok: true, radar: { status: 'ready', computedAt: new Date(NOW - CANONICAL_RADAR_STALE_MS - 1000).toISOString(), candidates: [candidateRow('BTCUSDT')] } }) };
  const res = await loadCanonicalRadarForAlerts({ store, database: {}, nowMs: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'RADAR_STALE');
});

test('a pending radar is refused rather than treated as empty', async () => {
  const store = { getPublishedRadar: async () => ({ ok: true, radar: { status: 'PENDING', candidates: [] } }) };
  const res = await loadCanonicalRadarForAlerts({ store, database: {}, nowMs: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'RADAR_PENDING');
});

test('a database failure is refused, never silently downgraded', async () => {
  const store = { getPublishedRadar: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }) };
  const res = await loadCanonicalRadarForAlerts({ store, database: {}, nowMs: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'DB_UNAVAILABLE');
});

test('a fresh canonical radar still passes through every existing entry gate', async () => {
  const store = { getPublishedRadar: async () => ({ ok: true, radar: { status: 'ready', computedAt: new Date(NOW - 60_000).toISOString(), candidates: [candidateRow('BTCUSDT'), candidateRow('SOLUSDT', 'WATCH')] } }) };
  const res = await loadCanonicalRadarForAlerts({ store, database: {}, nowMs: NOW });
  assert.equal(res.ok, true);
  const selected = selectRadarEntryAlerts(res.radar, {}, NOW);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].symbol, 'BTCUSDT');
  // A WATCH candidate can never be selected, whatever the source.
  assert.ok(!selected.some((c) => c.symbol === 'SOLUSDT'));
});

// Regression: the scheduled function resolved to a plain object, which Netlify v2
// rejects ("Function returned an unsupported value") AFTER the cycle had already
// run — and then retried the invocation. Observed live: three invocations in five
// seconds for one tick. With Telegram enabled those are duplicate-send attempts.
test('the scheduled entry point resolves to a Response, so Netlify never retries a completed cycle', async () => {
  const handler = (await import('../netlify/functions/cron-alerts.mjs')).default;
  const original = process.env.RADAR_TELEGRAM_ENABLED;
  process.env.RADAR_TELEGRAM_ENABLED = 'false';
  const warn = console.warn; console.warn = () => {};
  try {
    const res = await handler();
    assert.ok(res instanceof Response, 'must be a Response');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.sent, 0);
  } finally {
    console.warn = warn;
    if (original === undefined) delete process.env.RADAR_TELEGRAM_ENABLED; else process.env.RADAR_TELEGRAM_ENABLED = original;
  }
});
