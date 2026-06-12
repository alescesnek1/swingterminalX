import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const botSrc = fs.readFileSync(new URL('../netlify/functions/bot.mjs', import.meta.url), 'utf8');

test('UI renders Trading RADAR as an independent top-level panel, not inside Bot Feed', () => {
  assert.match(indexHtml, /onclick="sv\('radar',this\)"[^>]*>TRADING RADAR/);
  assert.match(indexHtml, /id="v-radar"/);
  assert.match(indexHtml, /id="trading-radar-root"/);
  assert.ok(indexHtml.indexOf('id="v-radar"') > indexHtml.indexOf('id="v-bot"'));
  const renderFleetBody = terminalJs.slice(terminalJs.indexOf('function renderFleet()'));
  assert.doesNotMatch(renderFleetBody, /_renderTradingRadar\(data\.tradingRadar/);
  assert.match(terminalJs, /function renderTradingRadarPanel\(\)/);
  assert.match(terminalJs, /activeViewName === 'radar'/);
  assert.match(terminalCss, /#v-radar\.on/);
});

test('UI renders the required Trading RADAR advisory sections', () => {
  assert.match(indexHtml, /TRADING RADAR/);
  assert.match(terminalJs, /ADVISORY ONLY/);
  assert.match(terminalJs, /Radar Matrix/);
  assert.match(terminalJs, /Focus Candidate/);
  assert.match(terminalJs, /What to watch now/);
  assert.match(terminalJs, /<details class="radar-diagnostics"/);
  assert.match(terminalJs, /data\.tradingRadar/);
  assert.match(terminalCss, /\.trading-radar/);
  assert.match(terminalCss, /\.radar-score--good/);
});

test('Trading RADAR backend is read-only and exposed through fleet state only', () => {
  assert.match(botSrc, /evaluateTradingRadar/);
  assert.match(botSrc, /tradingRadar: tradingRadarView/);
  assert.match(botSrc, /refreshTradingRadarFromFleet/);
  assert.doesNotMatch(botSrc, /tradingRadar[\s\S]{0,120}executionIntents\[/);
  assert.doesNotMatch(botSrc, /TRADING_RADAR[\s\S]{0,160}create-live-execution-intent/);
});
