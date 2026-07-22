// Source guards for wiring the already-built, already-tested browser
// orderbook merge (apps/edge/public/js/price-history-orderbook.js) into the
// RADAR "Price History Signals" section. That module was previously
// documented as intentionally NOT wired into the UI; this patch wires it,
// browser-side only, no server/DB/scheduler/trading-gate change.
//
// terminal.js is a classic <script> with no exports and the repo has no
// jsdom, so — following the exact convention already established in
// tests/frontend.radar-admin-price-history-panel.test.mjs — these are
// source-guard tests: they assert the exact code shapes exist rather than
// executing the DOM/fetch flow. The pure merge logic itself is already
// covered for real in tests/price-history-orderbook-browser.test.mjs
// (including drift-guards against the server helper).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const orderbookJs = fs.readFileSync(new URL('../apps/edge/public/js/price-history-orderbook.js', import.meta.url), 'utf8');

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start !== -1 && end !== -1 && start < end, `markers not found: "${startMarker}" .. "${endMarker}"`);
  return source.slice(start, end);
}

test('price-history-orderbook.js is loaded as a module script in index.html', () => {
  assert.match(indexHtml, /<script type="module" src="\/js\/price-history-orderbook\.js\?v=6h8"><\/script>/);
});

test('price-history-orderbook.js exposes its pure merge helper on window.__priceHistoryOrderbook', () => {
  assert.match(orderbookJs, /window\.__priceHistoryOrderbook\s*=\s*\{/);
  assert.match(orderbookJs, /combine:\s*combinePriceHistorySignalsWithOrderbook/);
});

test('the enrichment helper exists and reads the RADAR candidate PAIR, not the base symbol', () => {
  const fn = slice(terminalJs, 'async function _radarPhEnrichWithBrowserOrderbook', '\nasync function _refreshRadarPriceHistorySignals');
  assert.match(fn, /window\.__priceHistoryOrderbook/, 'must use the exposed browser orderbook module');
  assert.match(fn, /helpers\.combine\(/, 'must call the pure merge function');
  assert.match(fn, /\/api\/orderbook\?pair=\$\{encodeURIComponent\(normalizedPair\)\}&market=spot/, 'must fetch /api/orderbook with the pair, not the base symbol');
});

test('the enrichment fetch is GET-only', () => {
  const fn = slice(terminalJs, 'async function _radarPhEnrichWithBrowserOrderbook', '\nasync function _refreshRadarPriceHistorySignals');
  assert.doesNotMatch(fn, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i, 'must never send a mutating request');
});

test('the enrichment helper falls back to the untouched input on every failure path (no fake confidence)', () => {
  const fn = slice(terminalJs, 'async function _radarPhEnrichWithBrowserOrderbook', '\nasync function _refreshRadarPriceHistorySignals');
  assert.match(fn, /if\s*\(!normalizedPair\)\s*return json;/, 'missing pair must fall back to the untouched result');
  assert.match(fn, /if\s*\(!helpers[^)]*\)\s*return json;/, 'a missing/unloaded module must fall back to the untouched result');
  assert.match(fn, /if\s*\(!authHeaders\.Authorization\)\s*return json;/, 'signed-out must fall back to the untouched result');
  assert.match(fn, /if\s*\(!r\.ok\)\s*return json;/, 'a non-2xx /api/orderbook response must fall back to the untouched result');
  assert.match(fn, /catch\s*\{\s*return json;\s*\}/, 'an unparseable body must fall back to the untouched result');
  assert.match(fn, /catch\s*\(err\)\s*\{[\s\S]*?return json;/, 'a thrown error must fall back to the untouched result');
});

test('_refreshRadarPriceHistorySignals reads the pair from the slot and calls the enrichment only for a real OK result', () => {
  const fn = slice(terminalJs, 'async function _refreshRadarPriceHistorySignals', '\n// ── Symbol watch-list');
  assert.match(fn, /const pair = slot\.getAttribute\('data-ph-pair'\)/, 'must read the raw pair from the slot');
  assert.match(fn, /json\.status === 'OK' && json\.orderbookMode === 'external_browser_required'/, 'must gate enrichment on a real OK-status, browser-required result');
  assert.match(fn, /json = await _radarPhEnrichWithBrowserOrderbook\(json, pair\)/, 'must call the enrichment helper with the pair, not the base');
  // Base symbol still drives the price-history endpoint query — unchanged by this patch.
  assert.match(fn, /ADMIN_PRICE_HISTORY_SIGNALS_ENDPOINT \+ '\?symbol=' \+ encodeURIComponent\(base\)/);
});

test('enrichment sits inside the existing per-base cache/dedupe guard — no extra fetch spam on repeated renders', () => {
  const fn = slice(terminalJs, 'async function _refreshRadarPriceHistorySignals', '\n// ── Symbol watch-list');
  // The enrichment call must appear strictly AFTER the cache-hit short-circuit
  // and the loadingBase dedupe check — i.e. inside the single guarded fetch
  // pass, not reachable on a repaint-from-cache path.
  const cacheGuardIdx = fn.indexOf('_radarPhCache.base === base && _radarPhCache.model');
  const dedupeGuardIdx = fn.indexOf("_radarPhCache.loadingBase === base) return;");
  const enrichIdx = fn.indexOf('_radarPhEnrichWithBrowserOrderbook(json, pair)');
  assert.ok(cacheGuardIdx !== -1 && dedupeGuardIdx !== -1 && enrichIdx !== -1);
  assert.ok(cacheGuardIdx < enrichIdx, 'enrichment must be unreachable on a cache-hit repaint');
  assert.ok(dedupeGuardIdx < enrichIdx, 'enrichment must be unreachable on a deduped concurrent fetch');
  // No poll timer anywhere drives either the refresh or the enrichment.
  const pollLoops = terminalJs.match(/set(Interval|Timeout)\([^)]*(_refreshRadarPriceHistorySignals|_radarPhEnrichWithBrowserOrderbook)/g) || [];
  assert.equal(pollLoops.length, 0, 'must never be driven by a poll timer');
});

test('no buy/sell/long/short wording in the new enrichment wiring or the browser orderbook module', () => {
  const fn = slice(terminalJs, 'async function _radarPhEnrichWithBrowserOrderbook', '\nasync function _refreshRadarPriceHistorySignals');
  assert.doesNotMatch(fn + orderbookJs, /\b(buy|sell|long|short)\b/i);
});

test('the enrichment never touches trading gates, radar-context, or execution state', () => {
  const fn = slice(terminalJs, 'async function _radarPhEnrichWithBrowserOrderbook', '\nasync function _refreshRadarPriceHistorySignals');
  assert.doesNotMatch(fn, /radar-context/);
  assert.doesNotMatch(fn, /ENTRY_READY/);
  assert.doesNotMatch(fn, /pushScannerContextToRadar/);
});

test('no write call, DB import, or scheduler/cron reference in the browser orderbook module', () => {
  assert.doesNotMatch(orderbookJs, /writeMarketPriceSnapshot|_price-history-writer|_db\.mjs|cron|scheduler/i);
});
