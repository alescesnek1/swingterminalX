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

test('Trading RADAR frontend sends 500 scanner rows with detected field mapping', () => {
  assert.match(terminalJs, /DATA\.slice\(0, 500\)/);
  assert.match(terminalJs, /_radarDetectScannerFields/);
  assert.match(terminalJs, /scannerRowsAvailable: DATA\.length/);
  assert.match(terminalJs, /scannerRowsSent: payload\.length/);
  assert.match(terminalJs, /symbol\/base\/pair/);
  assert.match(terminalJs, /h24/);
  assert.match(terminalJs, /volume/);
});

test('Trading RADAR UI defaults to top 20 and exposes working filter chips', () => {
  assert.match(terminalJs, /window\._radarFilter \|\| 'TOP_20'/);
  assert.match(terminalJs, /rowsToRender\.slice\(0, 20\)/);
  assert.match(terminalJs, /filterButton\('NEEDS_ABSORPTION'/);
  assert.match(terminalJs, /filterButton\('NEEDS_RECLAIM'/);
  assert.match(terminalJs, /filterButton\('REJECTED'/);
  assert.match(terminalJs, /activeFilter === 'REJECTED'/);
  assert.match(terminalCss, /\.radar-filter-chip/);
  assert.match(terminalCss, /\.radar-limit-select/);
});

test('Trading RADAR focus panel surfaces microstructure blocking diagnostics', () => {
  // Static vs rolling readiness + explicit blocked reasons in the focus card.
  assert.match(terminalJs, /radar-microstructure/);
  assert.match(terminalJs, /Microstructure readiness/);
  assert.match(terminalJs, /Static \(depth\/spread\/funding\)/);
  assert.match(terminalJs, /Rolling absorption data/);
  // The absorb-block reason is now provider-aware via the _fleetRadarMicroDiag
  // helper (prefers the untrusted-provider wording over the evaluator reason).
  assert.match(terminalJs, /_fleetRadarMicroDiag/);
  assert.match(terminalJs, /no trusted microstructure provider \/ stale static cache/);
  assert.match(terminalJs, /stale diagnostic cache/);
  assert.match(terminalJs, /c\.absorptionBlockedReason/);
  assert.match(terminalJs, /selected\.reclaimBlockedReason/);
  assert.match(terminalJs, /selected\.missingAbsorptionFields/);
  assert.match(terminalJs, /selected\.missingReclaimFields/);
  // Worker-level sidecar state in the diagnostics list.
  assert.match(terminalJs, /radar\.microstructureDiagnostics/);
  assert.match(terminalJs, /Microstructure: /);
  assert.match(terminalCss, /\.radar-microstructure/);
});

test('Trading RADAR UI surfaces V1 status/action and structured output fields', () => {
  assert.match(terminalJs, /function _fleetRadarV1Status\(c\)/);
  assert.match(terminalJs, /function _fleetRadarV1BlockedBy\(c\)/);
  assert.match(terminalJs, /const v1Status = _fleetRadarV1Status\(c\)/);
  assert.match(terminalJs, /const v1Action = _fleetRadarV1Action\(c\)/);
  assert.match(terminalJs, /_fleetRadarBadgeClass\(v1Status\)/);
  assert.match(terminalJs, /const selectedV1Status = _fleetRadarV1Status\(selected\)/);
  assert.match(terminalJs, /<span>Status<\/span><b>\$\{esc\(selectedV1Status\)/);
  assert.match(terminalJs, /<span>Action<\/span><b>\$\{esc\(_fleetRadarV1Action\(selected\)\)/);
  assert.match(terminalJs, /<span>Entry type<\/span><b>\$\{esc\(selected\.ENTRY_TYPE/);
  assert.match(terminalJs, /POSITION_SIZE_GUIDANCE/);
  assert.match(terminalJs, /<span>Hard invalidation<\/span>/);
  assert.match(terminalJs, /<span>Timeframe<\/span><b>\$\{esc\(selected\.TIMEFRAME_CONTEXT/);
  assert.match(terminalJs, /<span>Time validity<\/span><b>\$\{esc\(selected\.TIME_VALIDITY/);
  assert.match(terminalJs, /<span>Reason<\/span><b>\$\{esc\(\(selected\.REASON/);
  assert.match(terminalJs, /<span>Invalidation<\/span><b>\$\{esc\(selected\.INVALIDATION/);
  assert.match(terminalJs, /selected\.missingData \|\| selected\.missingSignals/);
});

test('Trading RADAR diagnostics and matrix expose coverage counts and readable states', () => {
  assert.match(terminalJs, /Scanner Rows Available/);
  assert.match(terminalJs, /Scanner Rows Sent/);
  assert.match(terminalJs, /Scanner Rows Sanitized/);
  assert.match(terminalJs, /Radar Rows Evaluated/);
  assert.match(terminalJs, /Detected scanner fields/);
  assert.match(terminalJs, /radar-telegram-ready/);
  assert.match(terminalJs, /radar-telegram-no/);
  assert.match(terminalJs, /Current market blocker/);
  assert.match(terminalJs, /_fleetRadarV1BlockedBy\(watchNowCandidates\[0\]\)/);
  assert.doesNotMatch(terminalJs, /watchNowCandidates\[0\]\.blockedBy/);
});


test('Matrix Status column correctly prioritizes v1Status over status (fallback WATCH)', () => {
  const match = terminalJs.match(/function _fleetRadarV1Status\(c\) \{([\s\S]*?)\}/);
  assert.ok(match, '_fleetRadarV1Status must be defined');
  const helper = new Function('c', match[1]);
  assert.equal(helper({ v1Status: 'DISLOCATION_CONFIRMED', status: 'WATCH' }), 'DISLOCATION_CONFIRMED');
  assert.equal(helper({}), 'WATCH');
});
