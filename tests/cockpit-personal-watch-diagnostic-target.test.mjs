import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runPersonalWatchDiagnosticTarget } from '../netlify/functions/cockpit-personal-watch-diagnostic-target.mjs';

const ENDPOINT_URL = 'https://swingterminalx.netlify.app/api/cockpit-personal-watch-diagnostic-target';
const USER = { ok: true, userId: 'user-A-uuid-0001', email: 'a@example.com' };
const ANON = { ok: false, reason: 'No bearer token' };
const CHAT = '552398471';

function makeReq(method = 'GET', origin) {
  const headers = origin ? { origin } : {};
  return new Request(ENDPOINT_URL, { method, headers });
}

function call({ identity = USER, record, found = true, method = 'GET', getRecord, origin } = {}) {
  const lookup = getRecord || (async (userId) => ({
    found,
    record: record === undefined ? { userId, telegramChatId: CHAT, watches: [{ symbol: 'BTCUSDT' }] } : record,
  }));
  return runPersonalWatchDiagnosticTarget(makeReq(method, origin), {
    getIdentity: async () => identity,
    getRecord: lookup,
  });
}

test('unauthenticated requests return 401 and never call the store', async () => {
  let called = false;
  const res = await call({ identity: ANON, getRecord: async () => { called = true; return {}; } });
  assert.equal(res.status, 401);
  assert.equal(called, false);
  assert.equal((await res.json()).ok, false);
});

test('OPTIONS is handled without auth and GET is the only data method', async () => {
  const options = await call({ method: 'OPTIONS', identity: ANON, origin: 'https://swingterminalx.netlify.app' });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  const put = await call({ method: 'PUT' });
  assert.equal(put.status, 405);
});

test('authenticated response returns the exact current identity and safe aggregates', async () => {
  let lookedUp;
  const res = await call({
    getRecord: async (userId) => { lookedUp = userId; return { found: true, record: { telegramChatId: CHAT, watches: [{ symbol: 'BTCUSDT' }] } }; },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(lookedUp, USER.userId);
  assert.equal(body.diagnosticTargetUserId, USER.userId);
  assert.equal(body.hasPersonalWatchRecord, true);
  assert.equal(body.hasChat, true);
  assert.equal(body.watchCount, 1);
  assert.equal(body.exactlyOneWatch, true);
  assert.equal(body.telegramChatId, undefined);
  assert.equal(JSON.stringify(body).includes(CHAT), false);
});

test('missing record reports empty aggregates and only reads the current user', async () => {
  const users = [];
  const res = await call({
    found: false,
    record: null,
    getRecord: async (userId) => { users.push(userId); return { found: false, record: {} }; },
  });
  const body = await res.json();
  assert.deepEqual(users, [USER.userId]);
  assert.equal(body.hasPersonalWatchRecord, false);
  assert.equal(body.hasChat, false);
  assert.equal(body.watchCount, 0);
  assert.equal(body.exactlyOneWatch, false);
});

test('multiple watches are reported without exposing record contents', async () => {
  const res = await call({ record: { telegramChatId: CHAT, watches: [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }] } });
  const body = await res.json();
  assert.equal(body.hasChat, true);
  assert.equal(body.watchCount, 2);
  assert.equal(body.exactlyOneWatch, false);
  assert.equal('watches' in body, false);
  assert.equal('email' in body, false);
});

test('store failure is fail-closed and performs no mutation', async () => {
  let calls = 0;
  const res = await call({ getRecord: async () => { calls += 1; throw new Error('store down'); } });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).ok, false);
  assert.equal(calls, 1);
});

test('source guards: current-user read only, no recipient enumeration, Telegram, RADAR, or execution', () => {
  const source = readFileSync(new URL('../netlify/functions/cockpit-personal-watch-diagnostic-target.mjs', import.meta.url), 'utf8');
  assert.match(source, /getRecord\(identity\.userId\)/);
  assert.doesNotMatch(source, /listPersonalWatchRecipients|list\s*\(/);
  for (const forbidden of [/api\.telegram\.org/i, /TG_BOT_TOKEN/, /chat_id/i, /loadFleet|saveFleet|ENTRY_READY/, /\/order\b/i, /\/sapi\b/i, /\/dapi\b/i, /\/fapi\b/i, /fetch\s*\(/]) {
    assert.doesNotMatch(source, forbidden);
  }
});
