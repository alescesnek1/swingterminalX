// Source guards for the Cockpit UX exposure layer (apps/edge/public).
// These prove the shipped frontend presents the active trade manager as a
// guided control center — onboarding cards, RADAR import, scanner tracking —
// and not a raw manual form, while keeping branding honest and Telegram off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { isTelegramHardDisabled } from '../netlify/functions/cron-alerts.mjs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');

test('shipped source contains the exact string "Import from Trading RADAR"', () => {
  // Required to exist in the shipped JS or HTML.
  assert.ok(
    indexHtml.includes('Import from Trading RADAR') || terminalJs.includes('Import from Trading RADAR'),
    'Import from Trading RADAR must be present in shipped HTML or JS',
  );
});

test('empty-state onboarding exposes the 3 primary action cards', () => {
  assert.match(indexHtml, /id="cockpit-onboarding"/);
  for (const label of ['Import from Trading RADAR', 'Track scanner coin', 'Manual position']) {
    assert.ok(indexHtml.includes(label), `${label} card missing`);
  }
  for (const kind of ['radar', 'scanner', 'manual']) {
    assert.match(indexHtml, new RegExp(`data-cp-onboard="${kind}"`));
  }
  // Each card explains what it does.
  assert.match(indexHtml, /cockpit-card-action__desc/);
});

test('manual form is secondary and collapsible (lives inside a <details>)', () => {
  assert.match(indexHtml, /<details[^>]*id="cockpit-add"/);
  assert.match(indexHtml, /class="cockpit-manual"/);
  // The form is nested under the collapsible add panel, not the dominant element.
  const addStart = indexHtml.indexOf('id="cockpit-add"');
  const formStart = indexHtml.indexOf('id="cockpit-form"');
  const addEnd = indexHtml.indexOf('</details>', addStart);
  assert.ok(addStart !== -1 && formStart > addStart && formStart < addEnd, 'cockpit-form must sit inside cockpit-add details');
  // Visible labels, not only placeholders.
  assert.match(indexHtml, /class="cockpit-label"/);
});

test('Import from Trading RADAR: no-candidate message + Open Trading RADAR action', () => {
  assert.ok(terminalJs.includes('No RADAR candidate selected. Go to Trading RADAR and click a candidate first.'));
  assert.match(terminalJs, /Open Trading RADAR/);
  assert.match(terminalJs, /cockpit-open-radar/);
  assert.match(terminalJs, /function _cpOpenTradingRadar/);
  assert.match(terminalJs, /sv\('radar'/);
});

test('Import from Trading RADAR: focused candidate preview + Import this RADAR setup action', () => {
  assert.match(terminalJs, /Import this RADAR setup/);
  assert.match(terminalJs, /cockpit-import-radar/);
  // Preview surfaces the full setup.
  for (const field of ['Entry zone', 'Suggested stop', 'Invalidation', 'TP1 / TP2 / TP3', 'Next trigger']) {
    assert.ok(terminalJs.includes(field), `RADAR preview missing ${field}`);
  }
  assert.match(terminalJs, /_cpPrefillFromRadar/);
});

test('Track scanner coin: search, live price, one-click track, visible not-found error', () => {
  assert.match(indexHtml, /id="cockpit-scanner-symbol"/);
  assert.match(indexHtml, /id="cockpit-scanner-track"/);
  assert.match(indexHtml, /id="cockpit-scanner-price"/);
  assert.match(indexHtml, /list="cockpit-symbol-list"/);
  assert.match(terminalJs, /function _cpUpdateScannerPrice/);
  assert.match(terminalJs, /function _cpTrackScannerSymbol/);
  assert.match(terminalJs, /not in the scanner universe/); // visible error, no silent failure
});

test('branding: TERMINAL_V7_LOADED removed, TERMINAL_X_LOADED present', () => {
  assert.doesNotMatch(terminalJs, /TERMINAL_V7_LOADED/);
  assert.match(terminalJs, /console\.log\('TERMINAL_X_LOADED'\)/);
});

test('active trade-manager markers remain present in the shipped JS', () => {
  for (const marker of ['TAKE_PARTIAL', 'TAKE_MORE', 'MOVE_STOP', 'PROTECT_PROFIT', 'NO_LIVE_PRICE', 'terminal_x_trade_cockpit_archive_v1']) {
    assert.ok(terminalJs.includes(marker), `active-manager marker ${marker} missing`);
  }
});

test('Telegram stays disabled / fail-closed (cockpit alerts never reach Telegram)', () => {
  // Cockpit internal alerts are UI/log only.
  assert.match(terminalJs, /never Telegram/);
  assert.doesNotMatch(terminalJs, /sendTelegram|api\.telegram\.org/);
  // Engine guard is fail-closed: off by default, and any kill switch overrides.
  assert.equal(isTelegramHardDisabled({}), true); // default off
  assert.equal(isTelegramHardDisabled({ TELEGRAM_ENABLED: 'false', RADAR_TELEGRAM_ENABLED: 'true' }), true); // kill switch wins
  assert.equal(isTelegramHardDisabled({ RADAR_TELEGRAM_ENABLED: 'false' }), true); // explicit disable
});
