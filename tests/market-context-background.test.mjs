import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchBackgroundCollection } from '../netlify/functions/market-context-collect-scheduled.mjs';
import backgroundHandler from '../netlify/functions/market-context-collect-background.mjs';

const ENV = { CONTROL_BASE_URL: 'https://example.invalid', BOT_WORKER_TOKEN: 'secret-token-value' };
const headers = (map) => ({ get: (key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null) });

function captureWarnings(fn) {
  const warnings = []; const original = console.warn; console.warn = (...args) => warnings.push(args.map(String).join(' '));
  return Promise.resolve().then(fn).finally(() => { console.warn = original; }).then((value) => ({ value, warnings }));
}

test('dispatch posts to the background function with the worker token and accepts only 202', async () => {
  const seen = [];
  const res = await dispatchBackgroundCollection(ENV, async (url, init) => { seen.push({ url, init }); return { status: 202 }; });
  assert.equal(res.ok, true);
  assert.equal(seen[0].url, 'https://example.invalid/.netlify/functions/market-context-collect-background');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['x-bot-worker-token'], ENV.BOT_WORKER_TOKEN);
});

test('a non-202 dispatch is a visible failure, never a silently healthy cycle', async () => {
  const { value, warnings } = await captureWarnings(() => dispatchBackgroundCollection(ENV, async () => ({ status: 500 })));
  assert.equal(value.ok, false);
  assert.equal(value.reason, 'BACKGROUND_DISPATCH_REJECTED');
  assert.ok(warnings.some((w) => w.includes('background_dispatch_rejected')));
});

test('a thrown dispatch is reported, not swallowed', async () => {
  const { value, warnings } = await captureWarnings(() => dispatchBackgroundCollection(ENV, async () => { throw new Error('network down'); }));
  assert.equal(value.ok, false);
  assert.equal(value.reason, 'BACKGROUND_DISPATCH_FAILED');
  assert.ok(warnings.some((w) => w.includes('background_dispatch_failed')));
  // The failure reason must never carry the upstream message verbatim.
  assert.ok(!warnings.some((w) => w.includes('network down')));
});

test('missing configuration fails closed instead of calling an unauthenticated URL', async () => {
  let called = false;
  const res = await dispatchBackgroundCollection({ CONTROL_BASE_URL: 'https://example.invalid' }, async () => { called = true; return { status: 202 }; });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'BACKGROUND_DISPATCH_MISCONFIGURED');
  assert.equal(called, false, 'no request may be made without a token');
});

test('the background endpoint rejects a call with no token, a wrong token, and never echoes it', async () => {
  const original = process.env.BOT_WORKER_TOKEN;
  process.env.BOT_WORKER_TOKEN = ENV.BOT_WORKER_TOKEN;
  try {
    const anonymous = await backgroundHandler({ headers: headers({}) });
    assert.equal(anonymous.status, 401);
    const wrong = await backgroundHandler({ headers: headers({ 'x-bot-worker-token': 'not-the-token' }) });
    assert.equal(wrong.status, 401);
    const body = await wrong.text();
    assert.ok(!body.includes(ENV.BOT_WORKER_TOKEN), 'the response must never contain the expected token');
  } finally { if (original === undefined) delete process.env.BOT_WORKER_TOKEN; else process.env.BOT_WORKER_TOKEN = original; }
});

test('the background endpoint fails closed when the server has no token configured', async () => {
  const original = process.env.BOT_WORKER_TOKEN;
  delete process.env.BOT_WORKER_TOKEN;
  try {
    const res = await backgroundHandler({ headers: headers({ 'x-bot-worker-token': 'anything' }) });
    assert.equal(res.status, 500);
  } finally { if (original !== undefined) process.env.BOT_WORKER_TOKEN = original; }
});
