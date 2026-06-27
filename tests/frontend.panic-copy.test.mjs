// Batch A — PANIC copy honesty.
//
// The PANIC column is a derived heuristic (calcPanic, with
// calcStaticPanicProxy as the first-paint fallback). The user-facing
// copy must describe it as a proxy / attention signal and must NOT
// claim a precise live order-flow / institutional formula that isn't
// wired. These tests pin the copy to the actual implementation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

test('PANIC copy frames the column as a pressure proxy / attention signal', () => {
  assert.match(html, /pressure proxy/i);
  assert.match(html, /attention signal/i);
});

test('PANIC copy explicitly states it is not live order-flow / institutional', () => {
  // The disclaimer must be present somewhere in the panic copy.
  assert.match(html, /not\s+live\s+order-flow/i);
  assert.match(html, /not entry confirmation|not as entry confirmation|never as entry confirmation/i);
});

test('PANIC copy no longer makes the old misleading claims', () => {
  assert.doesNotMatch(html, /Composite math blend of 24h Volume Delta/);
  assert.doesNotMatch(html, /Composite mathematical blend of three orthogonal/);
  assert.doesNotMatch(html, /Institutional <em>Orderbook Sniping<\/em>/);
  assert.doesNotMatch(html, /Until live WebSocket frames arrive/);
  // The authoritative weighted formula block is gone.
  assert.doesNotMatch(html, /panic = 0\.5 · sign/);
});

test('PANIC copy describes the actual proxy inputs (24h move + relative volume)', () => {
  // Matches calcStaticPanicProxy: blends 24h move with relative volume.
  assert.match(html, /24h-move \+ relative-volume|24h move \+ relative volume/i);
});

test('the proxy implementation the copy describes still exists and is unchanged', () => {
  // calcStaticPanicProxy is the fallback the copy now references.
  assert.match(js, /function calcStaticPanicProxy/);
  // Pin the proxy blend weights (0.7 price + 0.3 volume) so copy & code stay in sync.
  assert.match(js, /0\.7 \* priceTerm \+ 0\.3 \* volTerm/);
  // The live blend (calcPanic) is untouched — still the same weighted heuristic.
  assert.match(js, /const PANIC_ALPHA = 0\.5;/);
  assert.match(js, /const PANIC_BETA\s*= 0\.3;/);
  assert.match(js, /const PANIC_GAMMA = 0\.2;/);
});
