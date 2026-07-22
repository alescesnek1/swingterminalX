// Source guards for the Cockpit "Admin price-history signals" diagnostics
// panel (Phase 1 — read-only UI wiring only, BTC/ETH). Proves the deployed
// frontend:
//   • loads the pure price-history-signals-panel.js module before terminal.js;
//   • only ever fetches via GET (no POST/PUT/DELETE to the admin endpoint);
//   • uses the shared Supabase auth header, same as every other admin/
//     authenticated call in terminal.js;
//   • is gated on window.__isAdmin before rendering/fetching at all;
//   • is only fetched on Cockpit tab open, not on a poll timer;
//   • never contains buy/sell/long/short wording anywhere in the wiring;
//   • never wires into RADAR, trading, or execution code paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const panelJs = fs.readFileSync(new URL('../apps/edge/public/js/price-history-signals-panel.js', import.meta.url), 'utf8');

test('index.html loads js/price-history-signals-panel.js before js/terminal.js', () => {
  const panelIdx = indexHtml.indexOf('js/price-history-signals-panel.js');
  const termIdx = indexHtml.indexOf('js/terminal.js');
  assert.ok(panelIdx !== -1, 'price-history-signals-panel.js must be referenced in index.html');
  assert.ok(termIdx !== -1, 'terminal.js must be referenced in index.html');
  assert.ok(panelIdx < termIdx, 'price-history-signals-panel.js must load before terminal.js');
});

test('index.html declares the admin diagnostics box hidden by default', () => {
  const boxIdx = indexHtml.indexOf('id="cockpit-admin-price-history"');
  assert.ok(boxIdx !== -1, 'diagnostics <details> box must exist in index.html');
  const tag = indexHtml.slice(indexHtml.lastIndexOf('<details', boxIdx), boxIdx + 200);
  assert.match(tag, /\bhidden\b/, 'diagnostics box must start hidden');
});

test('terminal.js gates the panel on window.__isAdmin before doing anything', () => {
  const start = terminalJs.indexOf('async function refreshAdminPriceHistorySignals');
  const end = terminalJs.indexOf('// ── Symbol watch-list', start);
  assert.ok(start !== -1 && end !== -1 && start < end, 'refreshAdminPriceHistorySignals must exist');
  const fnBody = terminalJs.slice(start, end);
  assert.match(fnBody, /if\s*\(\s*!window\.__isAdmin\s*\)\s*return;/, 'must early-return for non-admins before any fetch');
});

test('terminal.js only ever issues GET requests to the admin price-history endpoint', () => {
  const start = terminalJs.indexOf('async function refreshAdminPriceHistorySignals');
  const end = terminalJs.indexOf('// ── Symbol watch-list', start);
  assert.ok(start !== -1 && end !== -1 && start < end, 'admin price-history block must exist');
  const block = terminalJs.slice(start, end);
  assert.match(block, /ADMIN_PRICE_HISTORY_SIGNALS_ENDPOINT/, 'must reference the endpoint constant');
  assert.doesNotMatch(block, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i, 'must never send a mutating request');
  assert.match(block, /await _getAuthHeaders\(\)/, 'must use the shared Supabase auth header helper');
  assert.match(block, /\.\.\.authHeaders/, 'fetch call must spread authHeaders');
});

test('the endpoint constant is exactly GET /api/admin-price-history-signals', () => {
  assert.match(terminalJs, /ADMIN_PRICE_HISTORY_SIGNALS_ENDPOINT\s*=\s*['"]\/api\/admin-price-history-signals['"]/);
});

test('the panel is only refreshed on Cockpit tab open, not a poll interval', () => {
  const cockpitBranch = terminalJs.match(/if \(activeViewName === 'cockpit'\)[\s\S]{0,260}?\}\);/);
  assert.ok(cockpitBranch, 'cockpit tab-open branch must exist in sv()');
  assert.match(cockpitBranch[0], /refreshAdminPriceHistorySignals\(\);/, 'must be called from the cockpit tab-open branch');
});

test('BTC and ETH are the only symbols queried in Phase 1', () => {
  assert.match(terminalJs, /ADMIN_PRICE_HISTORY_SYMBOLS\s*=\s*\[\s*['"]BTC['"]\s*,\s*['"]ETH['"]\s*\]/);
});

test('no buy/sell/long/short wording anywhere in the new panel wiring or module', () => {
  const start = terminalJs.indexOf('// ── ADMIN PRICE-HISTORY SIGNALS');
  const end = terminalJs.indexOf('// ── Symbol watch-list', start);
  const block = terminalJs.slice(start, end) + panelJs;
  assert.doesNotMatch(block, /\b(buy|sell|long|short)\b/i);
});

test('the panel module is never imported by any RADAR/trading/execution file', () => {
  // Confirms this Phase-1 diagnostics module stays isolated: it is only
  // referenced from index.html (script tag) and its own test files.
  const otherJsFiles = fs.readdirSync(new URL('../apps/edge/public/js/', import.meta.url))
    .filter((f) => f.endsWith('.js') && f !== 'price-history-signals-panel.js' && f !== 'terminal.js');
  for (const file of otherJsFiles) {
    const content = fs.readFileSync(new URL(`../apps/edge/public/js/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(content, /price-history-signals-panel/, `${file} must not import the admin diagnostics module`);
  }
});
