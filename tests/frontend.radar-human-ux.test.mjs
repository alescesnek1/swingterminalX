// Guards for the human-first RADAR Focus Candidate redesign. The default Focus
// view must read in ~10 seconds: one dominant decision card, a plain-language
// gate checklist, a single next action, and key trade levels — with every
// admin/debug/raw panel collapsed under a single "Technical details" accordion.
// Display/copy only: no backend scoring, strict Absorb, reclaim, ENTRY_READY,
// or Telegram logic changes. The pure render helpers are executed in isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');

function extractFn(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  assert.ok(start >= 0, `could not find ${sig}`);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// Build a sandbox with the human-first helpers + their deps executable.
function loadHelpers() {
  const names = [
    '_fleetRadarVerdictTone', '_radarReclaimGate', '_radarReclaimPlain', '_radarSafetyGate',
    '_radarDecisionReason', '_radarHumanDecisionHtml', '_radarGateChecklistHtml',
    '_radarNextActionHtml', '_radarKeyLevelsHtml', '_radarDataSourceMatrixHtml',
  ];
  const body = names.map((n) => extractFn(terminalJs, n)).join('\n\n');
  const factory = new Function(`const _esc=(x)=>String(x==null?'':x);\n${body}\nreturn { ${names.join(', ')} };`);
  return factory();
}

const H = loadHelpers();

const baseCtx = (over = {}) => ({
  esc: (x) => String(x == null ? '' : x),
  status: 'WATCH',
  blockedBy: '--',
  entryParts: { head: 'WATCH ONLY', detail: '' },
  reclaimHuman: { verdict: 'NOT STARTED', meaning: '', next: '' },
  reclaimDisplayStatus: 'RECLAIM_NOT_STARTED',
  reclaimSettled: false,
  strictConfirmedUi: false,
  strictStatusText: 'STALE',
  opTelegram: 'NO',
  opNextConcise: 'Wait for price to reclaim the zone, then confirm absorption.',
  entryReadyNow: false,
  keyLevels: { zone: '2.22-2.24', stop: '2.19', inval: '2.18', tps: '2.35 / 2.46 / 2.58', tf: '1D setup, 1H/15M execution' },
  ...over,
});
const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ── 1. Decision card: WATCH ONLY + Do not enter now ──────────
test('decision card shows the symbol, WATCH ONLY verdict and an explicit "Do not enter now"', () => {
  const html = H._radarHumanDecisionHtml({ symbol: 'LITUSDT' }, baseCtx());
  const txt = strip(html);
  assert.match(txt, /LITUSDT/);
  assert.match(txt, /WATCH ONLY/);
  assert.match(txt, /Do not enter now/);
  assert.match(txt, /Main reason/);
});

test('decision card does NOT say "Do not enter now" once entry gates are confirmed', () => {
  const html = H._radarHumanDecisionHtml({ symbol: 'FOOUSDT' }, baseCtx({ entryParts: { head: 'ENTRY READY', detail: '' }, entryReadyNow: true }));
  const txt = strip(html);
  assert.doesNotMatch(txt, /Do not enter now/);
  assert.match(txt, /Entry gates are confirmed/);
});

// ── 8. Long STALE paragraph is not inside the decision card ──
test('the decision card does not carry the long system-wide STALE paragraph', () => {
  const html = H._radarHumanDecisionHtml({ symbol: 'LITUSDT' }, baseCtx());
  assert.doesNotMatch(html, /Strict rolling absorption is STALE for all candidates/);
  assert.doesNotMatch(html, /different data layers/);
});

// ── 2/3/4/5/6. Gate checklist plain language + distinct rows ──
test('gate checklist renders plain-language reclaim/absorption/strict/live/safety/telegram rows', () => {
  const txt = strip(H._radarGateChecklistHtml({ symbol: 'LITUSDT', safetyStatus: 'UNKNOWN' }, baseCtx()));
  assert.match(txt, /Gate checklist/);
  // 3) reclaim not started, plain
  assert.match(txt, /Reclaim [^A-Za-z]*Not started/);
  // 4) absorption not confirmed, plain
  assert.match(txt, /Absorption [^A-Za-z]*Not confirmed/);
  // 5) strict-absorb DATA availability is a DISTINCT row from "absorption not confirmed"
  assert.match(txt, /Strict Absorb [^A-Za-z]*Server data unavailable/);
  // 6) live market data is explicitly advisory-only (never an entry approval)
  assert.match(txt, /Live market data [^A-Za-z]*Available, advisory only/);
  assert.match(txt, /Safety [^A-Za-z]*Unknown/);
  assert.match(txt, /Telegram [^A-Za-z]*No — entry gates not confirmed/);
});

test('absorption-not-confirmed and strict-absorb-unavailable are two separate concepts', () => {
  const html = H._radarGateChecklistHtml({ symbol: 'X', safetyStatus: 'UNKNOWN' }, baseCtx());
  // Both rows must exist independently — an unavailable producer must not read
  // as a rejected/again-not-confirmed absorption verdict.
  assert.ok(html.includes('Not confirmed'), 'absorption concept row');
  assert.ok(html.includes('Server data unavailable'), 'strict-absorb data-availability row');
});

test('gate checklist reflects confirmed states when the gates pass', () => {
  const txt = strip(H._radarGateChecklistHtml({ symbol: 'X', safetyStatus: 'SAFE' }, baseCtx({
    reclaimDisplayStatus: 'RECLAIM_RETEST_HOLD', reclaimSettled: true, strictConfirmedUi: true, opTelegram: 'YES',
  })));
  assert.match(txt, /Reclaim [^A-Za-z]*Confirmed/);
  assert.match(txt, /Absorption [^A-Za-z]*Confirmed/);
  assert.match(txt, /Strict Absorb [^A-Za-z]*Available/);
  assert.match(txt, /Safety [^A-Za-z]*Safe/);
  assert.match(txt, /Telegram [^A-Za-z]*Yes/);
});

// ── Next action ──────────────────────────────────────────────
test('next action shows the single next step + the "not an entry signal" caution when not ready', () => {
  const txt = strip(H._radarNextActionHtml({ symbol: 'X' }, baseCtx()));
  assert.match(txt, /Next action/);
  assert.match(txt, /Wait for price to reclaim the zone/);
  assert.match(txt, /Do not treat live orderbook OK as an entry signal/);
});

// ── Key levels ───────────────────────────────────────────────
test('key levels renders entry zone / stop / invalidation / targets / timeframe from data', () => {
  const txt = strip(H._radarKeyLevelsHtml({ symbol: 'X' }, baseCtx()));
  for (const v of ['Entry zone', '2.22-2.24', 'Stop', '2.19', 'Invalidation', '2.18', 'Targets', '2.35 / 2.46 / 2.58', 'Timeframe']) {
    assert.ok(txt.includes(v), `key levels must include ${v}`);
  }
});

// ── Data-source matrix (inside Technical details) ────────────
test('data-source matrix explains server-strict-Absorb vs advisory live layers', () => {
  const txt = strip(H._radarDataSourceMatrixHtml({ symbol: 'X' }, {}, baseCtx()));
  assert.match(txt, /Server strict Absorb [^|]*Unavailable [^|]*rolling producer not running/);
  assert.match(txt, /Browser orderbook [^|]*Advisory/);
  assert.match(txt, /Liquidation [^|]*Unknown [^|]*no public feed wired/);
});

// ── 7. Default view: human sections first, everything else collapsed ──
test('default Focus view emits the 4 human sections BEFORE the Technical details accordion', () => {
  const cardStart = terminalJs.indexOf('focusHtml = `<div class="radar-focus-card">');
  assert.ok(cardStart > 0);
  const decision = terminalJs.indexOf('_radarHumanDecisionHtml(selected, ctx)', cardStart);
  const gate = terminalJs.indexOf('_radarGateChecklistHtml(selected, ctx)', cardStart);
  const next = terminalJs.indexOf('_radarNextActionHtml(selected, ctx)', cardStart);
  const levels = terminalJs.indexOf('_radarKeyLevelsHtml(selected, ctx)', cardStart);
  const tech = terminalJs.indexOf('<details class="radar-technical-details"', cardStart);
  assert.ok(decision > 0 && gate > decision && next > gate && levels > next, 'the four human sections render in order');
  assert.ok(tech > levels, 'Technical details accordion comes after the human sections');
});

test('all admin/debug/raw panels are nested inside the collapsed Technical details accordion', () => {
  const tech = terminalJs.indexOf('<details class="radar-technical-details"');
  const summary = terminalJs.indexOf('>Technical details</summary>', tech);
  assert.ok(tech > 0 && summary > tech, 'Technical details summary exists');
  for (const marker of [
    'radar-trade-readiness', '_radarBackendPriceHistoryHtml(selected)', '_radarPriceHistorySectionHtml(selected)',
    "_liveMicroSlotHtml('radar-live-microstructure-slot'", '_radarMicrostructureStatusNote(radar)',
    'Score Breakdown', 'Provider Status Panel', 'Absorb Diagnostics Panel', 'Reclaim Diagnostics Panel',
    '_radarDataSourceMatrixHtml(selected, radar, ctx)',
  ]) {
    const at = terminalJs.indexOf(marker, summary);
    assert.ok(at > summary, `${marker} must live inside the Technical details accordion`);
  }
});

test('Technical details accordion is collapsed by default (no hardcoded open attribute)', () => {
  assert.match(terminalJs, /class="radar-technical-details"\$\{window\._fleetTechDetailsExpanded[^}]*\? ' open' : ''\}/);
  assert.doesNotMatch(terminalJs, /class="radar-technical-details"\s+open/);
});

// ── 9. RADAR matrix column relabel + STALE→DATA OFF ──────────
test('matrix Absorb column is relabeled "Strict Absorb Gate" and STALE displays as DATA OFF', () => {
  assert.match(terminalJs, /<th[^>]*>Strict Absorb Gate<\/th>/);
  assert.doesNotMatch(terminalJs, /<th>Absorb\.<\/th>/);
  // Cell display maps the STALE value to "DATA OFF" without changing the helper's value.
  assert.match(terminalJs, /lbl === 'STALE' \? 'DATA OFF' : lbl/);
  assert.match(terminalJs, /Rolling producer not running\. This does not mean absorption is confirmed or rejected\./);
  // Reclaim NOT STARTED tooltip clarifies the meaning in plain language.
  assert.match(terminalJs, /Price has not reclaimed the zone yet\. /);
});

test('matrix Absorb helper still returns STALE (value unchanged; only the display label maps)', () => {
  const absorbCompact = new Function(`${extractFn(terminalJs, '_fleetRadarAbsorbCompact')}\nreturn _fleetRadarAbsorbCompact;`)();
  assert.equal(absorbCompact({ ABSORB_STATUS: 'ABSORB_DATA_STALE' }), 'STALE');
});

// ── 10. No backend / gate / Telegram / ENTRY_READY mutation ──
test('the new human-first helpers are display-only (no fetch, no gate/score/telegram mutation)', () => {
  for (const fn of ['_radarHumanDecisionHtml', '_radarGateChecklistHtml', '_radarNextActionHtml', '_radarKeyLevelsHtml', '_radarDataSourceMatrixHtml', '_radarDecisionReason', '_radarReclaimGate', '_radarSafetyGate']) {
    const body = extractFn(terminalJs, fn);
    assert.doesNotMatch(body, /fetch\s*\(/, `${fn} must not fetch`);
    assert.doesNotMatch(body, /telegramEligible\s*=|SETUP_SCORE\s*=|EXECUTION_SCORE\s*=|STRICT_ABSORB_CONFIRMED\s*=|actionability\s*=/, `${fn} must not mutate a gate/score field`);
    assert.doesNotMatch(body, /\b(buy|sell|going long|go short)\b/i, `${fn} must not use trading-action wording`);
  }
});

test('CSS defines the new human-first section classes', () => {
  for (const cls of ['.radar-decision', '.radar-gate', '.radar-next', '.radar-klevels', '.radar-technical-details', '.radar-tech-group', '.radar-datasrc']) {
    assert.ok(terminalCss.includes(cls + '{') || terminalCss.includes(cls + ' ') || terminalCss.includes(cls + ','), `CSS must style ${cls}`);
  }
});
