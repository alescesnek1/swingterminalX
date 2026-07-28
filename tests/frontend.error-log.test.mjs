// Behaviour tests for the central client error log (js/error-log.js).
//
// This is the file the owner relies on to answer "what broke and why", so the
// parts that could silently betray that are covered here: URL redaction (a
// request URL in this app can carry a token), the fetch interceptor's
// pass-through fidelity (it must never change what a caller receives), and the
// dedupe that keeps a polling failure from burying everything else.
//
// error-log.js is a classic <script> IIFE that touches `window` at load, so it
// is executed here against a mock window instead of being imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../apps/edge/public/js/error-log.js', import.meta.url), 'utf8');

function makeHarness(overrides = {}) {
  const store = new Map();
  const listeners = {};
  const consoleCalls = [];
  const fetchCalls = [];

  const win = {
    location: { href: 'https://terminal.example/app', origin: 'https://terminal.example' },
    performance: { now: () => 1000 },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fetch: overrides.fetch || (async () => ({ ok: true, status: 200, url: 'https://terminal.example/ok' })),
    ...overrides.window,
  };

  const fakeConsole = {
    log: (...a) => consoleCalls.push(['log', ...a]),
    warn: (...a) => consoleCalls.push(['warn', ...a]),
    error: (...a) => consoleCalls.push(['error', ...a]),
    table: (...a) => consoleCalls.push(['table', ...a]),
    groupCollapsed: (...a) => consoleCalls.push(['groupCollapsed', ...a]),
    groupEnd: () => consoleCalls.push(['groupEnd']),
  };

  // The file under test is a classic browser IIFE; shadowing `window`/`console`
  // as parameters is the only way to run it under node:test without a DOM.
  // (`no-new-func` is off for tests/** for exactly this — see eslint.config.mjs.)
  new Function('window', 'console', source)(win, fakeConsole);

  return { win, store, listeners, consoleCalls, fetchCalls, ErrorLog: win.ErrorLog };
}

test('installs the console API on window', () => {
  const { win } = makeHarness();
  assert.equal(typeof win.ErrorLog, 'object');
  assert.equal(typeof win.errors, 'function');
  for (const fn of ['summary', 'clear', 'last', 'forEndpoint', 'json', 'entries']) {
    assert.equal(typeof win.errors[fn], 'function', `errors.${fn}() must exist`);
  }
});

test('a recorded failure keeps its reason', () => {
  const { ErrorLog } = makeHarness();
  ErrorLog.record({ level: 'error', title: 'Order book failed', reason: 'HTTP 502 from upstream', endpoint: '/api/orderbook' });
  const [entry] = ErrorLog.entries();
  assert.equal(entry.title, 'Order book failed');
  assert.equal(entry.reason, 'HTTP 502 from upstream');
  assert.equal(entry.endpoint, '/api/orderbook');
});

test('a missing reason is explicit, never blank', () => {
  const { ErrorLog } = makeHarness();
  ErrorLog.record({ level: 'error', title: 'Something broke' });
  assert.equal(ErrorLog.entries()[0].reason, '(no reason given)');
});

// ── URL redaction ──

test('redaction strips unknown query params but keeps diagnostic ones', () => {
  const { ErrorLog } = makeHarness();
  ErrorLog.record({
    title: 'x',
    reason: 'y',
    endpoint: '/api/markets?symbol=BTCUSDT&access_token=super-secret-value&limit=50',
  });
  const { endpoint } = ErrorLog.entries()[0];
  assert.ok(!endpoint.includes('super-secret-value'), `token leaked into the log: ${endpoint}`);
  assert.ok(!endpoint.includes('access_token'), `token param name leaked: ${endpoint}`);
  assert.ok(endpoint.includes('symbol=BTCUSDT'), 'the diagnostic param must survive');
  assert.ok(endpoint.includes('limit=50'));
  assert.ok(endpoint.includes('redacted'), 'the entry must say something was dropped');
});

test('redaction never leaks a token even from an unparseable url', () => {
  const { ErrorLog } = makeHarness();
  ErrorLog.record({ title: 'x', reason: 'y', endpoint: 'ht!tp://%%%/bad?token=leak-me' });
  assert.ok(!ErrorLog.entries()[0].endpoint.includes('leak-me'));
});

test('a same-origin url is stored as a bare path, a foreign one keeps its origin', () => {
  const { ErrorLog } = makeHarness();
  ErrorLog.record({ title: 'a', reason: 'r', endpoint: 'https://terminal.example/api/context' });
  ErrorLog.record({ title: 'b', reason: 'r', endpoint: 'https://api.binance.com/api/v3/depth' });
  const [own, foreign] = ErrorLog.entries();
  assert.equal(own.endpoint, '/api/context');
  assert.equal(foreign.endpoint, 'https://api.binance.com/api/v3/depth');
});

// ── dedupe ──

test('identical repeated failures fold into one row with a count', () => {
  const { ErrorLog } = makeHarness();
  for (let i = 0; i < 5; i += 1) {
    ErrorLog.record({ level: 'warn', kind: 'http', title: 'HTTP 502', reason: '502 Bad Gateway', endpoint: '/api/orderbook', code: 502 });
  }
  const list = ErrorLog.entries();
  assert.equal(list.length, 1, 'a polling failure must not flood the log');
  assert.equal(list[0].count, 5);
});

test('a DIFFERENT failure is never folded into the previous one', () => {
  const { ErrorLog } = makeHarness();
  ErrorLog.record({ title: 'HTTP 502', reason: '502 Bad Gateway', endpoint: '/api/orderbook', code: 502 });
  ErrorLog.record({ title: 'HTTP 404', reason: '404 Not Found', endpoint: '/api/orderbook', code: 404 });
  assert.equal(ErrorLog.entries().length, 2);
});

// ── fetch interceptor ──

test('interceptor passes a successful response through untouched', async () => {
  const expected = { ok: true, status: 200, url: 'https://terminal.example/ok' };
  const { win, ErrorLog } = makeHarness({ fetch: async () => expected });
  const got = await win.fetch('/api/markets');
  assert.equal(got, expected, 'the caller must receive the exact same Response object');
  assert.equal(ErrorLog.entries().length, 0, 'a 200 is not a failure');
});

test('interceptor records a non-OK response and still returns it', async () => {
  const res = { ok: false, status: 502, statusText: 'Bad Gateway', url: 'https://terminal.example/api/orderbook' };
  const { win, ErrorLog } = makeHarness({ fetch: async () => res });
  const got = await win.fetch('/api/orderbook?symbol=BTCUSDT');
  assert.equal(got, res, 'a non-OK response must still be handed back unchanged');

  const [entry] = ErrorLog.entries();
  assert.equal(entry.code, '502');
  assert.equal(entry.kind, 'http');
  assert.equal(entry.level, 'error', '5xx is an error');
  assert.match(entry.reason, /502 Bad Gateway/);
});

test('a 4xx is recorded as warn, a 5xx as error', async () => {
  const { win: w4, ErrorLog: log4 } = makeHarness({
    fetch: async () => ({ ok: false, status: 404, statusText: 'Not Found', url: 'https://terminal.example/x' }),
  });
  await w4.fetch('/x');
  assert.equal(log4.entries()[0].level, 'warn');

  const { win: w5, ErrorLog: log5 } = makeHarness({
    fetch: async () => ({ ok: false, status: 500, statusText: 'Server Error', url: 'https://terminal.example/x' }),
  });
  await w5.fetch('/x');
  assert.equal(log5.entries()[0].level, 'error');
});

test('interceptor records a network rejection and rethrows it unchanged', async () => {
  const boom = new TypeError('Failed to fetch');
  const { win, ErrorLog } = makeHarness({ fetch: async () => { throw boom; } });

  await assert.rejects(() => win.fetch('/api/context'), (err) => {
    assert.equal(err, boom, 'the original rejection must reach the caller');
    return true;
  });

  const [entry] = ErrorLog.entries();
  assert.equal(entry.kind, 'network');
  assert.equal(entry.reason, 'Failed to fetch');
  assert.equal(entry.endpoint, '/api/context');
});

test('interceptor never reads the response body', async () => {
  let bodyRead = false;
  const res = {
    ok: false,
    status: 500,
    statusText: 'Server Error',
    url: 'https://terminal.example/x',
    text: async () => { bodyRead = true; return 'secret body'; },
    json: async () => { bodyRead = true; return {}; },
    clone: () => { bodyRead = true; return res; },
  };
  const { win } = makeHarness({ fetch: async () => res });
  await win.fetch('/x');
  assert.equal(bodyRead, false, 'consuming the stream would break the caller and could log user data');
});

// ── global capture ──

test('uncaught errors and unhandled rejections are captured with reasons', () => {
  const { listeners, ErrorLog } = makeHarness();
  assert.ok(listeners.error?.length, 'must listen for uncaught errors');
  assert.ok(listeners.unhandledrejection?.length, 'must listen for unhandled rejections');

  listeners.error[0]({ message: 'x is not a function', filename: 'https://terminal.example/js/terminal.js', lineno: 42 });
  listeners.unhandledrejection[0]({ reason: { message: 'boom' } });

  const list = ErrorLog.entries();
  assert.equal(list[0].kind, 'uncaught');
  assert.equal(list[0].reason, 'x is not a function');
  assert.equal(list[1].kind, 'unhandled-rejection');
  assert.equal(list[1].reason, 'boom');
});

test('the known-noisy ResizeObserver loop error is not recorded', () => {
  const { listeners, ErrorLog } = makeHarness();
  listeners.error[0]({ message: 'ResizeObserver loop completed with undelivered notifications.' });
  assert.equal(ErrorLog.entries().length, 0);
});

// ── persistence ──

test('the log survives a reload and is marked as pre-reload', () => {
  const first = makeHarness();
  first.ErrorLog.record({ title: 'Before reload', reason: 'upstream 500', endpoint: '/api/markets' });

  // Same sessionStorage contents, fresh script execution = a page reload.
  const persisted = first.store.get('swing.errorLog.v1');
  const second = makeHarness({
    window: {
      sessionStorage: {
        getItem: () => persisted,
        setItem: () => {},
        removeItem: () => {},
      },
    },
  });

  const [entry] = second.ErrorLog.entries();
  assert.equal(entry.title, 'Before reload');
  assert.equal(entry.restored, true);
  assert.equal(second.ErrorLog.dump()[0].when, 'before reload');
});

test('a broken sessionStorage is reported, not swallowed, and never throws', () => {
  const { consoleCalls, ErrorLog } = makeHarness({
    window: {
      sessionStorage: {
        getItem: () => { throw new Error('storage disabled'); },
        setItem: () => { throw new Error('QuotaExceededError'); },
        removeItem: () => {},
      },
    },
  });
  ErrorLog.record({ title: 'still works', reason: 'r' });
  assert.equal(ErrorLog.entries().length, 1, 'recording must survive a dead sessionStorage');
  assert.ok(
    consoleCalls.some((c) => c[0] === 'warn' && String(c[1]).includes('[ERRORLOG]')),
    'a dead sessionStorage must be logged, not swallowed',
  );
});

// ── summary / dump ──

test('summary counts occurrences, not just distinct rows', () => {
  const { ErrorLog } = makeHarness();
  for (let i = 0; i < 3; i += 1) {
    ErrorLog.record({ level: 'warn', kind: 'http', title: 'HTTP 502', reason: '502 Bad Gateway', endpoint: '/api/orderbook', code: 502 });
  }
  ErrorLog.record({ title: 'other', reason: 'r', endpoint: '/api/context' });

  const s = ErrorLog.summary();
  assert.equal(s.distinct, 2);
  assert.equal(s.byEndpoint['/api/orderbook'], 3);
  assert.equal(s.byEndpoint['/api/context'], 1);
});

test('json() output carries the reasons and no raw token', () => {
  const { ErrorLog } = makeHarness();
  ErrorLog.record({ title: 'Auth failed', reason: 'token expired', endpoint: '/api/markets?access_token=leak-me' });
  const report = ErrorLog.json();
  assert.match(report, /token expired/);
  assert.ok(!report.includes('leak-me'));
});
