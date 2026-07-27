import test from 'node:test';
import assert from 'node:assert/strict';
import { runPersonalWatchTriggers, PERSONAL_WATCH_TRIGGERS_ENV_FLAG } from '../netlify/functions/_personal-watch-notifier.mjs';
import handler from '../netlify/functions/personal-watch-triggers-scheduled.mjs';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const ENV = { [PERSONAL_WATCH_TRIGGERS_ENV_FLAG]: 'true', TG_BOT_TOKEN: 'tok' };

function harness(overrides = {}) {
  const sends = [];
  const persisted = [];
  return {
    sends, persisted,
    deps: {
      env: ENV, nowMs: NOW, database: {},
      contextStore: { getAtomizedMarketContext: async () => ({ ok: true, market: { tickers: overrides.tickers ?? [
        { market: 'spot', symbol: 'SOLUSDT', base_asset: 'SOL', last_price: 87, price_change_percent: -12, quote_volume: 1e8 },
      ] }, radar: { candidates: overrides.candidates ?? [
        { symbol: 'SOLUSDT', payload: { symbol: 'SOLUSDT', takeProfitCheckpoints: [110, 120], suggestedStop: 92, invalidationLevel: 88 } },
      ] } }) },
      store: {
        listPersonalWatchRecipients: async () => overrides.recipients ?? ({ ok: true, durable: true, recipients: [
          { userId: 'u1', telegramChatId: '111', watches: [{ symbol: 'SOL' }] },
        ] }),
        getPersonalAlertState: async () => ({ watchTriggers: overrides.state ?? {} }),
        updatePersonalAlertState: async (userId, fn) => { persisted.push({ userId, next: fn({}) }); },
      },
      sendMessage: async (_t, chatId, text) => { sends.push({ chatId, text }); return { ok: true }; },
      ...overrides.deps,
    },
  };
}

test('disabled by default: no database touched, nothing sent', async () => {
  let touched = false;
  const res = await runPersonalWatchTriggers({ env: {}, contextStore: { getAtomizedMarketContext: async () => { touched = true; return { ok: true }; } } });
  assert.equal(res.enabled, false);
  assert.equal(res.reason, 'PERSONAL_WATCH_TRIGGERS_DISABLED');
  assert.equal(touched, false);
});

test('a tracked coin that broke its invalidation and moved hard notifies once each', async () => {
  const h = harness();
  const res = await runPersonalWatchTriggers(h.deps);
  assert.equal(res.enabled, true);
  assert.equal(res.recipients, 1);
  assert.equal(res.sent, 2, 'one big move, one stop');
  const kinds = h.sends.map((s) => s.text.slice(0, 4));
  assert.ok(h.sends.some((s) => /moved -12%/.test(s.text)), 'big move reported');
  assert.ok(kinds.includes('[SL]'), 'stop reported');
  assert.equal(h.sends.every((s) => s.chatId === '111'), true);
  // Bookkeeping is persisted, or the same trigger resends every cycle.
  assert.equal(h.persisted.length, 1);
  assert.ok(h.persisted[0].next.watchTriggers['SOL:STOP_LOSS']);
});

test('a watched coin absent from the canonical universe is skipped, not guessed', async () => {
  const h = harness({ recipients: { ok: true, durable: true, recipients: [{ userId: 'u1', telegramChatId: '111', watches: [{ symbol: 'NOTLISTED' }] }] } });
  const res = await runPersonalWatchTriggers(h.deps);
  assert.equal(res.evaluated, 0);
  assert.equal(res.sent, 0);
});

test('a recipient with no chat id is never contacted', async () => {
  const h = harness({ recipients: { ok: true, durable: true, recipients: [{ userId: 'u1', telegramChatId: '', watches: [{ symbol: 'SOL' }] }] } });
  const res = await runPersonalWatchTriggers(h.deps);
  assert.equal(res.recipients, 0);
  assert.equal(h.sends.length, 0);
});

test('an unavailable context sends nothing rather than notifying on stale data', async () => {
  const h = harness();
  h.deps.contextStore = { getAtomizedMarketContext: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }) };
  const warn = console.warn; console.warn = () => {};
  try {
    const res = await runPersonalWatchTriggers(h.deps);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'CONTEXT_UNAVAILABLE');
    assert.equal(h.sends.length, 0);
  } finally { console.warn = warn; }
});

test('a failed send is counted and does not mark the trigger as delivered', async () => {
  const h = harness();
  h.deps.sendMessage = async () => ({ ok: false, reason: 'HTTP 429' });
  const warn = console.warn; console.warn = () => {};
  try {
    const res = await runPersonalWatchTriggers(h.deps);
    assert.equal(res.sent, 0);
    assert.ok(res.failed >= 1);
    assert.equal(h.persisted.length, 0, 'nothing may be recorded as sent');
  } finally { console.warn = warn; }
});

test('the scheduled entry point resolves to a Response', async () => {
  const res = await handler();
  assert.ok(res instanceof Response);
  assert.equal(res.status, 200);
});
