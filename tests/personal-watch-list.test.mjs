// Backend API tests for the Cockpit personal watch-list endpoint (Phase 3).
//
// Scope: /api/cockpit-personal-watch-list CRUD only. It stores a per-user list
// of symbols to be alerted on in a FUTURE phase; it NEVER sends Telegram, never
// touches Binance/orders/execution, and never returns the raw chat id. These
// tests lock in auth, validation, dedup, cap, per-user isolation, coexistence
// with the chat id, and the safety guarantees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runPersonalWatchList } from '../netlify/functions/cockpit-personal-watch-list.mjs';
import {
  MAX_WATCHES_PER_USER,
  saveTelegramChatId,
  loadPersonalWatchSettings,
  maskChatId,
  __setPersonalWatchBlobStoreForTest,
} from '../netlify/functions/_personal-watch-store.mjs';

const URL = 'https://swingterminalx.netlify.app/api/cockpit-personal-watch-list';
const CHAT_A = '552398471';

const USER_A = { ok: true, userId: 'user-A-uuid-0001', email: 'a@example.com' };
const USER_B = { ok: true, userId: 'user-B-uuid-0002', email: 'b@example.com' };
const ANON = { ok: false, reason: 'No bearer token' };

function makeFakeBlobStore() {
  const m = new Map();
  return {
    async get(key, opts) {
      const v = m.get(key);
      if (v === undefined) return null;
      return opts && opts.type === 'json' ? JSON.parse(v) : v;
    },
    async setJSON(key, val) { m.set(key, JSON.stringify(val)); },
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

function call(method, { identity = USER_A, body, origin } = {}) {
  return runPersonalWatchList(makeReq(method, { body, origin }), { getIdentity: async () => identity });
}

test.beforeEach(() => {
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
    if (method !== 'GET') opts.body = { symbol: 'BTCUSDT' };
    const res = await call(method, opts);
    assert.equal(res.status, 401, `${method} should be 401`);
    const body = await res.json();
    assert.equal(body.ok, false);
  }
});

test('null identity is also rejected with 401', async () => {
  const res = await call('GET', { identity: null });
  assert.equal(res.status, 401);
});

test('POST with invalid JSON returns 400', async () => {
  const res = await call('POST', { body: '{ not valid json' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Invalid JSON/i);
});

test('POST with an oversized body fails closed with 400', async () => {
  const res = await call('POST', { body: 'x'.repeat(10_001) });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /too large/i);
});

test('POST rejects invalid symbols with 400', async () => {
  const invalid = {
    empty: '',
    onlyWhitespace: '   ',
    spaces: 'BTC USDT',
    slash: 'BTC/USDT',
    punctuation: 'BTC-USDT',
    injection: "BTC';DROP",
    tooLong: 'ABCDEFGHIJKLMNOPQRSTU', // 21 chars
    tooShort: 'B', // 1 char
  };
  for (const [label, symbol] of Object.entries(invalid)) {
    const res = await call('POST', { body: { symbol } });
    assert.equal(res.status, 400, `${label} should be 400`);
    const body = await res.json();
    assert.equal(body.ok, false, `${label} ok=false`);
  }
});

test('POST normalizes a lowercase-but-otherwise-valid symbol to uppercase', async () => {
  const res = await call('POST', { body: { symbol: 'btcusdt' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.watches.map((w) => w.symbol), ['BTCUSDT']);
});

test('POST valid symbol adds a watch; GET returns it with a server-assigned addedAt', async () => {
  const post = await call('POST', { body: { symbol: 'BTCUSDT' } });
  assert.equal(post.status, 200);
  const postBody = await post.json();
  assert.equal(postBody.count, 1);
  assert.equal(postBody.max, MAX_WATCHES_PER_USER);
  assert.equal(postBody.watches[0].symbol, 'BTCUSDT');
  assert.ok(postBody.watches[0].addedAt, 'addedAt assigned by server');

  const get = await call('GET', {});
  const getBody = await get.json();
  assert.deepEqual(getBody.watches.map((w) => w.symbol), ['BTCUSDT']);
});

test('duplicate add does not duplicate (idempotent)', async () => {
  await call('POST', { body: { symbol: 'BTCUSDT' } });
  const second = await call('POST', { body: { symbol: 'btcusdt' } });
  const body = await second.json();
  assert.equal(body.count, 1);
  assert.deepEqual(body.watches.map((w) => w.symbol), ['BTCUSDT']);
});

test('DELETE removes a watch', async () => {
  await call('POST', { body: { symbol: 'BTCUSDT' } });
  await call('POST', { body: { symbol: 'ETHUSDT' } });
  const del = await call('DELETE', { body: { symbol: 'BTCUSDT' } });
  const body = await del.json();
  assert.deepEqual(body.watches.map((w) => w.symbol), ['ETHUSDT']);
});

test('DELETE of a missing symbol is idempotent (200, unchanged list)', async () => {
  await call('POST', { body: { symbol: 'ETHUSDT' } });
  const del = await call('DELETE', { body: { symbol: 'BTCUSDT' } });
  assert.equal(del.status, 200);
  const body = await del.json();
  assert.deepEqual(body.watches.map((w) => w.symbol), ['ETHUSDT']);
});

test('cap is enforced at MAX_WATCHES_PER_USER', async () => {
  for (let i = 0; i < MAX_WATCHES_PER_USER; i++) {
    const res = await call('POST', { body: { symbol: `SYM${i}` } });
    assert.equal(res.status, 200, `add ${i} should succeed`);
  }
  const over = await call('POST', { body: { symbol: 'ONEMORE' } });
  assert.equal(over.status, 400);
  const body = await over.json();
  assert.match(body.error, /full|max/i);

  // The list is still exactly at the cap.
  const get = await call('GET', {});
  const getBody = await get.json();
  assert.equal(getBody.count, MAX_WATCHES_PER_USER);
});

test('cross-user isolation: user B never sees user A watches', async () => {
  await call('POST', { identity: USER_A, body: { symbol: 'BTCUSDT' } });
  const bGet = await call('GET', { identity: USER_B });
  const bBody = await bGet.json();
  assert.equal(bBody.count, 0);

  await call('POST', { identity: USER_B, body: { symbol: 'ETHUSDT' } });
  const aGet = await call('GET', { identity: USER_A });
  const aBody = await aGet.json();
  assert.deepEqual(aBody.watches.map((w) => w.symbol), ['BTCUSDT']);
});

test('a body-supplied userId cannot hijack ownership', async () => {
  await call('POST', { identity: USER_A, body: { symbol: 'BTCUSDT', userId: USER_B.userId } });
  const bGet = await call('GET', { identity: USER_B });
  const bBody = await bGet.json();
  assert.equal(bBody.count, 0, 'B still has nothing');
});

test('adding/removing watches does NOT clear the existing telegramChatId', async () => {
  // Seed a chat id via the store, then mutate the watch list through the API.
  await saveTelegramChatId(USER_A, CHAT_A);
  await call('POST', { identity: USER_A, body: { symbol: 'BTCUSDT' } });
  await call('DELETE', { identity: USER_A, body: { symbol: 'BTCUSDT' } });

  const record = await loadPersonalWatchSettings(USER_A);
  assert.equal(record.telegramChatId, CHAT_A, 'chat id preserved through watch mutations');
});

test('watch responses NEVER include a raw chat id', async () => {
  await saveTelegramChatId(USER_A, CHAT_A);
  const post = await call('POST', { identity: USER_A, body: { symbol: 'BTCUSDT' } });
  const get = await call('GET', { identity: USER_A });
  for (const res of [post, get]) {
    const raw = JSON.stringify(await res.json());
    assert.ok(!raw.includes(CHAT_A), 'raw chat id must never appear');
    assert.ok(!raw.includes('telegramChatId'), 'no chat id field in watch responses');
    // Not even the masked value belongs in the watch-list payload.
    assert.ok(!raw.includes(maskChatId(CHAT_A)), 'no masked chat id in watch payload');
  }
});

test('memory fallback still stores/reads watches when Blobs is unavailable', async () => {
  __setPersonalWatchBlobStoreForTest(null);
  const post = await call('POST', { body: { symbol: 'BTCUSDT' } });
  assert.equal(post.status, 200);
  const get = await call('GET', {});
  const body = await get.json();
  assert.deepEqual(body.watches.map((w) => w.symbol), ['BTCUSDT']);
});

test('unsupported method returns 405', async () => {
  const res = await call('PUT', {});
  assert.equal(res.status, 405);
});

test('source guard: watch-list files contain no Telegram-send / Binance / execution paths', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    'netlify/functions/_personal-watch-store.mjs',
    'netlify/functions/cockpit-personal-watch-list.mjs',
  ];
  const forbidden = [
    /api\.telegram\.org/i,
    /\bBOT_TOKEN\b/, /TELEGRAM_BOT_TOKEN/,
    /\/order\b/, /\/sapi\b/, /\/dapi\b/, /\/fapi\b/,
    /BINANCE_API_KEY/, /BINANCE_API_SECRET/,
    /\bsignature\b/i,
    /create-execution-intent/, /execution-intent/, /worker-session/,
    /ENTRY_READY/,
  ];
  for (const rel of files) {
    const text = readFileSync(join(root, rel), 'utf8');
    for (const pat of forbidden) {
      assert.ok(!pat.test(text), `${rel} must not contain ${pat}`);
    }
    assert.ok(!/\bfetch\s*\(/.test(text), `${rel} must not make outbound fetch calls`);
  }
});
