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

// ── QA: RADAR → Cockpit import correctness ──────────────────────────────────

test('frontend cockpit maps a RADAR entry type to a valid <select> option (no silent fallback to manual)', () => {
  // the select only accepts these values
  for (const opt of ['manual', 'early', 'standard', 'aggressive', 'swing']) {
    assert.match(indexHtml, new RegExp(`<option value="${opt}"`));
  }
  // prefill routes ENTRY_TYPE through the mapper, not the raw 'RADAR'/status string
  assert.match(terminalJs, /function _cpMapRadarEntryType\(/);
  assert.match(terminalJs, /entryType: _cpMapRadarEntryType\(c\.ENTRY_TYPE \|\| c\.entryType\)/);
  assert.doesNotMatch(terminalJs, /entryType: c\.ENTRY_TYPE \|\| c\.entryType \|\| 'RADAR'/);
  // mapper covers the RADAR families and defaults to a real option
  assert.match(terminalJs, /includes\('EARLY'\)\) return 'early'/);
  assert.match(terminalJs, /includes\('AGGRESSIVE'\) \|\| s\.includes\('CHASE'\)\) return 'aggressive'/);
  assert.match(terminalJs, /includes\('EXTENDED'\) \|\| s\.includes\('SWING'\)\) return 'swing'/);
  assert.match(terminalJs, /return 'standard';/);
});

test('frontend cockpit import prefills only trade fields — never Pressure Zones / Trade Readiness as entry/stop/TP', () => {
  const start = terminalJs.indexOf('function _cpPrefillFromRadar(');
  const block = terminalJs.slice(start, terminalJs.indexOf('function _cpTpBadge('));
  // preserves the real setup fields
  for (const f of ['symbol:', 'entryPrice:', 'stopLoss:', 'hardInvalidation:', 'tp1:', 'tp2:', 'tp3:', 'safetyStatus:', 'fromRadar: true']) {
    assert.ok(block.includes(f), `prefill must preserve ${f}`);
  }
  // context-only proxies must NOT leak into the imported trade
  assert.doesNotMatch(block, /pressureZones|tradeReadiness/);
});

// ── M1: manual-review checklist + funding context (context-only presentation) ──

test('frontend cockpit renders the 8-card manual review checklist', () => {
  assert.match(terminalJs, /_cpBuildReviewChecklist/);
  assert.match(terminalJs, /_cpReviewChecklistHtml/);
  assert.match(terminalJs, /CP_REVIEW_CARD_KEYS = \['structure', 'flow', 'funding', 'oi', 'orderbook', 'safety', 'news', 'regime'\]/);
  // the checklist is injected into each cockpit card
  assert.match(terminalJs, /\$\{_cpReviewChecklistHtml\(r\)\}/);
  assert.match(indexHtml, /id="cockpit-funding-context"/);
  assert.match(terminalCss, /\.cockpit-review/);
  assert.match(terminalCss, /\.review-card\.na/);
});

test('frontend cockpit checklist uses honest N/A labels and never fabricates values', () => {
  for (const label of [
    'Flow unavailable', 'Orderbook unavailable', 'OI unavailable', 'Funding unavailable',
    'Safety UNKNOWN blocks alerts', 'News unavailable/degraded', 'Market regime unavailable', 'manual review',
  ]) {
    assert.ok(terminalJs.includes(label), `missing honest label: ${label}`);
  }
  // "manual review required" banner is present
  assert.match(terminalJs, /MANUAL REVIEW REQUIRED/);
});

test('frontend cockpit checklist uses honest terminology (no CVD / whale orders / liquidation heatmap)', () => {
  assert.match(terminalJs, /Flow \(taker\)/);      // not "CVD"
  assert.match(terminalJs, /Orderbook \(depth\)/); // not "Whale Orders"
  assert.doesNotMatch(terminalJs, /liquidation heatmap/i);
  assert.doesNotMatch(terminalJs, /\bCVD\b/);
  assert.doesNotMatch(terminalJs, /Retail Sentiment/i);
});

test('frontend cockpit funding panel is context-only and cannot drive trading', () => {
  assert.match(terminalJs, /_cpFundingContextHtml/);
  assert.match(terminalJs, /_cpSummarizeFundingContext/);
  assert.match(terminalJs, /FUNDING DIVERGENCE · CONTEXT ONLY/);
  assert.match(terminalJs, /does not affect RADAR \/ ENTRY_READY \/ cockpit action \/ Telegram/);
  // reads the EXISTING divergence map — no new fetch is introduced
  assert.match(terminalJs, /DIVERGENCE_MAP/);
  assert.doesNotMatch(terminalJs, /fetch\('\/api\/funding-extremes'/);
});

test('frontend cockpit M1 layer introduces no Coinee reference or fetch', () => {
  assert.doesNotMatch(terminalJs, /coinee/i);
  assert.doesNotMatch(indexHtml, /coinee/i);
  assert.doesNotMatch(terminalCss, /coinee/i);
});

// ── M2: market-wide funding context + depth-wall honesty labels ─────────────

test('frontend funding panel renders market-wide FUNDING CONTEXT ONLY from a separate store', () => {
  // market-wide context is stored separately from the scoring divergence map
  assert.match(terminalJs, /let FUNDING_CONTEXT = null;/);
  assert.match(terminalJs, /FUNDING_CONTEXT = \(j\.funding_context/);
  assert.match(terminalJs, /_cpMarketFundingHtml/);
  assert.match(terminalJs, /FUNDING CONTEXT ONLY/);
  assert.match(terminalJs, /top_positive/);
  assert.match(terminalJs, /top_negative/);
  // the existing scoring path still reads only DIVERGENCE_MAP, never FUNDING_CONTEXT
  assert.match(terminalJs, /DIVERGENCE_MAP\.get\(String\(symbol \|\| ''\)\.toUpperCase\(\)\)/);
  assert.doesNotMatch(terminalJs, /_readDivergenceSignal[\s\S]{0,200}FUNDING_CONTEXT/);
});

test('frontend divergence-map population is unchanged (context field does not feed the signal map)', () => {
  // DIVERGENCE_MAP is still filled only from j.signals
  assert.match(terminalJs, /for \(const s of \(j\.signals \|\| \[\]\)\) \{\s*DIVERGENCE_MAP\.set/);
});

test('frontend depth-wall (sniper) panel carries honest resting-order caveats (not whale orders)', () => {
  assert.match(terminalJs, /sniper-honesty/);
  assert.match(terminalJs, /Resting limit orders/);
  assert.match(terminalJs, /can be pulled/);
  assert.match(terminalJs, /not executed flow/);
  assert.match(terminalJs, /Absorption needs rolling-flow confirmation/);
  assert.doesNotMatch(terminalJs, /whale orders/i);
  assert.match(terminalCss, /\.sniper-honesty/);
});
