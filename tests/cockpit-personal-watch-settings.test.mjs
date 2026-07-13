// Backend API tests for the Cockpit personal-watch settings endpoint.
//
// Scope: /api/cockpit-personal-watch-settings CRUD only. This endpoint just
// stores a per-user Telegram chat id; it NEVER sends Telegram, never touches
// Binance/orders/execution, and has no frontend consumer yet. These tests lock
// in auth, validation, masking, per-user isolation, and the safety guarantees.
//
// The handler already supports dependency injection (`runPersonalWatchSettings(
// req, { getIdentity })`) and the store exposes a blob-store test hook, so we
// never weaken production auth to test it — we inject a verified identity and a
// fake in-memory blob backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runPersonalWatchSettings } from '../netlify/functions/cockpit-personal-watch-settings.mjs';
import {
  maskChatId,
  __setPersonalWatchBlobStoreForTest,
} from '../netlify/functions/_personal-watch-store.mjs';

const URL = 'https://swingterminalx.netlify.app/api/cockpit-personal-watch-settings';
const CHAT_A = '552398471'; // 9 digits → masked 5523••••71
const CHAT_B = '778811223';

const USER_A = { ok: true, userId: 'user-A-uuid-0001', email: 'a@example.com' };
const USER_B = { ok: true, userId: 'user-B-uuid-0002', email: 'b@example.com' };
const ANON = { ok: false, reason: 'No bearer token' };

// A deterministic in-memory stand-in for Netlify Blobs (durable path).
function makeFakeBlobStore() {
  const m = new Map();
  return {
    async get(key, opts) {
      const v = m.get(key);
      if (v === undefined) return null;
      return opts && opts.type === 'json' ? JSON.parse(v) : v;
    },
    async setJSON(key, val) {
      m.set(key, JSON.stringify(val));
    },
    _map: m,
  };
}

function makeReq(method, { body, origin } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(URL, init);
}

// Drive the handler with an injected identity (real store path otherwise).
function call(method, { identity = USER_A, body, origin } = {}) {
  return runPersonalWatchSettings(makeReq(method, { body, origin }), {
    getIdentity: async () => identity,
  });
}

test.beforeEach(() => {
  // Fresh, deterministic durable backend before each test.
  __setPersonalWatchBlobStoreForTest(makeFakeBlobStore());
});

test('OPTIONS preflight returns 204 with CORS headers', async () => {
  const res = await call('OPTIONS', { origin: 'https://swingterminalx.netlify.app' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, POST, DELETE, OPTIONS');
});

test('unauthenticated GET/POST/DELETE are rejected with 401', async () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    const opts = { identity: ANON };
    if (method === 'POST') opts.body = { telegramChatId: CHAT_A };
    const res = await call(method, opts);
    assert.equal(res.status, 401, `${method} should be 401`);
    const bodyJson = await res.json();
    assert.equal(bodyJson.ok, false);
  }
});

test('null identity is also rejected with 401', async () => {
  const res = await call('GET', { identity: null });
  assert.equal(res.status, 401);
});

test('POST with invalid JSON returns 400', async () => {
  const res = await call('POST', { body: '{ not valid json' });
  assert.equal(res.status, 400);
  const bodyJson = await res.json();
  assert.equal(bodyJson.ok, false);
  assert.match(bodyJson.error, /Invalid JSON/i);
});

test('POST with an oversized body fails closed with 400 (before parse)', async () => {
  const huge = 'x'.repeat(10_001); // exceeds MAX_BODY_BYTES
  const res = await call('POST', { body: huge });
  assert.equal(res.status, 400);
  const bodyJson = await res.json();
  assert.match(bodyJson.error, /too large/i);
});

test('POST rejects invalid chat IDs with 400', async () => {
  const invalid = {
    empty: '',
    letters: 'abcde',
    symbols: '12!45',
    tooShort: '123', // < 5
    tooLong: '123456789012345678901', // 21 digits > 20
    withSpaces: '12 34 56',
  };
  for (const [label, value] of Object.entries(invalid)) {
    const res = await call('POST', { body: { telegramChatId: value } });
    assert.equal(res.status, 400, `${label} should be 400`);
    const bodyJson = await res.json();
    assert.equal(bodyJson.ok, false, `${label} ok=false`);
  }
});

test('POST with a valid chat ID stores it and returns ONLY a masked view', async () => {
  const res = await call('POST', { body: { telegramChatId: CHAT_A } });
  assert.equal(res.status, 200);
  const bodyJson = await res.json();
  assert.equal(bodyJson.ok, true);
  assert.equal(bodyJson.telegramConnected, true);
  assert.equal(bodyJson.telegramChatIdMasked, maskChatId(CHAT_A));
  assert.ok(bodyJson.telegramChatIdUpdatedAt, 'timestamp present');
  // The raw id must never appear in the response payload.
  assert.ok(!JSON.stringify(bodyJson).includes(CHAT_A), 'raw chat id must not be in response');
  assert.equal('telegramChatId' in bodyJson, false, 'no raw telegramChatId field');
});

test('GET after POST returns the masked value only (no raw id)', async () => {
  await call('POST', { body: { telegramChatId: CHAT_A } });
  const res = await call('GET', {});
  assert.equal(res.status, 200);
  const bodyJson = await res.json();
  assert.equal(bodyJson.telegramConnected, true);
  assert.equal(bodyJson.telegramChatIdMasked, maskChatId(CHAT_A));
  assert.ok(!JSON.stringify(bodyJson).includes(CHAT_A));
});

test('DELETE clears the stored chat ID', async () => {
  await call('POST', { body: { telegramChatId: CHAT_A } });
  const del = await call('DELETE', {});
  assert.equal(del.status, 200);
  const delJson = await del.json();
  assert.equal(delJson.telegramConnected, false);
  assert.equal(delJson.telegramChatIdMasked, null);

  const get = await call('GET', {});
  const getJson = await get.json();
  assert.equal(getJson.telegramConnected, false);
});

test('cross-user isolation: user B never sees user A value, and cannot overwrite it', async () => {
  await call('POST', { identity: USER_A, body: { telegramChatId: CHAT_A } });

  // B reads their own (empty) settings, not A's.
  const bGet = await call('GET', { identity: USER_B });
  const bJson = await bGet.json();
  assert.equal(bJson.telegramConnected, false);

  // B stores their own value.
  await call('POST', { identity: USER_B, body: { telegramChatId: CHAT_B } });

  // A is untouched and still masks to A's value; B masks to B's value.
  const aGet = await call('GET', { identity: USER_A });
  const aJson = await aGet.json();
  assert.equal(aJson.telegramChatIdMasked, maskChatId(CHAT_A));

  const bGet2 = await call('GET', { identity: USER_B });
  const bJson2 = await bGet2.json();
  assert.equal(bJson2.telegramChatIdMasked, maskChatId(CHAT_B));
  assert.notEqual(maskChatId(CHAT_A), maskChatId(CHAT_B));
});

test('a body-supplied userId cannot hijack ownership', async () => {
  // Even if the caller tries to smuggle another user's id in the body, the
  // record is keyed off the token identity only.
  await call('POST', { identity: USER_A, body: { telegramChatId: CHAT_A, userId: USER_B.userId } });
  const bGet = await call('GET', { identity: USER_B });
  const bJson = await bGet.json();
  assert.equal(bJson.telegramConnected, false, 'B still has nothing');
});

test('memory fallback still stores/reads when Blobs is unavailable', async () => {
  __setPersonalWatchBlobStoreForTest(null); // force non-durable path
  const post = await call('POST', { body: { telegramChatId: CHAT_A } });
  assert.equal(post.status, 200);
  const get = await call('GET', {});
  const getJson = await get.json();
  assert.equal(getJson.telegramConnected, true);
  assert.equal(getJson.telegramChatIdMasked, maskChatId(CHAT_A));
});

test('unsupported method returns 405', async () => {
  const res = await call('PUT', {});
  assert.equal(res.status, 405);
});

test('source guard: personal-watch files contain no Telegram-send / Binance / execution paths', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    'netlify/functions/_personal-watch-store.mjs',
    'netlify/functions/cockpit-personal-watch-settings.mjs',
  ];
  const forbidden = [
    /api\.telegram\.org/i,
    /\bBOT_TOKEN\b/,
    /TELEGRAM_BOT_TOKEN/,
    /\/order\b/,
    /\/sapi\b/, /\/dapi\b/, /\/fapi\b/,
    /BINANCE_API_KEY/, /BINANCE_API_SECRET/,
    /\bsignature\b/i,
    /create-execution-intent/,
    /execution-intent/,
    /worker-session/,
    /ENTRY_READY/,
  ];
  for (const rel of files) {
    const text = readFileSync(join(root, rel), 'utf8');
    for (const pat of forbidden) {
      assert.ok(!pat.test(text), `${rel} must not contain ${pat}`);
    }
    // No outbound HTTP at all in this settings endpoint.
    assert.ok(!/\bfetch\s*\(/.test(text), `${rel} must not make outbound fetch calls`);
  }
});
