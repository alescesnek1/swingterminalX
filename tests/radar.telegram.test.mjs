import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  RADAR_TELEGRAM_COOLDOWN_MS,
  buildRadarTelegramMessage,
  normalizeRadarTelegramAlertState,
  selectRadarEntryAlerts,
  shouldSendRadarTelegramAlert,
} from '../netlify/functions/cron-alerts.mjs';

const legacyTelegramSrc = fs.readFileSync(new URL('../netlify/functions/telegram.mjs', import.meta.url), 'utf8');
const cronAlertsSrc = fs.readFileSync(new URL('../netlify/functions/cron-alerts.mjs', import.meta.url), 'utf8');

const NOW = new Date('2026-06-12T10:00:00Z').getTime();
const ENTRY = {
  symbol: 'SOLUSDT',
  stage: 'ENTRY_READY',
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
  assert.equal(selectRadarEntryAlerts({ entryReady: [ENTRY] }, state, NOW).length, 0);
});

test('Legacy Telegram relay and old scanner alert code are disabled', () => {
  assert.match(legacyTelegramSrc, /status: 410/);
  assert.match(legacyTelegramSrc, /Legacy Telegram relay disabled/);
  assert.doesNotMatch(cronAlertsSrc, /fetchTop500|CoinGecko|FLUSH\+BUY|STRONG BUY|Cron Scanner/);
});
