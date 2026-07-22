// Guards for the Cockpit RADAR data-visibility pass:
//   1) STALE is explained, not bare: a system-wide microstructure-status note
//      (producer off / stale static snapshot) makes clear the Absorb column's
//      "STALE" is a data-source state, not a per-coin reclaim verdict or a bug.
//   2) The Cockpit import panel shows the SAME price-history / reclaim /
//      absorption read the RADAR Focus card has, with the distinct sources
//      labeled — advisory only, no gate/score/Telegram change.
//   3) Asset cache-bust version was bumped so returning users get the new JS.
//
// Executable where possible (brace-extract + run in isolation); the pure
// backend price-history model is imported from its real module.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { radarBackendPriceHistoryModel } from '../apps/edge/public/js/price-history-signals-panel.js';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');

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

const daysAgoIso = (d) => new Date(Date.now() - d * 86400000).toISOString();

// ── 1) STALE explanation ─────────────────────────────────────

function loadStaleFns() {
  const body = ['_fleetRadarStaleContextText', '_radarMicrostructureStatusNote'].map((n) => extractFn(terminalJs, n)).join('\n\n');
  const factory = new Function(`const _esc = (s) => String(s == null ? '' : s);\n${body}\nreturn { _fleetRadarStaleContextText, _radarMicrostructureStatusNote };`);
  return factory();
}

test('stale-context: reports snapshot age + producer-off from real fields', () => {
  const { _fleetRadarStaleContextText } = loadStaleFns();
  const txt = _fleetRadarStaleContextText({
    staticMicrostructure: { receivedAt: daysAgoIso(34) },
    microstructureDiagnostics: { microstructureEnabled: false },
  });
  assert.match(txt, /34d old/);
  assert.match(txt, /producer is not running/i);
});

test('stale-context: says nothing it cannot prove (fresh + enabled => empty)', () => {
  const { _fleetRadarStaleContextText } = loadStaleFns();
  assert.equal(_fleetRadarStaleContextText({ staticMicrostructure: { receivedAt: daysAgoIso(0) }, microstructureDiagnostics: { microstructureEnabled: true } }), '');
  assert.equal(_fleetRadarStaleContextText({}), '');
});

test('micro-status note: shows a visible system-wide STALE explanation when producer is off', () => {
  const { _radarMicrostructureStatusNote } = loadStaleFns();
  const html = _radarMicrostructureStatusNote({
    staticMicrostructure: { receivedAt: daysAgoIso(34), stale: true, providerStatus: 'stale' },
    microstructureDiagnostics: { microstructureEnabled: false },
  });
  assert.match(html, /Strict rolling absorption is STALE for all candidates/);
  assert.match(html, /data-source state, not a per-coin signal/);
  // Must reassure it changes no gate.
  assert.match(html, /does not change reclaim, ENTRY_READY, Telegram/i);
});

test('micro-status note: empty when microstructure is actually live', () => {
  const { _radarMicrostructureStatusNote } = loadStaleFns();
  const html = _radarMicrostructureStatusNote({
    staticMicrostructure: { receivedAt: daysAgoIso(0), stale: false, providerStatus: 'present' },
    microstructureDiagnostics: { microstructureEnabled: true },
  });
  assert.equal(html, '');
});

// ── 2) Cockpit RADAR data insight ────────────────────────────

function loadInsight() {
  const body = ['_cpRadarDataInsightHtml', '_fleetRadarReclaimCompact', '_fleetRadarAbsorbCompact', '_fleetRadarStaleContextText']
    .map((n) => extractFn(terminalJs, n)).join('\n\n');
  const factory = new Function('window', '_phsHelpers', '_esc', '_fleetFmtRadarValue', `${body}\nreturn _cpRadarDataInsightHtml;`);
  const _esc = (s) => String(s == null ? '' : s);
  const fmt = (v) => (v == null ? '--' : String(Math.round(v)));
  const phHelpers = () => ({ backendModel: radarBackendPriceHistoryModel });
  const win = { Fleet: { data: { tradingRadar: {
    staticMicrostructure: { receivedAt: daysAgoIso(34), stale: true, providerStatus: 'stale' },
    microstructureDiagnostics: { microstructureEnabled: false },
  } } } };
  return factory(win, phHelpers, _esc, fmt);
}

const TOP5_RECLAIM = {
  symbol: 'ANSEMUSDT', SETUP_SCORE: 40, EXECUTION_SCORE: 23, FINAL_CONFIDENCE: 30,
  RECLAIM_STATUS: 'RECLAIM_NOT_STARTED', STRICT_ABSORB_STATUS: 'ABSORB_DATA_STALE',
  priceHistoryScoreAdjustment: 2, priceHistoryUsedForScoring: true,
  priceHistoryGateSupport: { reclaim: true, absorption: false },
  priceHistoryContext: { status: 'OK', points: 20, reclaim: { status: 'CONFIRMED', reason: 'held' }, absorption: { status: 'NOT_CONFIRMED', mode: 'history_only', confidence: 'low' } },
  blockedBy: 'waiting for flush confirmation', nextRequiredConfirmation: 'needs long flush confirmation',
};
const NON_TOP5 = { symbol: 'LITUSDT', SETUP_SCORE: 24, EXECUTION_SCORE: 30, RECLAIM_STATUS: 'RECLAIM_NOT_STARTED', STRICT_ABSORB_STATUS: 'ABSORB_DATA_STALE', blockedBy: 'provider unavailable' };

test('cockpit insight: labels market reclaim and price-history reclaim as distinct sources', () => {
  const html = loadInsight()(TOP5_RECLAIM);
  assert.match(html, /market: NOT STARTED/);           // market structural reclaim
  assert.match(html, /price-history:/);                 // separate source
  assert.match(html, /strict rolling: STALE/);          // strict absorb source
  assert.match(html, /history-only:/);                  // history-only absorb source
});

test('cockpit insight: shows backend PH setup support (+2) traceably', () => {
  const html = loadInsight()(TOP5_RECLAIM);
  assert.match(html, /\+2 setup/);
  assert.match(html, /\+2 reclaim/);
});

test('cockpit insight: STALE strict absorb carries the system-wide context', () => {
  const html = loadInsight()(TOP5_RECLAIM);
  assert.match(html, /34d old/);
  assert.match(html, /producer is not running/i);
});

test('cockpit insight: non-top-five candidate is honest, not faked', () => {
  const html = loadInsight()(NON_TOP5);
  assert.match(html, /Not in the top-five price-history-scored set/);
});

test('cockpit insight: advisory only + never claims flow/OI/funding from price-history', () => {
  const html = loadInsight()(TOP5_RECLAIM);
  assert.match(html, /does not change server gate \/ Telegram/i);
  assert.match(html, /Flow \/ OI \/ funding \/ live orderbook/);
  assert.doesNotMatch(html, /\b(buy|sell|going long|go short)\b/i);
});

test('cockpit insight: returns empty for stale/null selection (never renders a phantom card)', () => {
  const fn = loadInsight();
  assert.equal(fn(null), '');
  assert.equal(fn({ __stale: true, symbol: 'X' }), '');
});

// ── source-guard: wiring is present where it must be ─────────

test('cockpit insight block is rendered in the RADAR import card', () => {
  const start = terminalJs.indexOf('function _cpRadarFocusHtml');
  const end = terminalJs.indexOf('\nfunction ', start + 10);
  const body = terminalJs.slice(start, end);
  assert.match(body, /\$\{_cpRadarDataInsightHtml\(f\)\}/, 'insight block must be emitted in the import card');
});

test('cockpit insight reads the shared backend model and starts no fetch', () => {
  const body = extractFn(terminalJs, '_cpRadarDataInsightHtml');
  assert.match(body, /backendModel\(f\)/);
  assert.doesNotMatch(body, /fetch\(/, 'cockpit insight must not perform a network fetch');
});

test('micro-status note is emitted inside the RADAR focus card', () => {
  assert.match(terminalJs, /\$\{_radarMicrostructureStatusNote\(radar\)\}/);
});

// ── 3) Asset cache-bust ──────────────────────────────────────

test('cache-bust: the stale ?v=6h8 version is gone from index.html', () => {
  assert.doesNotMatch(indexHtml, /\?v=6h8\b/, 'old cache-bust token must be bumped so returning users get the new JS/CSS');
});

test('cache-bust: all versioned assets share exactly one bumped version token', () => {
  const versions = Array.from(indexHtml.matchAll(/\?v=([a-z0-9]+)/g)).map((m) => m[1]);
  assert.ok(versions.length >= 10, 'expected the full set of versioned asset tags');
  const unique = Array.from(new Set(versions));
  assert.equal(unique.length, 1, `all asset versions must match; found: ${unique.join(', ')}`);
  assert.notEqual(unique[0], '6h8');
});

test('cache-bust css: new insight/status classes are styled', () => {
  assert.match(terminalCss, /\.cp-radar-insight\b/);
  assert.match(terminalCss, /\.radar-micro-status-note\b/);
});
