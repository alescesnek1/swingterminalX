// Source guards for the PRODUCTION frontend cockpit (apps/edge/public/js/terminal.js).
// The browser cockpit mirrors scripts/cockpit/trade-cockpit.mjs. These guards prove
// the deployed code is an active trade manager (not a dumb form) and stays honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');

test('frontend cockpit does not fabricate microstructure and never falls back to entry price', () => {
  assert.doesNotMatch(terminalJs, /_cpNum\(row\.spreadPct,\s*0\.06\)/);
  assert.doesNotMatch(terminalJs, /_cpNum\(row\.bidDepthRebuildPct,\s*8\)/);
  assert.doesNotMatch(terminalJs, /marketBuyVolumeDominance,\s*0\.52\)/);
  assert.doesNotMatch(terminalJs, /_cpNum\(market\.currentPrice,\s*entry\)/);
  assert.match(terminalJs, /const current = _cpNum\(market\.currentPrice\);/);
  assert.match(terminalJs, /NO_LIVE_PRICE/);
  assert.match(terminalJs, /not in scanner universe/);
});

test('frontend cockpit computes mini-scores only when present and flags low-confidence', () => {
  assert.match(terminalJs, /_cpPresent\(/);
  assert.match(terminalJs, /momentumPresent/);
  assert.match(terminalJs, /bookPresent/);
  assert.match(terminalJs, /flowPresent/);
  assert.match(terminalJs, /derivPresent/);
  assert.match(terminalJs, /lowConfidence/);
  assert.match(terminalJs, /missingComponents/);
  assert.match(terminalJs, /val == null \? 'N\/A'/);
  assert.match(terminalJs, /LOW-CONF/);
  assert.match(terminalCss, /\.cockpit-score\.na/);
});

test('frontend cockpit is an active manager: TP-state, partials, action verbs', () => {
  assert.match(terminalJs, /_cpTpHits/);
  assert.match(terminalJs, /tpHits/);
  assert.match(terminalJs, /_cpRealized/);
  assert.match(terminalJs, /partials/);
  // action verb vocabulary
  for (const v of ['TAKE_PARTIAL', 'TAKE_MORE', 'MOVE_STOP', 'PROTECT_PROFIT', 'REDUCE_RISK', 'INCOMPLETE_SETUP']) {
    assert.match(terminalJs, new RegExp(v));
  }
  assert.match(terminalJs, /suggestedStop/);
  assert.match(terminalJs, /data-cp-tp/); // manual mark TP taken
  assert.match(terminalJs, /data-cp-movestop/);
});

test('frontend cockpit imports focused RADAR candidate and auto-fills the form', () => {
  assert.match(terminalJs, /_cpRadarFocus/);
  assert.match(terminalJs, /_cpPrefillFromRadar/);
  assert.match(terminalJs, /cockpit-import-radar/);
  assert.match(indexHtml, /id="cockpit-radar-focus"/);
});

test('frontend cockpit has guided creation: autocomplete, live price preview, visible validation', () => {
  assert.match(indexHtml, /id="cockpit-symbol-list"/);
  assert.match(indexHtml, /list="cockpit-symbol-list"/);
  assert.match(indexHtml, /id="cockpit-price-preview"/);
  assert.match(indexHtml, /id="cockpit-form-error"/);
  assert.match(terminalJs, /_cpShowError/);
  assert.match(terminalJs, /_cpUpdatePricePreview/);
  // validation must surface errors, not fail silently
  assert.match(terminalJs, /Cannot save: /);
});

test('frontend cockpit persists archive on close and emits internal alerts', () => {
  assert.match(terminalJs, /COCKPIT_ARCHIVE_KEY/);
  assert.match(terminalJs, /_cpArchiveTrade/);
  assert.match(terminalJs, /_cpGenAlerts/);
  assert.match(terminalJs, /TP1_HIT|TP2_HIT|TP3_HIT/);
  assert.match(terminalJs, /STOP_HIT/);
  assert.match(indexHtml, /id="cockpit-alerts-strip"/);
  assert.match(terminalCss, /\.cp-alert/);
});

test('frontend cockpit summary surfaces needs-action, avg health, winner/risk, no-price', () => {
  assert.match(terminalJs, /NEEDS ACTION/);
  assert.match(terminalJs, /AVG HEALTH/);
  assert.match(terminalJs, /WINNER/);
  assert.match(terminalJs, /NO PRICE/);
});

// ── Phase 1: live-trade validation safety (source guards) ───────────────────

test('frontend cockpit has an explicit side field (long/short) wired into the form', () => {
  assert.match(indexHtml, /id="cockpit-side"/);
  assert.match(indexHtml, /value="long"/);
  assert.match(indexHtml, /value="short"/);
  // save + fill must read/write the side field; default is long for legacy trades
  assert.match(terminalJs, /getElementById\('cockpit-side'\)/);
  assert.match(terminalJs, /trade\.side \|\| 'long'|trade\.side \? .* : 'long'|String\(trade\.side \|\| 'long'\)/);
});

test('frontend cockpit validates setup structurally and renders INVALID_SETUP (never long-math EXIT on bad geometry)', () => {
  assert.match(terminalJs, /_cpValidateSetup/);
  assert.match(terminalJs, /INVALID_SETUP/);
  assert.match(terminalJs, /stop must be below entry/);
  assert.match(terminalJs, /TP\$\{i \+ 1\} must be above entry/);
  // short is gated to manual review until short math exists
  assert.match(terminalJs, /short trades not yet supported/);
  assert.match(terminalJs, /MANUAL_REVIEW/);
});

test('frontend cockpit KITE regression is structurally guarded (stop-above-entry cannot pass validation)', () => {
  // The validator rejects a long whose stop >= entry, which is exactly the KITE
  // case (entry 0.1084 / stop 0.8900). Guard the exact predicate stays present.
  assert.match(terminalJs, /stop != null && stop > 0 && stop >= entry/);
});

test('frontend cockpit TP hit buttons are level-aware and reversible (no permanent fabrication)', () => {
  // level-aware persisted record instead of a bare boolean `true`
  assert.match(terminalJs, /tpHits\['tp' \+ i\] = \{ price: lvl/);
  // detection trusts a persisted hit only at the same configured level
  assert.match(terminalJs, /persistedHit = \(rec, lvl\) =>/);
  // fabricating a partial exit requires deliberate confirmation
  assert.match(terminalJs, /confirm\(/);
  // toggling an already-marked TP un-marks it
  assert.match(terminalJs, /delete t\.tpHits\['tp' \+ i\]/);
});

test('frontend cockpit persists last-alerted state so reloads do not replay STOP/TP alerts', () => {
  assert.match(terminalJs, /alertState/);
  assert.match(terminalJs, /if \(!Cockpit\.prev\[t\.id\] && t\.alertState\)/);
});

test('frontend cockpit does not auto-exit on low-confidence weak health (missing microstructure)', () => {
  assert.match(terminalJs, /else if \(lowConfidence\) \{ status = 'MANUAL_REVIEW'/);
});
