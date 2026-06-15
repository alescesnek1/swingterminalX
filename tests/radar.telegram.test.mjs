import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RADAR_TELEGRAM_COOLDOWN_MS,
  buildRadarTelegramMessage,
  isTelegramHardDisabled,
  isRadarTelegramQualifiedCandidate,
  normalizeRadarTelegramAlertState,
  radarConditionsPassed,
  selectRadarEntryAlerts,
  shouldSendRadarTelegramAlert,
  sendRadarEntryReadyTelegram,
  default as cronAlertsHandler
} from '../netlify/functions/cron-alerts.mjs';
import { mutateFleet } from '../netlify/functions/_fleet-store.mjs';

const legacyTelegramSrc = fs.readFileSync(new URL('../netlify/functions/telegram.mjs', import.meta.url), 'utf8');
const cronAlertsSrc = fs.readFileSync(new URL('../netlify/functions/cron-alerts.mjs', import.meta.url), 'utf8');

const NOW = new Date('2026-06-12T10:00:00Z').getTime();
const ENTRY = {
  symbol: 'SOLUSDT',
  STATUS: 'STANDARD_ENTRY_READY',
  stage: 'ENTRY_READY',
  actionability: 'ENTRY_READY',
  telegramEligible: true,
  safetyStatus: 'SAFE',
  entryType: 'RECLAIM_RETEST',
  entryZone: { low: 139.5, high: 141.2 },
  invalidationLevel: 132.4,
  suggestedStop: 131.8,
  setupQualityScore: 87,
  confidence: 82,
  reasons: ['panic selling/long flush confirmed', 'new lows paused and local range formed', 'reclaim retest held with regime not breaking down'],
  riskFlags: ['spread above ideal'],
};

test('Telegram selector sends only confirmed RADAR ENTRY_READY candidates', () => {
  const radar = {
    entryReady: [
      { ...ENTRY, symbol: 'WATCHUSDT', STATUS: 'WATCH', stage: 'WATCH' },
      { ...ENTRY, symbol: 'STABLEUSDT', STATUS: 'STABILIZING', stage: 'STABILIZING' },
      ENTRY,
    ],
  };
  const due = selectRadarEntryAlerts(radar, normalizeRadarTelegramAlertState(), NOW);
  assert.deepEqual(due.map((c) => c.symbol), ['SOLUSDT']);
  assert.equal(shouldSendRadarTelegramAlert({ ...ENTRY, STATUS: 'SQUEEZE_CONFIRMED', stage: 'SQUEEZE_CONFIRMED' }, {}, NOW), false);
  assert.equal(isRadarTelegramQualifiedCandidate(ENTRY), true);
  assert.equal(isRadarTelegramQualifiedCandidate({ ...ENTRY, actionability: 'NEAR_ENTRY' }), false);
  assert.equal(isRadarTelegramQualifiedCandidate({ ...ENTRY, telegramEligible: false }), false);
  assert.equal(isRadarTelegramQualifiedCandidate({ ...ENTRY, confidence: 74 }), false);
  assert.equal(isRadarTelegramQualifiedCandidate({ ...ENTRY, entryZone: null }), false);
  assert.equal(isRadarTelegramQualifiedCandidate({ ...ENTRY, invalidationLevel: null, suggestedStop: null }), false);
  assert.equal(isRadarTelegramQualifiedCandidate({ ...ENTRY, allRadarConditionsPassed: false }), false);
  assert.equal(isRadarTelegramQualifiedCandidate({ ...ENTRY, conditions: [{ passed: true }, { passed: false }] }), false);
  assert.equal(radarConditionsPassed({ ...ENTRY, conditions: [{ passed: true }, { ok: true }, { status: 'PASSED' }] }), true);
});

test('Telegram alert message includes required RADAR fields', () => {
  const msg = buildRadarTelegramMessage(ENTRY);
  assert.match(msg, /symbol: <b>SOLUSDT<\/b>/);
  assert.match(msg, /status: <b>STANDARD_ENTRY_READY<\/b>/);
  assert.match(msg, /entryType: RECLAIM_RETEST/);
  assert.match(msg, /entryZone: 139\.5 - 141\.2/);
  assert.match(msg, /invalidationLevel: 132\.4/);
  assert.match(msg, /suggestedStop: 131\.8/);
  assert.match(msg, /setupScore: 87/);
  assert.match(msg, /confidence: 82/);
  assert.match(msg, /top 3 reasons:/);
  assert.match(msg, /risk flags: spread above ideal/);
  assert.match(msg, /time validity:/);
});

test('Telegram alert dedupe and cooldown suppress repeat ENTRY_READY spam', () => {
  const state = normalizeRadarTelegramAlertState({
    sent: {
      SOLUSDT: { lastSentAt: new Date(NOW - 10 * 60 * 1000).toISOString() },
    },
  });
  assert.equal(shouldSendRadarTelegramAlert(ENTRY, state, NOW), false);
  assert.equal(shouldSendRadarTelegramAlert(ENTRY, state, NOW + RADAR_TELEGRAM_COOLDOWN_MS + 1), true);
  const due = selectRadarEntryAlerts({ entryReady: [ENTRY] }, state, NOW);
  assert.equal(due.length, 0);
});

test('Legacy Telegram relay and old scanner alert code are disabled', () => {
  assert.match(legacyTelegramSrc, /status: 410/);
  assert.match(legacyTelegramSrc, /Legacy Telegram relay disabled/);
  assert.doesNotMatch(cronAlertsSrc, /fetchTop500|CoinGecko|Cron Scanner/);
});

test('sendRadarEntryReadyTelegram blocks legacy and unqualified candidates', async () => {
  const state = normalizeRadarTelegramAlertState();
  const token = 'fake';
  const chatId = 'fake';
  
  const resLegacy = await sendRadarEntryReadyTelegram({ ...ENTRY, STATUS: 'FLUSH+BUY', stage: 'FLUSH+BUY' }, state, token, chatId);
  assert.equal(resLegacy.ok, false);
  assert.equal(resLegacy.code, 'TELEGRAM_LEGACY_BLOCKED');
  
  const resNoAction = await sendRadarEntryReadyTelegram({ ...ENTRY, actionability: 'WAIT' }, state, token, chatId);
  assert.equal(resNoAction.ok, false);
  assert.equal(resNoAction.code, 'TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY');
  
  const resLowConf = await sendRadarEntryReadyTelegram({ ...ENTRY, confidence: 70 }, state, token, chatId);
  assert.equal(resLowConf.ok, false);
  assert.equal(resLowConf.code, 'TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY');
  assert.equal(resLowConf.reason, 'confidence_below_75');

  const resNoZone = await sendRadarEntryReadyTelegram({ ...ENTRY, entryZone: null }, state, token, chatId);
  assert.equal(resNoZone.ok, false);
  assert.equal(resNoZone.reason, 'missing_entry_zone');

  const resNoStop = await sendRadarEntryReadyTelegram({ ...ENTRY, invalidationLevel: null, suggestedStop: null }, state, token, chatId);
  assert.equal(resNoStop.ok, false);
  assert.equal(resNoStop.reason, 'missing_stop_invalidation');

  const resConditionsFailed = await sendRadarEntryReadyTelegram({ ...ENTRY, allConditionsPassed: false }, state, token, chatId);
  assert.equal(resConditionsFailed.ok, false);
  assert.equal(resConditionsFailed.reason, 'radar_conditions_not_passed');

  for (const stage of ['BUY', 'FLUSH+BUY', 'STRONG BUY', 'RECLAIM', 'WATCH', 'LONG_FLUSH_CONFIRMED', 'STABILIZING', 'SQUEEZE_CONFIRMED', 'NEAR_ENTRY']) {
    const res = await sendRadarEntryReadyTelegram({ ...ENTRY, STATUS: stage, stage }, state, token, chatId);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TELEGRAM_LEGACY_BLOCKED');
  }
});

test('Valid ENTRY_READY sends exactly once and duplicate is deduped', async () => {
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => {
    sends += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: sends } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const state = normalizeRadarTelegramAlertState();
    const sent = await sendRadarEntryReadyTelegram(ENTRY, state, 'fake-token', 'fake-chat');
    assert.equal(sent.ok, true);
    assert.equal(sent.code, 'TELEGRAM_RADAR_SENT');
    assert.equal(sends, 1);

    const duplicateState = normalizeRadarTelegramAlertState({
      sent: { SOLUSDT: { lastSentAt: new Date().toISOString() } },
    });
    const duplicate = await sendRadarEntryReadyTelegram(ENTRY, duplicateState, 'fake-token', 'fake-chat');
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.reason, 'cooldown_active');
    assert.equal(sends, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cron with no valid ENTRY_READY returns ok with sent 0', async () => {
  await mutateFleet((fleet) => {
    fleet.tradingRadar = {
      ...(fleet.tradingRadar || {}),
      entryReady: [{ ...ENTRY, STATUS: 'WATCH', stage: 'WATCH' }],
      candidates: [{ ...ENTRY, STATUS: 'STABILIZING', stage: 'STABILIZING' }],
      telegramAlertState: normalizeRadarTelegramAlertState(),
    };
    return { ok: true };
  });

  process.env.TG_BOT_TOKEN = 'fake-token';
  process.env.TG_CHAT_ID = 'fake-chat';
  delete process.env.TELEGRAM_ENABLED;
  process.env.RADAR_TELEGRAM_ENABLED = 'true';
  delete process.env.CRON_ALERTS_ENABLED;

  const result = await cronAlertsHandler();
  assert.equal(result.ok, true);
  assert.equal(result.sent, 0);
  assert.equal(result.reason, 'no_entry_ready_due');
});

test('Env hard-kill disables Telegram fail-closed', () => {
  assert.equal(isTelegramHardDisabled({ TELEGRAM_ENABLED: 'false' }), true);
  assert.equal(isTelegramHardDisabled({ RADAR_TELEGRAM_ENABLED: 'false' }), true);
  assert.equal(isTelegramHardDisabled({ CRON_ALERTS_ENABLED: 'false' }), true);
  assert.equal(isTelegramHardDisabled({ TELEGRAM_ENABLED: 'true' }), true);
  assert.equal(isTelegramHardDisabled({ RADAR_TELEGRAM_ENABLED: 'true' }), false);
});

test('Repo guard: no api.telegram.org usage outside netlify/functions/cron-alerts.mjs', () => {
  const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
  const hits = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', '.netlify', 'node_modules'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!/\.(mjs|js|cjs|ts|json|toml|env|md|ya?ml)$/i.test(entry.name) && !entry.name.startsWith('.env')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (text.toLowerCase().includes('api.telegram.org')) hits.push(full);
    }
  };
  scan(root);
  for (const hit of hits) {
    const normalized = hit.split(path.sep).join('/');
    if (normalized.endsWith('tests/radar.telegram.test.mjs')) continue;
    if (normalized.endsWith('netlify/functions/cron-alerts.mjs')) continue;
    assert.fail(`Found illegal telegram api usage: ${hit}`);
  }
});

test('RADAR Context respects 500 row payload limit and maps detected fields', async () => {
  process.env.AUTH_DECODE_ONLY = 'true';
  const { mutateFleet } = await import('../netlify/functions/_fleet-store.mjs');
  const handleBotApi = (await import('../netlify/functions/bot.mjs')).default;
  
  const oversizedPayload = Array.from({ length: 600 }, (_, i) => ({ symbol: `COIN${i}USDT`, price: 1 }));
  const reqTooLarge = {
    method: 'POST',
    url: 'http://localhost/api/bot/radar-context',
    headers: { get: (k) => k === 'authorization' ? 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ.' : 'http://localhost' },
    text: async () => JSON.stringify({ scannerCandidates: oversizedPayload }),
    json: async () => ({ scannerCandidates: oversizedPayload })
  };
  const resTooLarge = await handleBotApi(reqTooLarge);
  assert.equal(resTooLarge.status, 400);

  const exactPayload = Array.from({ length: 500 }, (_, i) => ({ symbol: `COIN${i}USDT`, price: 1 }));
  const reqOk = {
    method: 'POST',
    url: 'http://localhost/api/bot/radar-context',
    headers: { get: (k) => k === 'authorization' ? 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ.' : 'http://localhost' },
    text: async () => JSON.stringify({
      scannerCandidates: exactPayload, 
      fieldMappingDetected: ['symbol:pair', 'price:current_price', 'score:_sig_score', 'h24:_c24'],
      scannerRowsAvailable: 1000,
      scannerRowsSent: 500
    }),
    json: async () => ({ 
      scannerCandidates: exactPayload, 
      fieldMappingDetected: ['symbol:pair', 'price:current_price', 'score:_sig_score', 'h24:_c24'],
      scannerRowsAvailable: 1000,
      scannerRowsSent: 500
    })
  };
  const resOk = await handleBotApi(reqOk);
  assert.equal(resOk.status, 200);
  const bodyOk = await resOk.json();
  assert.equal(bodyOk.stored, 500);

  let storedFleet;
  await mutateFleet(async (f) => { storedFleet = f; });
  assert.equal(storedFleet.radarContext.scannerCandidates.length, 500);
  assert.deepEqual(storedFleet.radarContext.fieldMappingDetected, ['symbol:pair', 'price:current_price', 'score:_sig_score', 'h24:_c24']);
  assert.equal(storedFleet.radarContext.scannerRowsAvailable, 1000);
  assert.equal(storedFleet.radarContext.scannerRowsSent, 500);
  assert.equal(storedFleet.radarContext.scannerRowsReceived, 500);
  assert.equal(storedFleet.radarContext.scannerRowsSanitized, 500);
  assert.equal(storedFleet.radarContext.scannerRowsRejected, 0);
});
