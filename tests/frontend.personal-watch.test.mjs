// Source guards for the Cockpit "Personal Alerts" settings UI (Phase 2 —
// UI wiring only). Proves the deployed frontend:
//   • loads the pure personal-watch.js module before terminal.js;
//   • talks to the already-live, already-reviewed Phase 1 backend using the
//     shared Supabase auth header, and wires GET/POST/DELETE;
//   • clears the raw chat id input only after a confirmed successful save;
//   • never persists a raw chat id to localStorage/sessionStorage;
//   • never introduces a Telegram-send, bot-token, or Binance/execution path;
//   • is explicit in its own copy that alerts are not active yet;
//   • renders only the server's masked value, never a raw id.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const personalWatchJs = fs.readFileSync(new URL('../apps/edge/public/js/personal-watch.js', import.meta.url), 'utf8');

test('index.html loads js/personal-watch.js before js/terminal.js', () => {
  const pwIdx = indexHtml.indexOf('js/personal-watch.js');
  const termIdx = indexHtml.indexOf('js/terminal.js');
  assert.ok(pwIdx !== -1, 'personal-watch.js must be referenced in index.html');
  assert.ok(termIdx !== -1, 'terminal.js must be referenced in index.html');
  assert.ok(pwIdx < termIdx, 'personal-watch.js must load before terminal.js');
});

test('terminal.js calls the live Phase 1 endpoint and wires GET/POST/DELETE', () => {
  assert.match(terminalJs, /PERSONAL_WATCH_ENDPOINT\s*=\s*['"]\/api\/cockpit-personal-watch-settings['"]/);
  assert.match(terminalJs, /fetch\(PERSONAL_WATCH_ENDPOINT,\s*\{\s*headers/); // GET
  assert.match(terminalJs, /method:\s*['"]POST['"][\s\S]{0,120}PERSONAL_WATCH_ENDPOINT|PERSONAL_WATCH_ENDPOINT[\s\S]{0,120}method:\s*['"]POST['"]/);
  assert.match(terminalJs, /method:\s*['"]DELETE['"][\s\S]{0,120}PERSONAL_WATCH_ENDPOINT|PERSONAL_WATCH_ENDPOINT[\s\S]{0,120}method:\s*['"]DELETE['"]/);
});

test('terminal.js uses the shared _getAuthHeaders() for every personal-watch call', () => {
  // Extract the personal-watch functions block and confirm each async call
  // path awaits the shared Supabase auth helper before fetching.
  const start = terminalJs.indexOf('async function refreshPersonalWatchSettings');
  const end = terminalJs.indexOf('function initCockpit()');
  assert.ok(start !== -1 && end !== -1 && start < end, 'personal-watch wiring block must exist before initCockpit()');
  const block = terminalJs.slice(start, end);
  const authCalls = block.match(/await _getAuthHeaders\(\)/g) || [];
  assert.ok(authCalls.length >= 3, 'GET, POST, and DELETE paths must each call _getAuthHeaders()');
  // Every fetch() to the endpoint must spread the auth headers into its request.
  const fetchCalls = block.match(/fetch\(PERSONAL_WATCH_ENDPOINT[\s\S]{0,220}?\}\);/g) || [];
  assert.ok(fetchCalls.length >= 3, 'expected a GET, POST, and DELETE fetch call');
  for (const call of fetchCalls) {
    assert.match(call, /\.\.\.authHeaders/, `fetch call must spread authHeaders: ${call.slice(0, 60)}...`);
  }
});

test('connectPersonalWatch clears the input ONLY after a confirmed successful save', () => {
  const start = terminalJs.indexOf('async function connectPersonalWatch');
  const end = terminalJs.indexOf('async function disconnectPersonalWatch');
  assert.ok(start !== -1 && end !== -1, 'connectPersonalWatch must exist');
  const block = terminalJs.slice(start, end);
  // input.value = '' must appear, and it must come after the response body
  // has been parsed and applied (i.e. after a successful `!r.ok` check has
  // already returned), not unconditionally right after the fetch call.
  const clearIdx = block.indexOf("input.value = ''");
  const notOkIdx = block.indexOf('if (!r.ok)');
  const renderIdx = block.indexOf('renderPersonalWatchPanel();');
  assert.ok(clearIdx !== -1, 'input must be cleared on success');
  assert.ok(notOkIdx !== -1 && clearIdx > notOkIdx, 'clear must happen after the failure branch, not before');
  assert.ok(renderIdx !== -1 && clearIdx > renderIdx, 'clear must happen after the model is applied (success path)');
});

test('no raw Telegram chat id is ever written to localStorage or sessionStorage', () => {
  for (const src of [terminalJs, personalWatchJs]) {
    assert.doesNotMatch(src, /(localStorage|sessionStorage)[^\n]{0,80}chat/i);
    assert.doesNotMatch(src, /(localStorage|sessionStorage)[^\n]{0,80}telegram/i);
  }
});

test('source guard: no Telegram-send, bot-token, or Binance/execution paths anywhere in the new UI code', () => {
  const forbidden = [
    /api\.telegram\.org/i,
    /\bBOT_TOKEN\b/,
    /TELEGRAM_BOT_TOKEN/,
    /\/order\b/,
    /\/sapi\b/, /\/dapi\b/, /\/fapi\b/,
    /BINANCE_API_KEY/, /BINANCE_API_SECRET/,
    /create-execution-intent/,
    /execution-intent/,
    /worker-session/,
    /ENTRY_READY/,
  ];
  for (const pat of forbidden) {
    assert.ok(!pat.test(personalWatchJs), `personal-watch.js must not contain ${pat}`);
  }
  // Scope the terminal.js guard to the personal-watch block only — terminal.js
  // is a large shared file whose OTHER sections legitimately reference
  // ENTRY_READY / execution-intent (RADAR, Bot Feed) elsewhere.
  const start = terminalJs.indexOf('const PERSONAL_WATCH_ENDPOINT');
  const end = terminalJs.indexOf('function initCockpit()');
  const block = terminalJs.slice(start, end);
  for (const pat of forbidden) {
    assert.ok(!pat.test(block), `personal-watch block in terminal.js must not contain ${pat}`);
  }
});

test('UI copy is explicit that alerts are not active yet and only personal IDs are supported', () => {
  assert.match(indexHtml, /alerts are not active yet/i);
  assert.match(indexHtml, /Personal direct chat IDs only/i);
  assert.match(indexHtml, /Group\/channel IDs are not supported yet/i);
});

test('the Personal Alerts card renders only the server-provided masked value, never a raw id', () => {
  const start = terminalJs.indexOf('function renderPersonalWatchPanel');
  const end = terminalJs.indexOf('async function refreshPersonalWatchSettings');
  assert.ok(start !== -1 && end !== -1, 'renderPersonalWatchPanel must exist');
  const block = terminalJs.slice(start, end);
  assert.match(block, /model\.statusText/);
  assert.doesNotMatch(block, /telegramChatId\b(?!Masked|Updated)/); // only masked/updated fields, never raw
  assert.doesNotMatch(block, /\.value\s*=\s*model\./); // never write a model field back into an input
});

test('index.html defines the Personal Alerts settings card inside the Cockpit shell', () => {
  const cockpitStart = indexHtml.indexOf('id="v-cockpit"');
  const pwStart = indexHtml.indexOf('id="cockpit-personal-watch"');
  assert.ok(cockpitStart !== -1 && pwStart !== -1);
  assert.ok(pwStart > cockpitStart, 'personal-watch card must live inside the cockpit view');
  assert.match(indexHtml, /id="cockpit-pw-chatid"/);
  assert.match(indexHtml, /id="cockpit-pw-connect"/);
  assert.match(indexHtml, /id="cockpit-pw-disconnect"/);
  assert.match(indexHtml, /id="cockpit-pw-status"/);
});
