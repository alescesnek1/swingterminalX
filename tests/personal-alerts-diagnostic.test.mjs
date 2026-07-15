import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import handler, {
  isDiagnosticAuthenticated,
  buildDiagnosticMessage,
  sendDiagnosticTelegram,
  runDiagnosticSend,
} from '../netlify/functions/personal-alerts-diagnostic.mjs';

const FAKE_CHAT = '98765';
const FAKE_TARGET_USER = 'diagnostic-test-user-id';
const ENV_ENABLED = {
  PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED: 'true',
  PERSONAL_ALERTS_DIAGNOSTIC_SECRET: 'test-diagnostic-secret',
  PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID: FAKE_TARGET_USER,
  TG_BOT_TOKEN: 'test-token',
};

function foundRecord(overrides = {}) {
  return {
    found: true,
    record: {
      userId: FAKE_TARGET_USER,
      telegramChatId: FAKE_CHAT,
      watches: [{ symbol: 'BTCUSDT', addedAt: '2026-07-13T09:00:00.000Z' }],
      ...overrides,
    },
  };
}

async function run(overrides = {}) {
  let getRecordCalls = 0;
  let getRecordArg = null;
  const getRecord = overrides.getRecord || (async (id) => {
    getRecordCalls += 1;
    getRecordArg = id;
    return foundRecord();
  });
  let sends = 0;
  const sendMessage = overrides.sendMessage || (async () => { sends += 1; return { ok: true }; });
  const result = await runDiagnosticSend({
    env: ENV_ENABLED,
    getRecord,
    sendMessage,
    ...overrides,
  });
  return { result, sends, getRecordCalls, getRecordArg };
}

test('1. disabled by default sends nothing and never touches the store or Telegram', async () => {
  let getRecordCalls = 0;
  let sends = 0;
  const result = await runDiagnosticSend({
    env: {},
    getRecord: async () => { getRecordCalls += 1; return foundRecord(); },
    sendMessage: async () => { sends += 1; return { ok: true }; },
  });
  assert.equal(result.disabled, true);
  assert.equal(result.reason, 'DIAGNOSTIC_DISABLED');
  assert.equal(result.sent, 0);
  assert.equal(getRecordCalls, 0);
  assert.equal(sends, 0);
});

test('2. PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED must be exactly true', async () => {
  for (const value of ['false', 'TRUE', '1', 'yes', ' true ']) {
    const result = await runDiagnosticSend({ env: { ...ENV_ENABLED, PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED: value } });
    assert.equal(result.disabled, true, value);
    assert.equal(result.sent, 0, value);
  }
});

test('3. POST is required for send; GET is rejected even with a correct header', async () => {
  const savedEnabled = process.env.PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED;
  const savedSecret = process.env.PERSONAL_ALERTS_DIAGNOSTIC_SECRET;
  const savedTarget = process.env.PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID;
  const savedToken = process.env.TG_BOT_TOKEN;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED = 'true';
  process.env.PERSONAL_ALERTS_DIAGNOSTIC_SECRET = 'test-diagnostic-secret';
  process.env.PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID = FAKE_TARGET_USER;
  process.env.TG_BOT_TOKEN = 'test-token';
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); };
  try {
    const req = new Request('https://example.test/.netlify/functions/personal-alerts-diagnostic', {
      method: 'GET',
      headers: { 'x-terminal-diagnostic-secret': 'test-diagnostic-secret' },
    });
    const response = await handler(req);
    assert.ok(response instanceof Response);
    assert.equal(response.status, 401);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedEnabled === undefined) delete process.env.PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED;
    else process.env.PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED = savedEnabled;
    if (savedSecret === undefined) delete process.env.PERSONAL_ALERTS_DIAGNOSTIC_SECRET;
    else process.env.PERSONAL_ALERTS_DIAGNOSTIC_SECRET = savedSecret;
    if (savedTarget === undefined) delete process.env.PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID;
    else process.env.PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID = savedTarget;
    if (savedToken === undefined) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = savedToken;
  }
});

test('4. missing diagnostic secret env fails closed', async () => {
  const { result, sends, getRecordCalls } = await run({
    env: { ...ENV_ENABLED, PERSONAL_ALERTS_DIAGNOSTIC_SECRET: '' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'DIAGNOSTIC_SECRET_NOT_CONFIGURED');
  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
  assert.equal(getRecordCalls, 0);
});

test('5. missing or wrong header fails closed at the handler', async () => {
  const savedEnabled = process.env.PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED;
  const savedSecret = process.env.PERSONAL_ALERTS_DIAGNOSTIC_SECRET;
  const savedTarget = process.env.PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID;
  const savedToken = process.env.TG_BOT_TOKEN;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED = 'true';
  process.env.PERSONAL_ALERTS_DIAGNOSTIC_SECRET = 'test-diagnostic-secret';
  process.env.PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID = FAKE_TARGET_USER;
  process.env.TG_BOT_TOKEN = 'test-token';
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); };
  try {
    const missing = await handler(new Request('https://example.test/.netlify/functions/personal-alerts-diagnostic', { method: 'POST', body: '{}' }));
    assert.equal(missing.status, 401);
    const wrong = await handler(new Request('https://example.test/.netlify/functions/personal-alerts-diagnostic', {
      method: 'POST',
      headers: { 'x-terminal-diagnostic-secret': 'wrong-secret' },
      body: '{}',
    }));
    assert.equal(wrong.status, 401);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedEnabled === undefined) delete process.env.PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED;
    else process.env.PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED = savedEnabled;
    if (savedSecret === undefined) delete process.env.PERSONAL_ALERTS_DIAGNOSTIC_SECRET;
    else process.env.PERSONAL_ALERTS_DIAGNOSTIC_SECRET = savedSecret;
    if (savedTarget === undefined) delete process.env.PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID;
    else process.env.PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID = savedTarget;
    if (savedToken === undefined) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = savedToken;
  }
});

test('6. missing target user env fails closed', async () => {
  const { result, sends, getRecordCalls } = await run({
    env: { ...ENV_ENABLED, PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID: '' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'DIAGNOSTIC_TARGET_NOT_CONFIGURED');
  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
  assert.equal(getRecordCalls, 0);
});

test('7. missing TG_BOT_TOKEN fails closed', async () => {
  const { result, sends, getRecordCalls } = await run({
    env: { ...ENV_ENABLED, TG_BOT_TOKEN: '' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'DIAGNOSTIC_TOKEN_MISSING');
  assert.equal(result.targetConfigured, true);
  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
  assert.equal(getRecordCalls, 0);
});

test('8. store unavailable fails closed', async () => {
  const { result, sends } = await run({
    getRecord: async () => { throw new Error('store unavailable'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'DIAGNOSTIC_STORE_UNAVAILABLE');
  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
});

test('9. target not found fails closed', async () => {
  const { result, sends } = await run({
    getRecord: async () => ({ found: false, record: null }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'DIAGNOSTIC_TARGET_NOT_FOUND');
  assert.equal(result.targetConfigured, true);
  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
});

test('10. target without a saved chat id fails closed', async () => {
  const { result, sends } = await run({
    getRecord: async () => foundRecord({ telegramChatId: null }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'DIAGNOSTIC_TARGET_NO_CHAT');
  assert.equal(result.targetFound, true);
  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
});

test('11. target with zero watches fails closed', async () => {
  const { result, sends } = await run({
    getRecord: async () => foundRecord({ watches: [] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'DIAGNOSTIC_TARGET_WATCH_COUNT_NOT_ONE');
  assert.equal(result.targetWatchCount, 0);
  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
});

test('12. target with more than one watch fails closed', async () => {
  const { result, sends } = await run({
    getRecord: async () => foundRecord({ watches: [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'DIAGNOSTIC_TARGET_WATCH_COUNT_NOT_ONE');
  assert.equal(result.targetWatchCount, 2);
  assert.equal(result.sent, 0);
  assert.equal(sends, 0);
});

test('13. valid path sends exactly one diagnostic message', async () => {
  const { result, sends, getRecordArg } = await run();
  assert.equal(result.sent, 1);
  assert.equal(result.reason, 'DIAGNOSTIC_SENT');
  assert.equal(result.targetFound, true);
  assert.equal(result.targetHasChat, true);
  assert.equal(result.targetWatchCount, 1);
  assert.equal(sends, 1);
  assert.equal(getRecordArg, FAKE_TARGET_USER);
});

test('14. Telegram API failure returns sent:0 and a clean failure reason', async () => {
  const { result } = await run({ sendMessage: async () => ({ ok: false }) });
  assert.equal(result.sent, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'DIAGNOSTIC_TELEGRAM_FAILED');
});

test('15. response never includes the raw chat id', async () => {
  const { result } = await run();
  const raw = JSON.stringify(result);
  assert.doesNotMatch(raw, new RegExp(FAKE_CHAT));
});

test('16. response never includes the raw target user id', async () => {
  const { result } = await run();
  const raw = JSON.stringify(result);
  assert.doesNotMatch(raw, new RegExp(FAKE_TARGET_USER));
});

test('17. logs never include raw chat ID or raw user ID (source guard on the console.log line)', () => {
  const source = fs.readFileSync(new URL('../netlify/functions/personal-alerts-diagnostic.mjs', import.meta.url), 'utf8');
  const logLineMatch = source.match(/console\.log\(`[^`]*`\)/);
  assert.ok(logLineMatch, 'expected a console.log template literal in the handler');
  assert.doesNotMatch(logLineMatch[0], /chatId|telegramChatId|targetUserId|userId|record\b/i);
});

test('18/19. request body cannot override the target user or supply a chat id (no body is ever read)', async () => {
  let calledWith = null;
  const { result } = await run({
    getRecord: async (id) => { calledWith = id; return foundRecord(); },
  });
  assert.equal(calledWith, FAKE_TARGET_USER);
  assert.equal(result.sent, 1);
  const source = fs.readFileSync(new URL('../netlify/functions/personal-alerts-diagnostic.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /req\.(json|text)\(\)/);
});

test('20. does not import or call selectRadarEntryAlerts', () => {
  const source = fs.readFileSync(new URL('../netlify/functions/personal-alerts-diagnostic.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /selectRadarEntryAlerts/);
});

test('21. does not read or write the RADAR fleet', () => {
  const source = fs.readFileSync(new URL('../netlify/functions/personal-alerts-diagnostic.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /loadFleet|saveFleet|_fleet-store/);
});

test('22. does not touch normal alert dedup/cooldown/sent state', () => {
  const source = fs.readFileSync(new URL('../netlify/functions/personal-alerts-diagnostic.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /reservePersonalAlert|markPersonalAlertSent|getPersonalAlertState\b|recordPersonalAlertError|personalAlertState/);
});

test('23. does not reference trading/order/Binance execution paths', () => {
  const source = fs.readFileSync(new URL('../netlify/functions/personal-alerts-diagnostic.mjs', import.meta.url), 'utf8');
  for (const forbidden of [
    /\/sapi/i, /\/dapi/i, /\/fapi/i, /\/order\b/i,
    /create-execution-intent/i, /execution-intent/i, /worker-session/i,
    /BINANCE_API_KEY/i, /BINANCE_API_SECRET/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test('24. does not rely on the real sender\'s enable flag', () => {
  const source = fs.readFileSync(new URL('../netlify/functions/personal-alerts-diagnostic.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /PERSONAL_ALERTS_ENABLED/);
});

test('25. does not rely on the real sender\'s scheduler secret or header', () => {
  const source = fs.readFileSync(new URL('../netlify/functions/personal-alerts-diagnostic.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /PERSONAL_ALERTS_SCHEDULER_SECRET/);
  assert.doesNotMatch(source, /x-terminal-scheduler-secret/);
});

test('source guard: enumeration is never used, only a single targeted lookup', () => {
  const source = fs.readFileSync(new URL('../netlify/functions/personal-alerts-diagnostic.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /listPersonalWatchRecipients/);
});

test('diagnostic message clearly states it is a test, not a market alert', () => {
  const message = buildDiagnosticMessage('BTCUSDT');
  assert.match(message, /diagnostic test/i);
  assert.match(message, /no market signal/i);
  assert.match(message, /no trading action/i);
  assert.doesNotMatch(message, /ENTRY_READY/);
});

test('Telegram transport uses only the mocked fetch path', async () => {
  let request;
  const result = await sendDiagnosticTelegram('test-token', FAKE_CHAT, 'diagnostic message', async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.equal(result.ok, true);
  assert.match(request.url, /^https:\/\/api\.telegram\.org\/bot/);
  assert.equal(request.options.method, 'POST');
  assert.equal(JSON.parse(request.options.body).chat_id, FAKE_CHAT);
});

test('isDiagnosticAuthenticated rejects missing/wrong header and accepts a matching one', () => {
  const env = { PERSONAL_ALERTS_DIAGNOSTIC_SECRET: 'expected-secret' };
  const missing = new Request('https://example.test/personal-alerts-diagnostic', { method: 'POST', body: '{}' });
  const wrong = new Request('https://example.test/personal-alerts-diagnostic', {
    method: 'POST',
    headers: { 'x-terminal-diagnostic-secret': 'wrong-secret' },
  });
  const right = new Request('https://example.test/personal-alerts-diagnostic', {
    method: 'POST',
    headers: { 'x-terminal-diagnostic-secret': 'expected-secret' },
  });
  assert.equal(isDiagnosticAuthenticated(missing, env), false);
  assert.equal(isDiagnosticAuthenticated(wrong, env), false);
  assert.equal(isDiagnosticAuthenticated(right, env), true);
});
