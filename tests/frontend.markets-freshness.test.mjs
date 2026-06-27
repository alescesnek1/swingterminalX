// Batch B — frontend source/freshness badge honesty.
//
// Source-level assertions (consistent with the repo's other frontend.*
// tests, which grep the shipped bundle) guarding the rule: stale or
// failed market data must NOT wear the green LIVE badge.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const js = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');

test('source label is no longer hardcoded to BINANCE-LIVE', () => {
  assert.doesNotMatch(js, /SRC\s*=\s*['"]BINANCE-LIVE['"]/);
});

test('frontend reads freshness headers off the markets response', () => {
  assert.match(js, /X-Served-From/);
  assert.match(js, /X-Stale/);
  assert.match(js, /X-Generated-At/);
  assert.match(js, /window\.__marketsFreshness/);
});

test('fresh data renders LIVE, stale renders STALE', () => {
  // SRC is chosen from the freshness flag, not assumed live.
  assert.match(js, /SRC\s*=\s*window\.__marketsFreshness\.stale\s*\?\s*['"]STALE['"]\s*:\s*['"]LIVE['"]/);
});

test('badge decision is delegated to the pure freshness-badge module (with fallback)', () => {
  // Phase 4: the live/stale/error mapping moved to freshness-badge.js (real
  // behavior coverage in frontend.freshness-badge-behavior.test.mjs). terminal.js
  // calls it via window.freshnessBadge and keeps a safe inline fallback.
  assert.match(js, /window\.freshnessBadge\(fresh, SRC\)/);
  assert.match(js, /typeof window\.freshnessBadge === 'function'/);
  assert.match(js, /srcb\.className = 'sbadge ' \+ badge\.cls/);
});

test('degraded badge classes exist in CSS', () => {
  assert.match(css, /\.s-stale\s*\{/);
  assert.match(css, /\.s-error\s*\{/);
});

test('freshness uses true snapshot age, not only wall-clock', () => {
  assert.match(js, /fresh\.generatedAt/);
  assert.match(js, /Date\.now\(\)\s*-\s*fresh\.generatedAt/);
});

test('noisy per-refresh markets dump is guarded behind a debug flag', () => {
  // The full-array console dump must not run unconditionally in prod.
  assert.doesNotMatch(js, /^\s*console\.log\("🔍 Data from \/api\/markets:/m);
  assert.match(js, /window\.__DEBUG\)\s*console\.log\("🔍 Data from \/api\/markets:/);
});

test('critical error logging is preserved', () => {
  // We only guarded the noisy dump — real failures still log.
  assert.match(js, /console\.error\('Data fetch err:'/);
});
