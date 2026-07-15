import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import handler, {
  isSchedulerAuthenticated,
  buildPersonalAlertMessage,
  personalAlertDecision,
  sendPersonalTelegram,
  runPersonalAlerts,
} from '../netlify/functions/personal-alerts.mjs';
import { RADAR_TELEGRAM_COOLDOWN_MS } from '../netlify/functions/cron-alerts.mjs';

const NOW = Date.parse('2026-07-13T10:00:00.000Z');
const FAKE_CHAT = '12345';
const ENV_ENABLED = { PERSONAL_ALERTS_ENABLED: 'true', TG_BOT_TOKEN: 'test-token' };

function validEntry(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    STATUS: 'STANDARD_ENTRY_READY',
    stage: 'ENTRY_READY',
    actionability: 'ENTRY_READY',
    telegramEligible: true,
    allRadarConditionsPassed: true,
    safetyStatus: 'SAFE',
    entryZone: { low: 60000, high: 60500 },
    invalidationLevel: 59000,
    TAKE_PROFIT_LEVELS: [61000, 62000, 63000],
    tpZonesExist: true,
    executionDataMissing: [],
    SETUP_SCORE: 75,
    EXECUTION_SCORE: 72,
    RISK_REWARD_SCORE: 65,
    MARKET_REGIME_SCORE: 60,
    confidence: 82,
    reasons: ['confirmed reclaim'],
    ...overrides,
  };
}

function recipient(overrides = {}) {
  return {
    userId: 'user-a',
    telegramChatId: FAKE_CHAT,
    watches: [{ symbol: 'BTCUSDT', addedAt: '2026-07-13T09:00:00.000Z' }],
    ...overrides,
  };
}

function makeStore(recipients = [], initialStates = {}) {
  const states = new Map(Object.entries(initialStates));
  const calls = { reserve: 0, mark: 0, error: 0 };
  const emptyState = () => ({ sent: {}, pending: {}, lastErrorAt: null, lastErrorCode: null });
  return {
    calls,
    states,
    async listPersonalWatchRecipients() {
      return { ok: true, durable: true, recipients };
    },
    async getPersonalAlertState(userId) {
      return states.get(userId) || emptyState();
    },
    async reservePersonalAlert(userId, symbol, payload) {
      calls.reserve += 1;
      const current = states.get(userId) || emptyState();
      const previous = (current.sent || {})[symbol];
      if (previous && previous.hash === payload.hash) return { acquired: false, reason: 'duplicate', state: current };
      const lastSentMs = previous && previous.lastSentAt ? Date.parse(previous.lastSentAt) : NaN;
      if (Number.isFinite(lastSentMs) && Date.parse(payload.nowIso) - lastSentMs < payload.cooldownMs) {
        return { acquired: false, reason: 'cooldown', state: current };
      }
      if ((current.pending || {})[symbol]) return { acquired: false, reason: 'inFlight', state: current };
      const nextState = {
        ...current,
        pending: { ...(current.pending || {}), [symbol]: { hash: payload.hash, reservedAt: payload.nowIso } },
      };
      states.set(userId, nextState);
      return { acquired: true, reason: null, state: nextState };
    },
    async markPersonalAlertSent(userId, symbol, payload) {
      calls.mark += 1;
      const current = states.get(userId) || emptyState();
      const pending = { ...(current.pending || {}) };
      delete pending[symbol];
      const nextState = {
        ...current,
        pending,
        sent: { ...(current.sent || {}), [symbol]: { lastSentAt: payload.lastSentAt, hash: payload.hash } },
        lastErrorAt: null,
        lastErrorCode: null,
      };
      states.set(userId, nextState);
      return nextState;
    },
    async recordPersonalAlertError(userId, code, nowIso, symbol) {
      calls.error += 1;
      const current = states.get(userId) || emptyState();
      const pending = { ...(current.pending || {}) };
      delete pending[symbol];
      const nextState = { ...current, pending, lastErrorAt: nowIso, lastErrorCode: code };
      states.set(userId, nextState);
      return nextState;
    },
  };
}

async function run(overrides = {}) {
  const store = overrides.store || makeStore([recipient()]);
  let sends = 0;
  const sendMessage = overrides.sendMessage || (async () => {
    sends += 1;
    return { ok: true };
  });
  const result = await runPersonalAlerts({
    env: ENV_ENABLED,
    nowMs: NOW,
    loadFleet: async () => ({ tradingRadar: { entryReady: [validEntry()] } }),
    store,
    sendMessage,
    ...overrides,
  });
  return { result, store, sends };
}

test('disabled by default sends nothing', async () => {
  let loaded = false;
  const result = await runPersonalAlerts({
    env: {},
    loadFleet: async () => { loaded = true; return {}; },
  });
  assert.equal(result.disabled, true);
  assert.equal(result.reason, 'PERSONAL_ALERTS_DISABLED');
  assert.equal(result.sent, 0);
  assert.equal(loaded, false);
});

test('PERSONAL_ALERTS_ENABLED must be exactly true', async () => {
  for (const value of ['false', 'TRUE', '1', 'yes', ' true ']) {
    const result = await runPersonalAlerts({ env: { PERSONAL_ALERTS_ENABLED: value } });
    assert.equal(result.disabled, true, value);
    assert.equal(result.sent, 0, value);
  }
});

test('enabled without Telegram token sends nothing', async () => {
  const result = await runPersonalAlerts({ env: { PERSONAL_ALERTS_ENABLED: 'true' } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'PERSONAL_ALERTS_TELEGRAM_TOKEN_MISSING');
  assert.equal(result.sent, 0);
});

test('no confirmed RADAR ENTRY_READY alerts sends nothing', async () => {
  const { result, sends } = await run({
    loadFleet: async () => ({ tradingRadar: { candidates: [validEntry({ telegramEligible: false })] } }),
  });
  assert.equal(result.reason, 'NO_CONFIRMED_ENTRY_READY');
  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
});

test('confirmed alert with no users sends nothing', async () => {
  const { result, sends } = await run({ store: makeStore([]) });
  assert.equal(result.recipientsChecked, 0);
  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
});

test('user watching a different symbol gets nothing', async () => {
  const { result, sends } = await run({ store: makeStore([recipient({ watches: [{ symbol: 'ETHUSDT' }] })]) });
  assert.equal(result.skipped.noWatch, 1);
  assert.equal(sends, 0);
});

test('matching watch without a valid chat id gets nothing', async () => {
  const { result, sends } = await run({ store: makeStore([recipient({ telegramChatId: null })]) });
  assert.equal(result.skipped.noChat, 1);
  assert.equal(sends, 0);
});

test('matching symbol and chat id sends once and marks after success', async () => {
  const store = makeStore([recipient()]);
  const order = [];
  const originalMark = store.markPersonalAlertSent;
  store.markPersonalAlertSent = async (...args) => {
    order.push('mark');
    return originalMark(...args);
  };
  const { result } = await run({
    store,
    sendMessage: async () => { order.push('send'); return { ok: true }; },
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(order, ['send', 'mark']);
  assert.equal(store.calls.reserve, 1);
  assert.equal(store.calls.mark, 1);
});
test('overlapping runs use one durable reservation and send exactly once', async () => {
  const store = makeStore([recipient()]);
  let sends = 0;
  const sendMessage = async () => {
    sends += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true };
  };
  const [first, second] = await Promise.all([
    run({ store, sendMessage }),
    run({ store, sendMessage }),
  ]);
  assert.equal(sends, 1);
  assert.equal(first.result.sent + second.result.sent, 1);
  assert.equal(first.result.skipped.inFlight + second.result.skipped.inFlight, 1);
});


test('same user and symbol inside 60-minute cooldown is skipped', async () => {
  const state = {
    sent: {
      BTCUSDT: {
        lastSentAt: new Date(NOW - RADAR_TELEGRAM_COOLDOWN_MS + 1).toISOString(),
        hash: 'older-hash',
      },
    },
  };
  const { result, sends } = await run({ store: makeStore([recipient()], { 'user-a': state }) });
  assert.equal(result.skipped.cooldown, 1);
  assert.equal(sends, 0);
});

test('same setup hash is skipped as duplicate even after cooldown', async () => {
  const candidate = validEntry();
  const decision = personalAlertDecision(candidate, { sent: {} }, NOW);
  const state = {
    sent: {
      BTCUSDT: {
        lastSentAt: new Date(NOW - RADAR_TELEGRAM_COOLDOWN_MS - 1).toISOString(),
        hash: decision.hash,
      },
    },
  };
  const { result, sends } = await run({ store: makeStore([recipient()], { 'user-a': state }) });
  assert.equal(result.skipped.duplicate, 1);
  assert.equal(sends, 0);
});

test('changed setup hash after cooldown can send', async () => {
  const state = {
    sent: {
      BTCUSDT: {
        lastSentAt: new Date(NOW - RADAR_TELEGRAM_COOLDOWN_MS - 1).toISOString(),
        hash: 'BTCUSDT|OLD_SETUP',
      },
    },
  };
  const { result, sends } = await run({ store: makeStore([recipient()], { 'user-a': state }) });
  assert.equal(result.sent, 1);
  assert.equal(sends, 1);
});

test('Telegram transport uses only the mocked fetch path', async () => {
  let request;
  const result = await sendPersonalTelegram('test-token', FAKE_CHAT, 'test message', async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.equal(result.ok, true);
  assert.match(request.url, /^https:\/\/api\.telegram\.org\/bot/);
  assert.equal(request.options.method, 'POST');
  assert.equal(JSON.parse(request.options.body).chat_id, FAKE_CHAT);
});

test('Telegram failure does not mark sent', async () => {
  const store = makeStore([recipient()]);
  const { result } = await run({ store, sendMessage: async () => ({ ok: false }) });
  assert.equal(result.sent, 0);
  assert.equal(result.ok, false);
  assert.equal(store.calls.mark, 0);
  assert.equal(store.calls.error, 1);
});

test('one user send failure does not block another user', async () => {
  const store = makeStore([
    recipient({ userId: 'user-a', telegramChatId: '12345' }),
    recipient({ userId: 'user-b', telegramChatId: '67890' }),
  ]);
  let attempt = 0;
  const { result } = await run({
    store,
    sendMessage: async () => {
      attempt += 1;
      return { ok: attempt === 2 };
    },
  });
  assert.equal(attempt, 2);
  assert.equal(result.sent, 1);
  assert.equal(result.skipped.failed, 1);
  assert.equal(store.calls.mark, 1);
});

test('per-user cap skips additional messages', async () => {
  const store = makeStore([recipient({ watches: [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }] })]);
  const { result } = await run({
    store,
    perUserCap: 1,
    loadFleet: async () => ({
      tradingRadar: { entryReady: [validEntry(), validEntry({ symbol: 'ETHUSDT', entryZone: { low: 3000, high: 3050 } })] },
    }),
  });
  assert.equal(result.sent, 1);
  assert.equal(result.skipped.cap, 1);
});

test('global cap skips remaining fan-out', async () => {
  const store = makeStore([
    recipient({ userId: 'user-a', telegramChatId: '12345' }),
    recipient({ userId: 'user-b', telegramChatId: '67890' }),
  ]);
  const { result } = await run({ store, globalCap: 1 });
  assert.equal(result.sent, 1);
  assert.equal(result.skipped.cap, 1);
});

test('memory fallback or unavailable recipient store fails closed', async () => {
  const store = makeStore([recipient()]);
  store.listPersonalWatchRecipients = async () => ({ ok: true, durable: false, recipients: [recipient()] });
  const { result, sends } = await run({ store });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'PERSONAL_WATCH_STORE_UNAVAILABLE');
  assert.equal(sends, 0);
});

test('unwritable dedup state fails closed before send', async () => {
  const store = makeStore([recipient()]);
  store.reservePersonalAlert = async () => { throw new Error('unavailable'); };
  const { result, sends } = await run({ store });
  assert.equal(result.sent, 0);
  assert.equal(result.skipped.failed, 1);
  assert.equal(sends, 0);
});

test('summary and message do not expose user or chat ids', async () => {
  const { result } = await run();
  const output = JSON.stringify(result);
  assert.doesNotMatch(output, /12345|user-a/);
  const message = buildPersonalAlertMessage(validEntry(), new Date(NOW).toISOString());
  assert.doesNotMatch(message, /12345|user-a/);
  assert.match(message, /Personal Watch/);
  assert.doesNotMatch(message, /buy now|profit/i);
});

test('manual body cannot trigger an arbitrary send', async () => {
  const savedEnabled = process.env.PERSONAL_ALERTS_ENABLED;
  const savedToken = process.env.TG_BOT_TOKEN;
  const originalFetch = globalThis.fetch;
  let sends = 0;
  process.env.PERSONAL_ALERTS_ENABLED = 'true';
  process.env.TG_BOT_TOKEN = 'test-token';
  globalThis.fetch = async () => { sends += 1; return new Response('{}', { status: 200 }); };
  try {
    const req = new Request('https://example.test/.netlify/functions/personal-alerts', {
      method: 'POST',
      body: JSON.stringify({ symbol: 'BTCUSDT', telegramChatId: FAKE_CHAT }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await handler(req);
    assert.equal(response.status, 401);
    assert.equal(sends, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedEnabled === undefined) delete process.env.PERSONAL_ALERTS_ENABLED;
    else process.env.PERSONAL_ALERTS_ENABLED = savedEnabled;
    if (savedToken === undefined) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = savedToken;
  }
});

test('forged next_run body cannot authenticate a sender', async () => {
  const savedEnabled = process.env.PERSONAL_ALERTS_ENABLED;
  const savedToken = process.env.TG_BOT_TOKEN;
  const savedSecret = process.env.PERSONAL_ALERTS_SCHEDULER_SECRET;
  const originalFetch = globalThis.fetch;
  let sends = 0;
  process.env.PERSONAL_ALERTS_ENABLED = 'true';
  process.env.TG_BOT_TOKEN = 'test-token';
  process.env.PERSONAL_ALERTS_SCHEDULER_SECRET = 'test-scheduler-secret';
  globalThis.fetch = async () => { sends += 1; return new Response('{}', { status: 200 }); };
  try {
    const req = new Request('https://example.test/.netlify/functions/personal-alerts', {
      method: 'POST',
      body: JSON.stringify({ next_run: '2026-07-13T10:00:00.000Z', symbol: 'BTCUSDT' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await handler(req);
    assert.equal(response.status, 401);
    assert.equal(sends, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedEnabled === undefined) delete process.env.PERSONAL_ALERTS_ENABLED;
    else process.env.PERSONAL_ALERTS_ENABLED = savedEnabled;
    if (savedToken === undefined) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = savedToken;
    if (savedSecret === undefined) delete process.env.PERSONAL_ALERTS_SCHEDULER_SECRET;
    else process.env.PERSONAL_ALERTS_SCHEDULER_SECRET = savedSecret;
  }
});

test('direct public GET with disabled env returns a clean Response, not an unsupported value', async () => {
  const savedEnabled = process.env.PERSONAL_ALERTS_ENABLED;
  const savedToken = process.env.TG_BOT_TOKEN;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  delete process.env.PERSONAL_ALERTS_ENABLED;
  delete process.env.TG_BOT_TOKEN;
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); };
  try {
    const req = new Request('https://example.test/.netlify/functions/personal-alerts', { method: 'GET' });
    const response = await handler(req);
    assert.ok(response instanceof Response);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.disabled, true);
    assert.equal(body.sent, 0);
    assert.equal(fetchCalls, 0);
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /NetlifyUserError|at file:|secret|token|12345/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedEnabled === undefined) delete process.env.PERSONAL_ALERTS_ENABLED;
    else process.env.PERSONAL_ALERTS_ENABLED = savedEnabled;
    if (savedToken === undefined) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = savedToken;
  }
});

test('direct public GET with enabled env and no scheduler header returns a clean 401 and sends zero', async () => {
  const savedEnabled = process.env.PERSONAL_ALERTS_ENABLED;
  const savedToken = process.env.TG_BOT_TOKEN;
  const savedSecret = process.env.PERSONAL_ALERTS_SCHEDULER_SECRET;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.PERSONAL_ALERTS_ENABLED = 'true';
  process.env.TG_BOT_TOKEN = 'test-token';
  process.env.PERSONAL_ALERTS_SCHEDULER_SECRET = 'test-scheduler-secret';
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); };
  try {
    const req = new Request('https://example.test/.netlify/functions/personal-alerts', { method: 'GET' });
    const response = await handler(req);
    assert.ok(response instanceof Response);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.sent, 0);
    assert.equal(fetchCalls, 0);
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /test-scheduler-secret|test-token/);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedEnabled === undefined) delete process.env.PERSONAL_ALERTS_ENABLED;
    else process.env.PERSONAL_ALERTS_ENABLED = savedEnabled;
    if (savedToken === undefined) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = savedToken;
    if (savedSecret === undefined) delete process.env.PERSONAL_ALERTS_SCHEDULER_SECRET;
    else process.env.PERSONAL_ALERTS_SCHEDULER_SECRET = savedSecret;
  }
});

test('wrong scheduler header on direct call returns a clean rejection and sends zero', async () => {
  const savedEnabled = process.env.PERSONAL_ALERTS_ENABLED;
  const savedToken = process.env.TG_BOT_TOKEN;
  const savedSecret = process.env.PERSONAL_ALERTS_SCHEDULER_SECRET;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.PERSONAL_ALERTS_ENABLED = 'true';
  process.env.TG_BOT_TOKEN = 'test-token';
  process.env.PERSONAL_ALERTS_SCHEDULER_SECRET = 'test-scheduler-secret';
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); };
  try {
    const req = new Request('https://example.test/.netlify/functions/personal-alerts', {
      method: 'POST',
      headers: { 'x-terminal-scheduler-secret': 'wrong-secret' },
      body: JSON.stringify({ next_run: 'forged' }),
    });
    const response = await handler(req);
    assert.ok(response instanceof Response);
    assert.equal(response.status, 401);
    assert.equal(fetchCalls, 0);
    const body = await response.json();
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /wrong-secret|test-scheduler-secret|test-token/);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedEnabled === undefined) delete process.env.PERSONAL_ALERTS_ENABLED;
    else process.env.PERSONAL_ALERTS_ENABLED = savedEnabled;
    if (savedToken === undefined) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = savedToken;
    if (savedSecret === undefined) delete process.env.PERSONAL_ALERTS_SCHEDULER_SECRET;
    else process.env.PERSONAL_ALERTS_SCHEDULER_SECRET = savedSecret;
  }
});

test('enabled: GET is rejected even with a correct scheduler header (POST required for fan-out)', async () => {
  const savedEnabled = process.env.PERSONAL_ALERTS_ENABLED;
  const savedToken = process.env.TG_BOT_TOKEN;
  const savedSecret = process.env.PERSONAL_ALERTS_SCHEDULER_SECRET;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.PERSONAL_ALERTS_ENABLED = 'true';
  process.env.TG_BOT_TOKEN = 'test-token';
  process.env.PERSONAL_ALERTS_SCHEDULER_SECRET = 'test-scheduler-secret';
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); };
  try {
    const req = new Request('https://example.test/.netlify/functions/personal-alerts', {
      method: 'GET',
      headers: { 'x-terminal-scheduler-secret': 'test-scheduler-secret' },
    });
    const response = await handler(req);
    assert.ok(response instanceof Response);
    assert.equal(response.status, 401);
    assert.equal(fetchCalls, 0);
    const body = await response.json();
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /test-scheduler-secret|test-token/);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedEnabled === undefined) delete process.env.PERSONAL_ALERTS_ENABLED;
    else process.env.PERSONAL_ALERTS_ENABLED = savedEnabled;
    if (savedToken === undefined) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = savedToken;
    if (savedSecret === undefined) delete process.env.PERSONAL_ALERTS_SCHEDULER_SECRET;
    else process.env.PERSONAL_ALERTS_SCHEDULER_SECRET = savedSecret;
  }
});

test('enabled: authenticated POST passes the method+auth gate, runs the pipeline, and leaks nothing', async () => {
  const savedEnabled = process.env.PERSONAL_ALERTS_ENABLED;
  const savedToken = process.env.TG_BOT_TOKEN;
  const savedSecret = process.env.PERSONAL_ALERTS_SCHEDULER_SECRET;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.PERSONAL_ALERTS_ENABLED = 'true';
  process.env.TG_BOT_TOKEN = 'test-token';
  process.env.PERSONAL_ALERTS_SCHEDULER_SECRET = 'test-scheduler-secret';
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); };
  try {
    const req = new Request('https://example.test/.netlify/functions/personal-alerts', {
      method: 'POST',
      headers: { 'x-terminal-scheduler-secret': 'test-scheduler-secret' },
      body: '{}',
    });
    const response = await handler(req);
    assert.ok(response instanceof Response);
    // Never the 401 gate response — this request is authenticated and POST.
    assert.notEqual(response.status, 401);
    assert.equal(response.status, 200);
    // No real recipient/fleet state exists in the test process, so no send
    // is possible here regardless of branch reached — proves the gate change
    // alone never causes a Telegram call in this environment.
    assert.equal(fetchCalls, 0);
    const body = await response.json();
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /test-scheduler-secret|test-token|NetlifyUserError|at file:/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedEnabled === undefined) delete process.env.PERSONAL_ALERTS_ENABLED;
    else process.env.PERSONAL_ALERTS_ENABLED = savedEnabled;
    if (savedToken === undefined) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = savedToken;
    if (savedSecret === undefined) delete process.env.PERSONAL_ALERTS_SCHEDULER_SECRET;
    else process.env.PERSONAL_ALERTS_SCHEDULER_SECRET = savedSecret;
  }
});

test('missing or wrong scheduler secret rejects enabled invocation', () => {
  const env = { PERSONAL_ALERTS_ENABLED: 'true', PERSONAL_ALERTS_SCHEDULER_SECRET: 'expected-secret' };
  const missing = new Request('https://example.test/personal-alerts', { method: 'POST', body: '{}' });
  const wrong = new Request('https://example.test/personal-alerts', {
    method: 'POST',
    headers: { 'x-terminal-scheduler-secret': 'wrong-secret' },
    body: JSON.stringify({ next_run: 'forged' }),
  });
  assert.equal(isSchedulerAuthenticated(missing, env), false);
  assert.equal(isSchedulerAuthenticated(wrong, env), false);
  assert.equal(isSchedulerAuthenticated(missing, { PERSONAL_ALERTS_ENABLED: 'true' }), false);
});

test('valid scheduler secret authenticates without trusting request body fields', async () => {
  const env = { ...ENV_ENABLED, PERSONAL_ALERTS_SCHEDULER_SECRET: 'test-scheduler-secret' };
  const req = new Request('https://example.test/personal-alerts', {
    method: 'POST',
    headers: { 'x-terminal-scheduler-secret': 'test-scheduler-secret' },
    body: JSON.stringify({ next_run: 'metadata-only' }),
  });
  assert.equal(isSchedulerAuthenticated(req, env), true);
  let sends = 0;
  const { result } = await run({ env, sendMessage: async () => { sends += 1; return { ok: true }; } });
  assert.equal(result.sent, 1);
  assert.equal(sends, 1);
});

test('source guard: sender reuses cron gate and has no trading or browser-storage paths', () => {
  const source = fs.readFileSync(new URL('../netlify/functions/personal-alerts.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '.\/cron-alerts\.mjs'/);
  assert.match(source, /selectRadarEntryAlerts\(/);
  assert.doesNotMatch(source, /function\s+evaluateConfirmedRadarEntryReady|function\s+isConfirmedRadarEntryReady/);
  for (const forbidden of [
    /\/sapi/i, /\/dapi/i, /\/fapi/i, /\/order\b/i,
    /create-execution-intent/i, /execution-intent/i, /worker-session/i,
    /BINANCE_API_KEY/i, /BINANCE_API_SECRET/i,
    /localStorage/i, /sessionStorage/i,
    /watchAll|watch_all|customCondition/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test('source guard: no native Netlify schedule is registered (external scheduler only)', async () => {
  const mod = await import('../netlify/functions/personal-alerts.mjs');
  assert.equal(mod.config, undefined);
  const source = fs.readFileSync(new URL('../netlify/functions/personal-alerts.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /export const config/);
  assert.doesNotMatch(source, /schedule\s*:\s*['"]/);
});
