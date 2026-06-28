// Phase 1/2 — GECKO degraded-state honesty guards.
//
// terminal.js ships as a classic <script> (touches the DOM at load, no
// exports) so the GECKO fetch/render paths can't be imported under
// node:test. These are scoped REGRESSION GUARDS on the specific degraded
// branches, pinning the rule: a degraded/failed GECKO state must never look
// like fresh live data.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const js = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

test('GECKO fetch failure with stale cards still on screen flags "last snapshot"', () => {
  // When the refresh throws but a prior _geckoData snapshot is still rendered,
  // the info line must say the visible cards are a retained snapshot, not live.
  assert.match(js, /Showing last snapshot · refresh failed/);
  // The note is gated on _geckoData existing (cards still visible); a cold
  // failure with no prior data falls through to the unavailable empty state.
  assert.match(js, /infoEl\.textContent = _geckoData\s*\?\s*`Showing last snapshot/);
  assert.match(js, /if \(!_geckoData\) container\.innerHTML = `<div class="gecko-empty">CoinGecko highlights unavailable/);
});

test('GECKO empty sections render an honest empty state, not a fake success', () => {
  // Zero sections → explicit "unavailable or empty" copy (or upstream warnings),
  // never an empty grid that reads as a successful render.
  assert.match(js, /_geckoData\.sections\.length === 0/);
  assert.match(js, /CoinGecko highlights unavailable or empty/);
});

test('GECKO degraded (ok:false) response is labelled DEGRADED, not LIVE', () => {
  // A parsed-but-degraded payload must show the amber DEGRADED pill, not green LIVE.
  assert.match(js, /statusEl\.textContent = 'DEGRADED'/);
  assert.match(js, /statusEl\.textContent = 'LIVE'/);
});
