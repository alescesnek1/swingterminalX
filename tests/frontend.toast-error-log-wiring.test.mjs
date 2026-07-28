// Guards the wiring between toast.js and js/error-log.js.
//
// The value of the central error log depends entirely on this handoff: 67
// existing `Toast.error(...)` call sites get their history for free ONLY if
// push() forwards to ErrorLog.record. If that link breaks, the UI keeps working
// and nothing looks wrong — the history just quietly stops filling up. Hence a
// behavioural test rather than a source grep.
//
// Both files are classic <script> IIFEs, so they are executed against a mock
// window/document instead of imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const errorLogSrc = fs.readFileSync(new URL('../apps/edge/public/js/error-log.js', import.meta.url), 'utf8');
const toastSrc = fs.readFileSync(new URL('../apps/edge/public/js/toast.js', import.meta.url), 'utf8');

// Minimal DOM: only what toast.js actually touches.
function makeElement(tag) {
  const el = {
    tagName: tag,
    style: { cssText: '', position: '', pointerEvents: '' },
    className: '',
    id: '',
    innerHTML: '',
    children: [],
    parentNode: null,
    classList: { add() {}, remove() {} },
    setAttribute() {},
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      return child;
    },
    querySelector: () => ({ addEventListener() {} }),
    querySelectorAll: () => [],
    addEventListener() {},
    remove() {},
    contains: (node) => el.children.includes(node),
  };
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] || null });
  return el;
}

function makeHarness() {
  const listeners = {};
  const body = makeElement('body');
  const win = {
    location: { href: 'https://terminal.example/app', origin: 'https://terminal.example' },
    performance: { now: () => 0 },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fetch: async () => ({ ok: true, status: 200, url: 'https://terminal.example/ok' }),
  };
  const doc = {
    body,
    createElement: (tag) => makeElement(tag),
  };
  const noopConsole = { log() {}, warn() {}, error() {}, table() {}, groupCollapsed() {}, groupEnd() {} };

  // Load order mirrors index.html: error-log.js first, then toast.js.
  // Classic browser IIFEs; the parameters shadow the globals so they can run
  // under node:test without a DOM.
  new Function('window', 'console', errorLogSrc)(win, noopConsole);
  new Function('window', 'document', 'console', 'setTimeout', toastSrc)(win, doc, noopConsole, () => 0);

  return { win, listeners, Toast: win.Toast, ErrorLog: win.ErrorLog };
}

test('both globals are installed in index.html load order', () => {
  const { win } = makeHarness();
  assert.equal(typeof win.ErrorLog, 'object');
  assert.equal(typeof win.Toast, 'object');
});

test('Toast.error forwards title, reason, endpoint and code into the error log', () => {
  const { Toast, ErrorLog } = makeHarness();
  Toast.error('Order book se nenačetl', 'HTTP 502 upstream', { endpoint: '/api/orderbook', code: 502 });

  const list = ErrorLog.entries();
  assert.equal(list.length, 1, 'an error toast must reach the central log');
  assert.equal(list[0].title, 'Order book se nenačetl');
  assert.equal(list[0].reason, 'HTTP 502 upstream', 'the WHY must survive the handoff');
  assert.equal(list[0].endpoint, '/api/orderbook');
  assert.equal(list[0].code, '502');
  assert.equal(list[0].source, 'toast');
});

test('Toast.warn is logged too', () => {
  const { Toast, ErrorLog } = makeHarness();
  Toast.warn('Stale data', 'snapshot is 9 minutes old', { endpoint: '/api/context' });
  assert.equal(ErrorLog.entries()[0].level, 'warn');
});

test('info and success toasts are NOT recorded as failures', () => {
  const { Toast, ErrorLog } = makeHarness();
  Toast.info('Loaded', 'all good');
  Toast.success('Saved', 'ok');
  assert.equal(ErrorLog.entries().length, 0);
});

test('a global error is recorded exactly once despite both files listening', () => {
  const { listeners, ErrorLog } = makeHarness();
  // error-log.js and toast.js each register an `error` listener: one to record,
  // one to show the toast. Fire both, as the browser would.
  const event = { message: 'x is not a function', filename: 'https://terminal.example/js/terminal.js', lineno: 7 };
  for (const fn of listeners.error) fn(event);

  const list = ErrorLog.entries();
  assert.equal(list.length, 1, 'skipLog must prevent the double entry');
  assert.equal(list[0].count, 1, 'and it must not be folded in as a repeat either');
  assert.equal(list[0].kind, 'uncaught');
});

test('a global unhandled rejection is recorded exactly once', () => {
  const { listeners, ErrorLog } = makeHarness();
  for (const fn of listeners.unhandledrejection) fn({ reason: { message: 'boom' } });

  const list = ErrorLog.entries();
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 1);
  assert.equal(list[0].kind, 'unhandled-rejection');
});

test('a toast still renders when ErrorLog is missing entirely', () => {
  // Defensive: toast.js must not depend on error-log.js having loaded.
  const listeners = {};
  const body = makeElement('body');
  const win = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  const doc = { body, createElement: (tag) => makeElement(tag) };
  const noopConsole = { log() {}, warn() {}, error() {} };
  new Function('window', 'document', 'console', 'setTimeout', toastSrc)(win, doc, noopConsole, () => 0);

  assert.equal(typeof win.Toast, 'object');
  const id = win.Toast.error('Still visible', 'no ErrorLog present');
  assert.ok(id, 'the visual toast must survive a missing ErrorLog');
});
