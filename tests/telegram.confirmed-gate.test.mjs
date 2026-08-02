// Exhaustive confirmed-RADAR-ENTRY_READY Telegram gate matrix.
//
// Verifies that ONLY a fully confirmed RADAR ENTRY_READY success can produce a
// Telegram send, that everything else (scanner/score/pipeline states, missing
// data, non-SAFE safety, missing levels, stale, cooldown) sends 0, and that the
// system is fail-closed by default at the env layer.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  TELEGRAM_CODES,
  isConfirmedRadarEntryReady,
  evaluateConfirmedRadarEntryReady,
  normalizeRadarTelegramAlertState,
  selectRadarEntryAlerts,
  sendRadarEntryReadyTelegram,
  setupHash,
  runRadarTelegramAlertCycle as cronAlertsHandler,
} from '../netlify/functions/cron-alerts.mjs';
import legacyTelegram from '../netlify/functions/telegram.mjs';
import { mutateFleet } from '../netlify/functions/_fleet-store.mjs';

const NOW = new Date('2026-06-12T10:00:00Z').getTime();

function validEntry(overrides = {}) {
  return {
    symbol: 'SOLUSDT',
    STATUS: 'STANDARD_ENTRY_READY',
    stage: 'ENTRY_READY',
    actionability: 'ENTRY_READY',
    telegramEligible: true,
    allRadarConditionsPassed: true,
    safetyStatus: 'SAFE',
    entryType: 'RECLAIM_RETEST',
    ACTION: 'Enter standard position.',
    entryZone: { low: 139.5, high: 141.2 },
    invalidationLevel: 132.4,
    suggestedStop: 131.8,
    TAKE_PROFIT_LEVELS: [{ label: 'TP1', level: 152 }, { label: 'TP2', level: 160 }, { label: 'TP3', level: 172 }],
    tpZonesExist: true,
    executionDataMissing: [],
    SETUP_SCORE: 74,
    EXECUTION_SCORE: 70,
    RISK_REWARD_SCORE: 64,
    MARKET_REGIME_SCORE: 61,
    FINAL_CONFIDENCE: 82,
    confidence: 82,
    stale: false,
    reasons: ['reclaim retest held'],
    ...overrides,
  };
}

// Mimics the cron handler loop deterministically: returns how many sends fired.
async function sendCountFor(candidate, stateInput = {}) {
  const original = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => {
    sends += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: sends } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const state = normalizeRadarTelegramAlertState(stateInput);
    // Freshness stated explicitly: the selector fails closed when it is unknown,
    // and this helper is about the CONFIRMATION gate, not about staleness.
    const due = selectRadarEntryAlerts({ dataFreshnessMs: 30_000, entryReady: [candidate] }, state, NOW);
    for (const c of due) {
      // eslint-disable-next-line no-await-in-loop
      const res = await sendRadarEntryReadyTelegram(c, state, 'tok', 'chat', { now: NOW });
      if (res.ok) sends; // already counted by fetch stub
    }
    return sends;
  } finally {
    globalThis.fetch = original;
  }
}

// ── Forbidden scanner/score/pipeline statuses all send 0 ──
for (const status of ['BUY', 'FLUSH+BUY', 'STRONG BUY', 'RECLAIM', 'WATCH', 'NEAR_ENTRY', 'DISLOCATION_CONFIRMED', 'LONG_FLUSH_CONFIRMED', 'STABILIZING', 'SQUEEZE_CONFIRMED']) {
  test(`status ${status} sends 0`, async () => {
    assert.equal(isConfirmedRadarEntryReady(validEntry({ STATUS: status, stage: status })), false);
    assert.equal(await sendCountFor(validEntry({ STATUS: status, stage: status })), 0);
  });
}

test('ENTRY_READY but confidence < 75 sends 0', async () => {
  assert.equal(await sendCountFor(validEntry({ confidence: 74, FINAL_CONFIDENCE: 74 })), 0);
});

test('ENTRY_READY but execution score < 65 sends 0', async () => {
  const ev = evaluateConfirmedRadarEntryReady(validEntry({ EXECUTION_SCORE: 60 }));
  assert.equal(ev.ok, false);
  assert.equal(ev.reason, 'execution_below_65');
  assert.equal(await sendCountFor(validEntry({ EXECUTION_SCORE: 60 })), 0);
});

test('ENTRY_READY but setup score < 65 sends 0', async () => {
  assert.equal(await sendCountFor(validEntry({ SETUP_SCORE: 60 })), 0);
});

test('ENTRY_READY but risk/reward < 55 sends 0', async () => {
  assert.equal(await sendCountFor(validEntry({ RISK_REWARD_SCORE: 50 })), 0);
});

test('ENTRY_READY but market regime < 50 sends 0', async () => {
  assert.equal(await sendCountFor(validEntry({ MARKET_REGIME_SCORE: 40 })), 0);
});

for (const safety of ['UNKNOWN', 'CAUTION', 'DANGER']) {
  test(`ENTRY_READY but safety ${safety} sends 0`, async () => {
    const ev = evaluateConfirmedRadarEntryReady(validEntry({ safetyStatus: safety }));
    assert.equal(ev.ok, false);
    assert.equal(ev.code, TELEGRAM_CODES.SKIPPED_SAFETY_NOT_SAFE);
    assert.equal(await sendCountFor(validEntry({ safetyStatus: safety })), 0);
  });
}

test('ENTRY_READY but missing entryZone sends 0', async () => {
  assert.equal(await sendCountFor(validEntry({ entryZone: null })), 0);
});

test('ENTRY_READY but missing stop/invalidation sends 0', async () => {
  assert.equal(await sendCountFor(validEntry({ invalidationLevel: null, suggestedStop: null })), 0);
});

test('ENTRY_READY but missing TP zones sends 0', async () => {
  assert.equal(await sendCountFor(validEntry({ TAKE_PROFIT_LEVELS: [{ level: 152 }], tpZonesExist: false })), 0);
});

test('ENTRY_READY but missing microstructure sends 0', async () => {
  const ev = evaluateConfirmedRadarEntryReady(validEntry({ executionDataMissing: ['orderBookDepth', 'flow', 'derivatives'] }));
  assert.equal(ev.ok, false);
  assert.equal(ev.code, TELEGRAM_CODES.SKIPPED_MISSING_MICROSTRUCTURE);
  assert.equal(await sendCountFor(validEntry({ executionDataMissing: ['orderBookDepth', 'flow', 'derivatives'] })), 0);
});

test('ENTRY_READY but stale sends 0', async () => {
  assert.equal(await sendCountFor(validEntry({ stale: true })), 0);
  // radar-level staleness also blocks
  const due = selectRadarEntryAlerts({ entryReady: [validEntry()], status: 'STALE' }, normalizeRadarTelegramAlertState(), NOW);
  assert.equal(due.length, 0);
});

test('Valid confirmed RADAR ENTRY_READY sends exactly 1', async () => {
  assert.equal(isConfirmedRadarEntryReady(validEntry()), true);
  assert.equal(await sendCountFor(validEntry()), 1);
});

test('Duplicate valid setup sends 0 due to cooldown/dedupe', async () => {
  const state = { sent: { SOLUSDT: { lastSentAt: new Date(NOW - 5 * 60 * 1000).toISOString(), hash: setupHash(validEntry()) } } };
  assert.equal(await sendCountFor(validEntry(), state), 0);
});

test('Cockpit-style internal alert can never be telegram-confirmed', async () => {
  const cockpitAlert = {
    symbol: 'SOLUSDT', type: 'TP1_HIT', urgency: 'P3', status: 'TAKE_PROFIT',
    action: 'TAKE_PARTIAL', price: 140, reason: 'TP1 zone reached',
  };
  assert.equal(isConfirmedRadarEntryReady(cockpitAlert), false);
  assert.equal(await sendCountFor(cockpitAlert), 0);
});

test('Legacy /api/telegram returns 410', async () => {
  const res = await legacyTelegram({ method: 'POST' });
  assert.equal(res.status, 410);
});

test('Cockpit engine source never imports the Telegram API', () => {
  const cockpitSrc = fs.readFileSync(new URL('../scripts/cockpit/trade-cockpit.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(cockpitSrc, /api\.telegram\.org/i);
  assert.doesNotMatch(cockpitSrc, /sendMessage/);
});

// ── Env-layer fail-closed: even with a perfectly valid candidate in the
// fleet, the cron handler sends 0 unless RADAR_TELEGRAM_ENABLED==='true' AND
// credentials are present. ──
async function runHandlerWith(envPatch) {
  const keys = ['TELEGRAM_ENABLED', 'RADAR_TELEGRAM_ENABLED', 'CRON_ALERTS_ENABLED', 'TG_BOT_TOKEN', 'TG_CHAT_ID'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  const original = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => { sends += 1; return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    await mutateFleet((fleet) => {
      fleet.tradingRadar = {
        // The alert gate fails closed on unknown freshness, so a fixture about the
        // CONFIRMATION gate must state the freshness it assumes.
        dataFreshnessMs: 30_000,
        entryReady: [validEntry()],
        candidates: [validEntry()],
        telegramAlertState: normalizeRadarTelegramAlertState(),
      };
      return { ok: true };
    });
    Object.assign(process.env, envPatch);
    const result = await cronAlertsHandler();
    return { result, sends };
  } finally {
    globalThis.fetch = original;
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('Default env (nothing set) sends 0', async () => {
  const { result, sends } = await runHandlerWith({});
  assert.equal(sends, 0);
  assert.equal(result.sent, 0);
  assert.equal(result.code, TELEGRAM_CODES.DISABLED_BY_ENV);
});

test('RADAR_TELEGRAM_ENABLED=false sends 0', async () => {
  const { sends, result } = await runHandlerWith({ RADAR_TELEGRAM_ENABLED: 'false', TG_BOT_TOKEN: 't', TG_CHAT_ID: 'c' });
  assert.equal(sends, 0);
  assert.equal(result.code, TELEGRAM_CODES.DISABLED_BY_ENV);
});

test('Missing token sends 0', async () => {
  const { sends, result } = await runHandlerWith({ RADAR_TELEGRAM_ENABLED: 'true', TG_CHAT_ID: 'c' });
  assert.equal(sends, 0);
  assert.equal(result.code, TELEGRAM_CODES.MISSING_CREDENTIALS);
});

test('Missing chat id sends 0', async () => {
  const { sends, result } = await runHandlerWith({ RADAR_TELEGRAM_ENABLED: 'true', TG_BOT_TOKEN: 't' });
  assert.equal(sends, 0);
  assert.equal(result.code, TELEGRAM_CODES.MISSING_CREDENTIALS);
});

test('Fully enabled env + valid candidate sends exactly 1, then deduped to 0', async () => {
  const { sends, result } = await runHandlerWith({ RADAR_TELEGRAM_ENABLED: 'true', TG_BOT_TOKEN: 't', TG_CHAT_ID: 'c' });
  assert.equal(sends, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.selected, 'SOLUSDT');

  // Second run within cooldown (fleet persisted the sent record) → 0.
  const keys = ['TELEGRAM_ENABLED', 'RADAR_TELEGRAM_ENABLED', 'CRON_ALERTS_ENABLED', 'TG_BOT_TOKEN', 'TG_CHAT_ID'];
  const saved = {}; for (const k of keys) saved[k] = process.env[k];
  const original = globalThis.fetch; let sends2 = 0;
  globalThis.fetch = async () => { sends2 += 1; return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    process.env.RADAR_TELEGRAM_ENABLED = 'true'; process.env.TG_BOT_TOKEN = 't'; process.env.TG_CHAT_ID = 'c';
    delete process.env.TELEGRAM_ENABLED; delete process.env.CRON_ALERTS_ENABLED;
    const r2 = await cronAlertsHandler();
    assert.equal(sends2, 0);
    assert.equal(r2.sent, 0);
  } finally {
    globalThis.fetch = original;
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
