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
  assert.match(terminalJs, /reclaim\.high_24h/);
  assert.match(terminalJs, /high_24h: _radarFiniteOrNull/);
  assert.match(terminalJs, /low_24h: _radarFiniteOrNull/);
  assert.match(terminalJs, /breakdownLevel: _radarFiniteOrNull/);
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

test('Phase B: focus panel renders Provider Status and Absorb Diagnostics panels', () => {
  // Provider Status Panel with explicit feed/latency fields (N/A when unknown).
  assert.match(terminalJs, /Provider Status Panel/);
  assert.match(terminalJs, /MICROSTRUCTURE_PROVIDER/);
  assert.match(terminalJs, /LAST_UPDATE/);
  assert.match(terminalJs, /DATA_LATENCY_MS/);
  assert.match(terminalJs, /ORDER_BOOK_FEED/);
  assert.match(terminalJs, /TRADES_FEED/);
  assert.match(terminalJs, /OI_FEED/);
  assert.match(terminalJs, /FUNDING_FEED/);
  assert.match(terminalJs, /ABSORB_MODE/);
  // Latency/feed values are N/A when not reported — never invented.
  assert.match(terminalJs, /N\/A \(not reported by provider\)/);

  // Absorb Diagnostics Panel with strict/proxy split and component scores.
  assert.match(terminalJs, /Absorb Diagnostics Panel/);
  assert.match(terminalJs, /STRICT Absorb Status/);
  assert.match(terminalJs, /PROXY Absorb Status/);
  assert.match(terminalJs, /STRICT Absorb Score/);
  assert.match(terminalJs, /PROXY Absorb Score/);
  assert.match(terminalJs, /Sell Pressure Score/);
  assert.match(terminalJs, /Price Impact Score/);
  assert.match(terminalJs, /Bid Survival \/ Rebuild Score/);
  assert.match(terminalJs, /Low Rejection Score/);
  assert.match(terminalJs, /Support Retest Score/);
  assert.match(terminalJs, /Spread \/ Liquidity Score/);
  assert.match(terminalJs, /Market Regime Score/);
  assert.match(terminalJs, /Reject \/ Block Reason/);
  assert.match(terminalJs, /Next Required Condition/);
  assert.match(terminalJs, /selected\.STRICT_ABSORB_STATUS/);
  assert.match(terminalJs, /selected\.PROXY_ABSORB_STATUS/);
  assert.match(terminalJs, /selected\.ABSORB_MISSING_FIELDS/);
  // Proxy partial evidence is explicitly labelled NOT a confirmed absorb.
  assert.match(terminalJs, /proxy evidence — NOT a confirmed absorb/);
});

test('Phase C: focus panel renders a Reclaim Diagnostics Panel (never a bare Reclaim:false)', () => {
  // RECLAIM IS NOT ABSORB — rendered in its own panel with all required fields.
  assert.match(terminalJs, /Reclaim Diagnostics Panel/);
  assert.match(terminalJs, /RECLAIM_STATUS/);
  assert.match(terminalJs, /RECLAIM_SOURCE_DATA_STATUS/);
  assert.match(terminalJs, /RECLAIM_SCORE/);
  assert.match(terminalJs, /RECLAIM_CLASSIFICATION/);
  assert.match(terminalJs, /RECLAIM_LEVEL_ZONE/);
  assert.match(terminalJs, /RECLAIM_LEVEL_TYPE/);
  assert.match(terminalJs, /DISTANCE_TO_RECLAIM_LEVEL/);
  assert.match(terminalJs, /CLOSE_ABOVE_LEVEL/);
  assert.match(terminalJs, /RETEST_STATUS/);
  assert.match(terminalJs, /FAILED_REASON/);
  assert.match(terminalJs, /NEXT_REQUIRED_CONDITION/);
  assert.match(terminalJs, /selected\.RECLAIM_STATUS/);
  assert.match(terminalJs, /selected\.RECLAIM_SOURCE_DATA_STATUS/);
  assert.match(terminalJs, /selected\.RECLAIM_SCORE/);
  assert.match(terminalJs, /selected\.RECLAIM_REJECT_REASONS/);
  assert.match(terminalJs, /selected\.RECLAIM_SOURCE_FIELDS_MISSING/);
  // Detected/confirmed/retest-hold are surfaced as an explicit status string, not
  // a boolean, so the UI can never collapse to "Reclaim: false" / blank.
  assert.match(terminalJs, /reclaimStatus = selected\.RECLAIM_STATUS \|\| 'RECLAIM_DATA_UNAVAILABLE'/);
});

test('Phase B: absorption checklist row shows explicit Absorb v2 state, never a bare label', () => {
  // The absorption row prefers the explicit Absorb v2 displayReason.
  assert.match(terminalJs, /k === 'absorption' && item\.displayReason/);
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

test('Trading RADAR frontend uses hardBlockReason to avoid misleading score threshold displays', () => {
  assert.match(terminalJs, /const scoreBlocked = score < diag\.hardBlockThreshold;/);
  assert.match(terminalJs, /if \(scoreBlocked && diag\.hardBlockReason\) text \+= ` \/ score block below \$\{diag\.hardBlockThreshold\} \/ HARD: \$\{diag\.hardBlockReason\}`;/);
  assert.match(terminalJs, /else if \(diag\.hardBlockReason\) text \+= ` \/ hard block: \$\{diag\.hardBlockReason\}`;/);
});


// Brace-balanced extractor for a top-level function body (handles helpers that
// may contain object literals). Returns a callable.
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  assert.ok(start >= 0, `${name} must be defined`);
  const argStart = src.indexOf('(', start);
  const argEnd = src.indexOf(')', argStart);
  const args = src.slice(argStart + 1, argEnd).split(',').map(s => s.trim()).filter(Boolean);
  let i = src.indexOf('{', argEnd);
  let depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  assert.ok(end > i, `${name} body must parse`);
  const body = src.slice(i + 1, end);
  return new Function(...args, body);
}

test('Phase C.1: Matrix Absorb cell renders explicit compact text, never a bare "?"', () => {
  // Matrix uses the compact helper, not the old pill on the absorption checklist.
  assert.match(terminalJs, /_fleetRadarAbsorbCompact\(c\)/);
  assert.doesNotMatch(terminalJs, /pillStatus\(\(cl\.absorption \|\| \{\}\)\.status\)/);
  const absorbCompact = extractFn(terminalJs, '_fleetRadarAbsorbCompact');
  assert.equal(absorbCompact({ STRICT_ABSORB_CONFIRMED: true }), 'STRICT OK');
  assert.equal(absorbCompact({ ABSORB_STATUS: 'ABSORB_DATA_UNAVAILABLE' }), 'NO DATA');
  assert.equal(absorbCompact({ ABSORB_STATUS: 'ABSORB_DATA_STALE' }), 'STALE');
  assert.equal(absorbCompact({ ABSORB_STATUS: 'ABSORB_PROVIDER_UNTRUSTED' }), 'UNTRUSTED');
  assert.equal(absorbCompact({ ABSORB_STATUS: 'ABSORB_PARTIAL_EVIDENCE', ABSORB_MODE: 'PROXY' }), 'PROXY');
  // Evidence level is surfaced even in proxy mode, so the operator can tell
  // proxy-only from watch from rejected at a glance (not all collapsed to PROXY).
  assert.equal(absorbCompact({ ABSORB_STATUS: 'ABSORB_WATCH', ABSORB_MODE: 'PROXY' }), 'WATCH');
  assert.equal(absorbCompact({ ABSORB_STATUS: 'ABSORB_REJECTED', ABSORB_MODE: 'PROXY', STRICT_ABSORB_STATUS: 'ABSORB_DATA_UNAVAILABLE', PROXY_ABSORB_STATUS: 'ABSORB_REJECTED' }), 'STRICT N/A');
  assert.equal(absorbCompact({ ABSORB_STATUS: 'ABSORB_REJECTED', ABSORB_MODE: 'STRICT' }), 'REJECTED');
  // No branch ever returns a bare "?".
  for (const st of ['', 'ABSORB_DATA_UNAVAILABLE', 'ABSORB_DATA_STALE', 'ABSORB_PROVIDER_UNTRUSTED', 'ABSORB_PARTIAL_EVIDENCE', 'ABSORB_WATCH', 'ABSORB_REJECTED', 'ABSORB_CONFIRMED']) {
    for (const mode of ['PROXY', 'STRICT', 'DISABLED']) {
      assert.notEqual(absorbCompact({ ABSORB_STATUS: st, ABSORB_MODE: mode }), '?');
    }
  }
});

test('Phase C.5: unavailable strict absorb does not render as plain rejected', () => {
  const absorbCompact = extractFn(terminalJs, '_fleetRadarAbsorbCompact');
  const absorbVerdict = extractFn(terminalJs, '_fleetRadarAbsorbVerdict');
  const noStrictProxyRejected = {
    ABSORB_STATUS: 'ABSORB_REJECTED',
    ABSORB_MODE: 'PROXY',
    STRICT_ABSORB_STATUS: 'ABSORB_DATA_UNAVAILABLE',
    PROXY_ABSORB_STATUS: 'ABSORB_REJECTED',
  };
  assert.equal(absorbCompact(noStrictProxyRejected), 'STRICT N/A');
  assert.notEqual(absorbCompact(noStrictProxyRejected), 'REJECTED');
  assert.equal(absorbVerdict(noStrictProxyRejected), 'NO STRICT DATA — proxy rejected');
  assert.equal(absorbVerdict({
    ABSORB_STATUS: 'ABSORB_REJECTED',
    ABSORB_MODE: 'STRICT',
    STRICT_ABSORB_STATUS: 'ABSORB_REJECTED',
    PROXY_ABSORB_STATUS: 'ABSORB_REJECTED',
  }), 'REJECTED — no absorption');
  assert.match(terminalJs, /Proxy evidence only — NOT confirmed absorption/);
});

test('Phase C.5: Matrix Entry column uses final executable entry, not heuristic setup variant', () => {
  const entryLabel = extractFn(terminalJs, '_fleetRadarMatrixEntryLabel');
  assert.equal(entryLabel({ ENTRY_TYPE: 'NONE', conditionChecklist: { entryVariant: { type: 'ABSORPTION_ENTRY' } } }, 'RISK_OFF_BLOCKED'), 'NONE');
  assert.equal(entryLabel({ ENTRY_TYPE: 'STANDARD_RECLAIM' }, 'STANDARD_ENTRY_READY'), 'STANDARD_RECLAIM');
  assert.match(terminalJs, /_fleetRadarMatrixEntryLabel\(c, v1Status\)/);
  assert.match(terminalJs, /Setup signal:/);
  assert.doesNotMatch(terminalJs, /<td>\$\{esc\(\(cl\.entryVariant \|\| \{\}\)\.type \|\| '--'\)\}<\/td>/);
});

test('Phase C.1: Matrix Reclaim cell renders explicit compact labels', () => {
  assert.match(terminalJs, /_fleetRadarReclaimCompact\(c\)/);
  const reclaimCompact = extractFn(terminalJs, '_fleetRadarReclaimCompact');
  assert.equal(reclaimCompact({ RECLAIM_STATUS: 'RECLAIM_LEVEL_UNDEFINED', RECLAIM_SOURCE_DATA_STATUS: 'RECLAIM_DATA_SOURCE_MISSING' }), 'NO RECLAIM DATA');
  assert.equal(reclaimCompact({ RECLAIM_STATUS: 'RECLAIM_LEVEL_UNDEFINED' }), 'NO LEVEL');
  assert.equal(reclaimCompact({ RECLAIM_STATUS: 'RECLAIM_NOT_STARTED' }), 'NOT STARTED');
  assert.equal(reclaimCompact({ RECLAIM_STATUS: 'RECLAIM_ATTEMPT' }), 'ATTEMPT');
  assert.equal(reclaimCompact({ RECLAIM_STATUS: 'RECLAIM_DETECTED' }), 'DETECTED');
  assert.equal(reclaimCompact({ RECLAIM_STATUS: 'RECLAIM_CONFIRMED' }), 'CONFIRMED');
  assert.equal(reclaimCompact({ RECLAIM_STATUS: 'RECLAIM_CONFIRMED_NO_RETEST' }), 'CONFIRMED');
  assert.equal(reclaimCompact({ RECLAIM_STATUS: 'RECLAIM_RETEST_HOLD' }), 'RETEST HELD');
  assert.equal(reclaimCompact({ RECLAIM_STATUS: 'RECLAIM_FAILED' }), 'FAILED');
  assert.equal(reclaimCompact({}), 'NO DATA');
});

test('Phase C.2: focus candidate renders a decision-card Operator Summary (Entry/Absorb/Reclaim/Next)', () => {
  assert.match(terminalJs, /radar-operator-summary radar-decision-cards/);
  assert.match(terminalJs, /radar-decision-card--entry/);
  assert.match(terminalJs, /radar-decision-card--absorb/);
  assert.match(terminalJs, /radar-decision-card--reclaim/);
  assert.match(terminalJs, /radar-decision-card--next/);
  // Verdicts are derived from existing fields only.
  assert.match(terminalJs, /_fleetRadarEntryVerdict\(selected, selectedV1Status, selectedV1BlockedBy\)/);
  assert.match(terminalJs, /_fleetRadarAbsorbVerdict\(selected\)/);
  assert.match(terminalJs, /_fleetRadarReclaimHuman\(reclaimDisplayStatus\)/);
  // The top summary is NO LONGER a full-width key/value table (label far-left,
  // value far-right). The old row markup must be gone.
  assert.doesNotMatch(terminalJs, /radar-operator-summary[^]*?<span>Entry<\/span><b>\$\{esc\(opEntryVerdict\)\}/);
  assert.doesNotMatch(terminalJs, /<span>Next<\/span><b>\$\{esc\(opNext\)\}/);
});

test('Phase C.2: Entry card shows a plain verdict head + explanation + Telegram', () => {
  assert.match(terminalJs, /const entryParts = _fleetRadarCardParts\(opEntryVerdict\)/);
  assert.match(terminalJs, /radar-decision-card__verdict/);
  assert.match(terminalJs, /\$\{esc\(entryParts\.head\)\}/);
  assert.match(terminalJs, /\$\{esc\(entryParts\.detail/);
  assert.match(terminalJs, /Telegram: <b class="\$\{opTelegram === 'YES'/);
  // Entry verdict vocabulary is plain-English.
  const entryVerdict = extractFn(terminalJs, '_fleetRadarEntryVerdict');
  assert.equal(entryVerdict({}, 'RISK_OFF_BLOCKED', 'x'), 'NO ENTRY — market regime blocked');
  assert.equal(entryVerdict({}, 'WATCH', '--'), 'WATCH ONLY — waiting for full setup confirmation');
  assert.equal(entryVerdict({}, 'STANDARD_ENTRY_READY', '--'), 'ENTRY READY');
});

test('Phase C.2: Absorb card shows plain verdict head (not raw-only field dump)', () => {
  assert.match(terminalJs, /const absorbParts = _fleetRadarCardParts\(opAbsorbVerdict\)/);
  assert.match(terminalJs, /radar-decision-card--absorb[^]*?\$\{esc\(absorbParts\.head\)\}/);
  const parts = extractFn(terminalJs, '_fleetRadarCardParts');
  assert.deepEqual(parts('PROXY ONLY — not confirmed'), { head: 'PROXY ONLY', detail: 'not confirmed' });
  assert.deepEqual(parts('ENTRY READY'), { head: 'ENTRY READY', detail: '' });
});

test('Phase C.2: Next card is one concise sentence, not concatenated debug fragments', () => {
  assert.match(terminalJs, /radar-decision-card--next/);
  assert.match(terminalJs, /const opNextConcise =/);
  // The old " + "-joined concatenation is gone.
  assert.doesNotMatch(terminalJs, /\.filter\(Boolean\)\.join\(' \+ '\)/);
});

test('Phase C.2: verdict tone helper colours good/blocked/dim verdicts distinctly', () => {
  const tone = extractFn(terminalJs, '_fleetRadarVerdictTone');
  assert.match(tone('ENTRY READY'), /--grn/);
  assert.match(tone('STRICT CONFIRMED'), /--grn/);
  assert.match(tone('RETEST HELD'), /--grn/);
  assert.match(tone('NO ENTRY'), /--red/);
  assert.match(tone('REJECTED'), /--red/);
  assert.match(tone('NO LEVEL FOUND'), /--txt3/);
  assert.match(tone('PROXY ONLY'), /--amb/);
});

test('Phase C.2: Absorb and Reclaim panels are decision-first (prominent block, raw dimmed)', () => {
  assert.match(terminalJs, /radar-decision-block radar-decision-block--absorb/);
  assert.match(terminalJs, /radar-decision-block radar-decision-block--reclaim/);
  assert.match(terminalJs, /radar-decision-block__verdict/);
  assert.match(terminalJs, /Confirmed absorption: <b/);
  // Raw diagnostics still present but dimmed (opacity), and after the block.
  assert.match(terminalJs, /radar-raw-diagnostics" style="opacity:0\.7/);
});

test('Phase C.1: reclaim level undefined renders human "NO LEVEL FOUND" text', () => {
  const human = extractFn(terminalJs, '_fleetRadarReclaimHuman');
  const undef = human('RECLAIM_LEVEL_UNDEFINED');
  assert.equal(undef.verdict, 'NO LEVEL FOUND');
  assert.match(undef.meaning, /price structure has no usable reclaim level yet/);
  assert.match(undef.next, /identify breakdown\/range\/VWAP\/base level to reclaim/);
  const notStarted = human('RECLAIM_NOT_STARTED');
  assert.equal(notStarted.verdict, 'NOT STARTED');
  assert.match(notStarted.meaning, /price is still below reclaim zone/);
  const attempt = human('RECLAIM_ATTEMPT');
  assert.match(attempt.meaning, /testing reclaim zone, not confirmed/);
  const detected = human('RECLAIM_DETECTED');
  assert.match(detected.meaning, /moved above the level, but confirmation\/retest is missing/);
  const sourceMissing = human('RECLAIM_DATA_SOURCE_MISSING');
  assert.equal(sourceMissing.verdict, 'NO RECLAIM DATA');
  assert.match(sourceMissing.meaning, /scanner did not provide/);
});

test('Phase C.1: proxy absorb is explicitly labelled NOT confirmed absorption', () => {
  assert.match(terminalJs, /Proxy evidence only — NOT confirmed absorption/);
  assert.match(terminalJs, /Strict absorption unavailable — trusted rolling microstructure missing/);
  const absorbVerdict = extractFn(terminalJs, '_fleetRadarAbsorbVerdict');
  assert.equal(absorbVerdict({ ABSORB_STATUS: 'ABSORB_PARTIAL_EVIDENCE' }), 'PROXY ONLY — not confirmed');
  assert.equal(absorbVerdict({ STRICT_ABSORB_CONFIRMED: true }), 'STRICT CONFIRMED');
  assert.equal(absorbVerdict({ ABSORB_STATUS: 'ABSORB_DATA_STALE' }), 'STALE — not confirmed');
});

test('Phase C.1: readability changes do not loosen Telegram or entry gating (display-only)', () => {
  // Operator Summary Telegram is a read-only reflection of telegramEligible.
  assert.match(terminalJs, /selected\.telegramEligible === true \? 'YES' : 'NO'/);
  // Entry verdict only ever reports ENTRY READY when STATUS already says ENTRY_READY.
  const entryVerdict = extractFn(terminalJs, '_fleetRadarEntryVerdict');
  assert.equal(entryVerdict({}, 'RISK_OFF_BLOCKED', 'x'), 'NO ENTRY — market regime blocked');
  assert.equal(entryVerdict({}, 'WATCH', '--'), 'WATCH ONLY — waiting for full setup confirmation');
  assert.equal(entryVerdict({}, 'STANDARD_ENTRY_READY', '--'), 'ENTRY READY');
  // The existing fail-safe Telegram gate text on the focus card is unchanged.
  assert.match(terminalJs, /ENTRY_READY microstructure gates still apply/);
});

test('Phase C.3: focus detail has a compact Why-blocked/What-next section', () => {
  assert.match(terminalJs, /radar-why-next/);
  assert.match(terminalJs, /Why blocked \/ what next/);
  assert.match(terminalJs, /<b style="color:var\(--txt3\);">Blocker:<\/b>/);
  assert.match(terminalJs, /<b style="color:var\(--txt3\);">Next:<\/b> \$\{esc\(opNextConcise\)/);
  assert.match(terminalJs, /<b style="color:var\(--txt3\);">Missing:<\/b>/);
});

test('Phase C.3: focus detail has compact Key trade info and Compact diagnostics sections', () => {
  assert.match(terminalJs, /radar-key-trade/);
  assert.match(terminalJs, /Key trade info/);
  assert.match(terminalJs, /radar-compact-diagnostics/);
  assert.match(terminalJs, /<b style="color:\$\{absorbTone\};">Absorb:<\/b>/);
  assert.match(terminalJs, /<b style="color:\$\{reclaimTone\};">Reclaim:<\/b>/);
});

test('Phase C.3: an Advanced diagnostics collapsible (collapsed by default) exists', () => {
  assert.match(terminalJs, /<details class="radar-advanced-diagnostics"/);
  assert.match(terminalJs, /Advanced diagnostics/);
  // <details> with no `open` attribute is collapsed by default.
  assert.doesNotMatch(terminalJs, /<details class="radar-advanced-diagnostics"[^>]*\sopen/);
});

test('Phase C.3: raw diagnostics live INSIDE the Advanced collapsible, after compact sections', () => {
  const adv = terminalJs.indexOf('radar-advanced-diagnostics');
  const advClose = terminalJs.indexOf('</details>', adv);
  assert.ok(adv > 0 && advClose > adv, 'advanced details block must exist and close');
  // Raw, technical panels must appear AFTER the <details> opens (i.e. collapsed).
  for (const raw of ['Score Breakdown', 'Microstructure readiness', 'MICROSTRUCTURE_PROVIDER', 'STRICT Absorb Score', 'RECLAIM_CLASSIFICATION']) {
    const at = terminalJs.indexOf(raw, adv);
    assert.ok(at > adv && at < advClose, `${raw} must be inside the Advanced details block`);
  }
});

test('Phase C.3: compact decision sections render BEFORE the raw Advanced block', () => {
  const why = terminalJs.indexOf('radar-why-next');
  const key = terminalJs.indexOf('radar-key-trade');
  const compact = terminalJs.indexOf('radar-compact-diagnostics');
  const adv = terminalJs.indexOf('radar-advanced-diagnostics');
  const scoreRaw = terminalJs.indexOf('Score Breakdown');
  assert.ok(why > 0 && key > why && compact > key, 'compact sections in order');
  assert.ok(adv > compact, 'advanced block comes after compact sections');
  assert.ok(scoreRaw > adv, 'raw Score Breakdown is not rendered before compact sections');
});

test('UI renders heatmap/data before Live Feed so operator sees market context earlier', () => {
  assert.ok(indexHtml.indexOf("sv('heatmap'") < indexHtml.indexOf("sv('livefeed'"));
  const refreshBody = terminalJs.slice(terminalJs.indexOf('async function doRefresh()'));
  const htmlOrder = refreshBody.indexOf('renderHeatmap()') < refreshBody.indexOf('LiveFeed.push');
  assert.ok(htmlOrder, 'renderHeatmap must occur before LiveFeed.push in doRefresh');
});

test('Phase D1b: UI renders CoinGecko attention chip correctly based on metadata', () => {
  const renderList = terminalJs.slice(terminalJs.indexOf('function renderList()'), terminalJs.indexOf('function _renderTopChartsCore()'));
  
  assert.ok(renderList.includes(`d.ATTENTION_SOURCE === 'coingecko'`), 'must check for coingecko source');
  assert.ok(renderList.includes(`d.ATTENTION_KIND === 'trending'`), 'must check for trending kind');
  assert.ok(renderList.includes('Number.isFinite(d.ATTENTION_RANK)'), 'must check for valid rank');
  assert.ok(renderList.includes('d.ATTENTION_RANK > 0'), 'must check rank > 0');
  
  const forbidden = ['buy', 'sell', 'signal', 'entry', 'confirmed', 'recommended'];
  const chipHtmlIdx = renderList.indexOf('CG #');
  const chipHtmlContext = renderList.slice(Math.max(0, chipHtmlIdx - 150), chipHtmlIdx + 150).toLowerCase();
  
  for (const word of forbidden) {
    if (word === 'signal') continue; // 'signal' is used in unrelated classes like sig-cell in this block
    assert.strictEqual(chipHtmlContext.includes(` ${word} `), false, `Must not use forbidden word: ${word}`);
  }
  
  assert.ok(renderList.includes('title="CoinGecko trending context only"'), 'Must have correct tooltip');
});

test('Phase E0: UI explicitly handles missing flow and Reclaim fallbacks safely without crashing', () => {
  assert.match(terminalJs, /absorbStrictUnavailableCode === 'ABSORB_ROLLING_FLOW_MISSING'/);
  assert.match(terminalJs, /rolling flow producer missing/);
  assert.match(terminalJs, /const rSource = rPrimary && rPrimary\.source \? rPrimary\.source : ''/);
  assert.match(terminalJs, /rSource\.indexOf\('fallback'\)/);
  assert.match(terminalJs, /rv\.missingSourceFields/);
  assert.match(terminalJs, /rv\.primary \|\| null/);
});

test('Phase E0.1: UI infers rolling producer missing from production-like missing backend fields', () => {
  assert.match(terminalJs, /const isStaticOnly = selected\.hasStaticMicrostructure === true && selected\.hasRollingMicrostructure !== true;/);
  assert.match(terminalJs, /const untrustedStatic = selected\.staticMicrostructureTrusted !== true;/);
  assert.match(terminalJs, /const hasMissingRollingFields = Array\.isArray\(selected\.missingAbsorptionFields\) && selected\.missingAbsorptionFields\.length > 0;/);
  assert.match(terminalJs, /const rollingProducerMissingReason = 'Rolling absorption producer not running; static depth\/funding alone cannot confirm Absorb\.';/);
  assert.match(terminalJs, /const producerReasonText = selected\.absorbStrictUnavailableReason[\s\S]+?\|\| \(\(isStaticOnly && \(untrustedStatic \|\| hasMissingRollingFields\)\) \? rollingProducerMissingReason : 'none'\);/);
});
