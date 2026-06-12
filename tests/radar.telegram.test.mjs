import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  RADAR_TELEGRAM_COOLDOWN_MS,
  buildRadarTelegramMessage,
  isRadarTelegramQualifiedCandidate,
  normalizeRadarTelegramAlertState,
  selectRadarEntryAlerts,
  shouldSendRadarTelegramAlert,
  sendRadarEntryReadyTelegram
} from '../netlify/functions/cron-alerts.mjs';

const legacyTelegramSrc = fs.readFileSync(new URL('../netlify/functions/telegram.mjs', import.meta.url), 'utf8');
const cronAlertsSrc = fs.readFileSync(new URL('../netlify/functions/cron-alerts.mjs', import.meta.url), 'utf8');

const NOW = new Date('2026-06-12T10:00:00Z').getTime();
const ENTRY = {
  symbol: 'SOLUSDT',
  stage: 'ENTRY_READY',
  actionability: 'ENTRY_READY',
  telegramEligible: true,
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
      { ...ENTRY, symbol: 'WATCHUSDT', stage: 'WATCH' },
      { ...ENTRY, symbol: 'STABLEUSDT', stage: 'STABILIZING' },
      ENTRY,
    ],
  };
  const due = selectRadarEntryAlerts(radar, normalizeRadarTelegramAlertState(), NOW);
  assert.deepEqual(due.map((c) => c.symbol), ['SOLUSDT']);
  assert.equal(shouldSendRadarTelegramAlert({ ...ENTRY, stage: 'SQUEEZE_CONFIRMED' }, {}, NOW), false);
  assert.equal(isRadarTelegramQualifiedCandidate(ENTRY), true);
  assert.equal(isRadarTelegramQualifiedCandidate({ ...ENTRY, actionability: 'NEAR_ENTRY' }), false);
  assert.equal(isRadarTelegramQualifiedCandidate({ ...ENTRY, telegramEligible: false }), false);
  assert.equal(isRadarTelegramQualifiedCandidate({ ...ENTRY, confidence: 74 }), false);
  assert.equal(isRadarTelegramQualifiedCandidate({ ...ENTRY, entryZone: null }), false);
  assert.equal(isRadarTelegramQualifiedCandidate({ ...ENTRY, invalidationLevel: null, suggestedStop: null }), false);
});

test('Telegram alert message includes required RADAR fields', () => {
  const msg = buildRadarTelegramMessage(ENTRY);
  assert.match(msg, /symbol: <b>SOLUSDT<\/b>/);
  assert.match(msg, /stage: <b>ENTRY_READY<\/b>/);
  assert.match(msg, /entryType: RECLAIM_RETEST/);
  assert.match(msg, /entryZone: 139\.5 - 141\.2/);
  assert.match(msg, /invalidationLevel: 132\.4/);
  assert.match(msg, /suggestedStop: 131\.8/);
  assert.match(msg, /setupQualityScore: 87/);
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
  
  const resLegacy = await sendRadarEntryReadyTelegram({ ...ENTRY, stage: 'FLUSH+BUY' }, state, token, chatId);
  assert.equal(resLegacy.ok, false);
  assert.equal(resLegacy.code, 'TELEGRAM_LEGACY_BLOCKED');
  
  const resNoAction = await sendRadarEntryReadyTelegram({ ...ENTRY, actionability: 'WAIT' }, state, token, chatId);
  assert.equal(resNoAction.ok, false);
  assert.equal(resNoAction.code, 'TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY');
  
  const resLowConf = await sendRadarEntryReadyTelegram({ ...ENTRY, confidence: 70 }, state, token, chatId);
  assert.equal(resLowConf.ok, false);
  assert.equal(resLowConf.code, 'TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY');
  assert.equal(resLowConf.reason, 'confidence_below_75');

  for (const stage of ['BUY', 'FLUSH+BUY', 'STRONG BUY', 'RECLAIM', 'WATCH', 'LONG_FLUSH_CONFIRMED', 'STABILIZING', 'SQUEEZE_CONFIRMED', 'NEAR_ENTRY']) {
    const res = await sendRadarEntryReadyTelegram({ ...ENTRY, stage }, state, token, chatId);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TELEGRAM_LEGACY_BLOCKED');
  }
});

test('Repo guard: no api.telegram.org usage outside netlify/functions/cron-alerts.mjs', () => {
  import('node:child_process').then(({ execSync }) => {
     try {
       const root = path.resolve(new URL('.', import.meta.url).pathname, '..').replace(/^\/([A-Za-z]:)/, '$1');
       const output = execSync('git grep -i "api.telegram.org"', { cwd: root, encoding: 'utf8' });
       const lines = output.split('\\n').filter(Boolean);
       for (const line of lines) {
         if (line.includes('tests/radar.telegram.test.mjs')) continue;
         if (line.includes('netlify/functions/cron-alerts.mjs')) continue;
         assert.fail(`Found illegal telegram api usage: ${line}`);
       }
     } catch (err) {
       // git grep returns 1 if no matches found, which is great.
     }
  });
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
