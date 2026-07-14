// Source guards for the Cockpit symbol watch-list UI (Phase 3 — management
// only, no sending). Proves the deployed frontend:
//   • talks to /api/cockpit-personal-watch-list via the shared auth header,
//     wiring GET/POST/DELETE;
//   • has a symbol input, an add control, a rendered list, and a per-chip
//     remove path;
//   • keeps system-controlled delivery framing and offers no watch-all
//     toggle and no custom-condition UI;
//   • never persists watches or chat ids to localStorage/sessionStorage;
//   • introduces no Telegram-send / bot-token / Binance / execution path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const personalWatchJs = fs.readFileSync(new URL('../apps/edge/public/js/personal-watch.js', import.meta.url), 'utf8');

// Isolate the watch-list wiring block from the large shared terminal.js so the
// guards below only inspect the new code, not unrelated RADAR/Bot-Feed content.
function watchBlock() {
  const start = terminalJs.indexOf('const PERSONAL_WATCH_LIST_ENDPOINT');
  const end = terminalJs.indexOf('function initCockpit()');
  assert.ok(start !== -1 && end !== -1 && start < end, 'watch-list wiring block must exist before initCockpit()');
  return terminalJs.slice(start, end);
}

test('terminal.js calls the watch-list endpoint and wires GET/POST/DELETE via auth headers', () => {
  assert.match(terminalJs, /PERSONAL_WATCH_LIST_ENDPOINT\s*=\s*['"]\/api\/cockpit-personal-watch-list['"]/);
  const block = watchBlock();
  const fetchCalls = block.match(/fetch\(PERSONAL_WATCH_LIST_ENDPOINT[\s\S]{0,260}?\}\);/g) || [];
  assert.ok(fetchCalls.length >= 3, 'expected GET, POST, and DELETE fetch calls');
  for (const call of fetchCalls) {
    assert.match(call, /\.\.\.authHeaders/, `watch fetch must spread authHeaders: ${call.slice(0, 60)}...`);
  }
  assert.match(block, /method:\s*['"]POST['"]/);
  assert.match(block, /method:\s*['"]DELETE['"]/);
  const authCalls = block.match(/await _getAuthHeaders\(\)/g) || [];
  assert.ok(authCalls.length >= 3, 'GET/POST/DELETE must each call _getAuthHeaders()');
});

test('add fires only after client validation, and clears the input after a successful add', () => {
  const block = watchBlock();
  const start = block.indexOf('async function addPersonalWatchSymbol');
  const end = block.indexOf('async function removePersonalWatchSymbol');
  const addFn = block.slice(start, end);
  const validateIdx = addFn.indexOf('helpers.validateWatchSymbol(input.value)');
  const fetchIdx = addFn.indexOf('fetch(PERSONAL_WATCH_LIST_ENDPOINT');
  const notOkIdx = addFn.indexOf('if (!r.ok)');
  const clearIdx = addFn.indexOf("input.value = ''");
  assert.ok(validateIdx !== -1 && fetchIdx !== -1 && validateIdx < fetchIdx, 'must validate before fetching');
  assert.ok(clearIdx !== -1 && notOkIdx !== -1 && clearIdx > notOkIdx, 'input clear must be after the failure branch (success only)');
});

test('the watch-list card renders symbols only (no chat id) and provides a remove path', () => {
  const block = watchBlock();
  const start = block.indexOf('function renderPersonalWatchList');
  const end = block.indexOf('async function refreshPersonalWatchList');
  const renderFn = block.slice(start, end);
  assert.match(renderFn, /w\.symbol/);
  assert.match(renderFn, /data-pw-remove/);
  assert.doesNotMatch(renderFn, /telegramChatId|chatId/i); // never render a chat id in the list
  // Remove is wired via delegation on the list container.
  assert.match(terminalJs, /\[data-pw-remove\]/);
  assert.match(terminalJs, /removePersonalWatchSymbol/);
});

test('index.html has the watch input, add button, list container, and count', () => {
  assert.match(indexHtml, /id="cockpit-pw-symbol"/);
  assert.match(indexHtml, /id="cockpit-pw-watch-add"/);
  assert.match(indexHtml, /id="cockpit-pw-watchlist"/);
  assert.match(indexHtml, /id="cockpit-pw-watchcount"/);
  // Reuses the existing symbol datalist for autocomplete.
  assert.match(indexHtml, /id="cockpit-pw-symbol"[^>]*list="cockpit-symbol-list"/);
});

test('UI copy stays explicit: system-controlled, selected-only, no watch-all, no custom conditions', () => {
  assert.match(indexHtml, /Personal alerts are prepared/i);
  assert.match(indexHtml, /controlled by system safety settings/i);
  assert.match(indexHtml, /Selected symbols only/i);
  assert.match(indexHtml, /no "watch all"/i);
  assert.match(indexHtml, /no custom conditions/i);
  // No watch-all toggle control of any kind.
  assert.doesNotMatch(indexHtml, /id="cockpit-pw-watch-all"/);
  assert.doesNotMatch(indexHtml, /watch-all-toggle/i);
});

test('no watch/chat data is persisted via an actual localStorage/sessionStorage call', () => {
  // Target real storage API usage (setItem/getItem/removeItem/[...]) whose
  // key/value references chat/telegram/watch — not prose in comments.
  const persist = /(localStorage|sessionStorage)\s*(\.\s*(set|get|remove)Item\s*\(|\[)[^\n]{0,80}(chat|telegram|watch)/i;
  // personal-watch.js is pure and must not touch storage at all.
  assert.doesNotMatch(personalWatchJs, /(localStorage|sessionStorage)/);
  // The watch-list wiring block in terminal.js must not persist watch/chat data.
  assert.doesNotMatch(watchBlock(), persist);
});

test('source guard: no Telegram-send / bot-token / Binance / execution paths in the watch-list code', () => {
  const forbidden = [
    /api\.telegram\.org/i,
    /\bBOT_TOKEN\b/, /TELEGRAM_BOT_TOKEN/,
    /\/order\b/, /\/sapi\b/, /\/dapi\b/, /\/fapi\b/,
    /BINANCE_API_KEY/, /BINANCE_API_SECRET/,
    /create-execution-intent/, /execution-intent/, /worker-session/,
    /ENTRY_READY/,
  ];
  for (const pat of forbidden) {
    assert.ok(!pat.test(personalWatchJs), `personal-watch.js must not contain ${pat}`);
    assert.ok(!pat.test(watchBlock()), `watch-list block in terminal.js must not contain ${pat}`);
  }
});
