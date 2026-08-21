// Canonical context store consumers — every user-facing one must fail closed
// on a stale published run.
//
// /api/context already expires a run older than 30 minutes (503 STALE_EXPIRED).
// This file covers the NON-HTTP consumers that read the same store directly and
// could therefore bypass that: they must refuse stale data on their own.
//
// AUDIT RESULT pinned by these tests:
//
//   consumer                          | classification            | guard
//   ----------------------------------|---------------------------|--------------------------
//   context.mjs                       | user-facing terminal read | maxAgeMs 30m (503)
//   _personal-watch-notifier.mjs      | TELEGRAM watch alerts     | maxAgeMs 30m (this branch)
//   morning-briefing.mjs (+ builder)  | TELEGRAM briefing         | own 15m budget, withholds
//   cron-alerts.mjs (getPublishedRadar)| TELEGRAM ENTRY_READY     | own RADAR_STALE guard (6m)
//   _radar-context-publisher.mjs      | internal producer         | flag-disabled, no-op
//   _market-context-collector.mjs     | internal producer         | flag-disabled, no-op
//
// No Telegram message is sent by any test here: every sender is a stub that
// records the call instead of performing it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  runPersonalWatchTriggers,
  PERSONAL_WATCH_MAX_CONTEXT_AGE_MS,
  REASON_CONTEXT_STALE_EXPIRED,
} from '../netlify/functions/_personal-watch-notifier.mjs';
import { getAtomizedMarketContext } from '../netlify/functions/_market-context-store.mjs';
import { CONTEXT_HARD_MAX_AGE_MS } from '../netlify/functions/context.mjs';
import {
  buildMarketContext,
  gatherBriefingData,
  maxDataAgeMs,
  DEFAULT_MAX_DATA_AGE_MS,
  MORNING_BRIEFING_DATA_REASONS,
} from '../scripts/briefing/morning-briefing.mjs';
import { CANONICAL_RADAR_STALE_MS, loadCanonicalRadarForAlerts } from '../netlify/functions/cron-alerts.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const NOW = 1_700_000_000_000;
const MIN = 60_000;
const AGE_28H = 28 * 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();

// ── shared harness for the personal-watch notifier ───────────────────────────
// `sendMessage` NEVER sends: it records, so a regression that tries to alert on
// stale data shows up as a recorded call rather than as a real Telegram message.
function watchHarness({ observedAt, sendCalls = [], recipientReads = [] }) {
  const tickers = [{ market: 'spot', symbol: 'SOLUSDT', base_asset: 'SOL', quote_asset: 'USDT', last_price: '100', price_change_percent: '25', change_1h_pct: '12', quote_volume: '9e8' }];
  return {
    sendCalls,
    recipientReads,
    deps: {
      env: { PERSONAL_WATCH_TRIGGERS_ENABLED: 'true', TG_BOT_TOKEN: 'stub-token' },
      nowMs: NOW,
      database: {},
      // The REAL store function, against a fake db, so the guard is exercised
      // end to end rather than mocked away.
      contextStore: {
        getAtomizedMarketContext: async (_db, opts) => getAtomizedMarketContext({
          async query(sql) {
            if (/FROM market_collection_runs/.test(sql)) return { rows: [{ id: 1, run_key: 'k', observed_at: observedAt, completed_at: observedAt, diagnostics: {} }] };
            if (/market_ticker_observations/.test(sql)) return { rows: tickers };
            return { rows: [] };
          },
        }, opts),
      },
      store: {
        listPersonalWatchRecipients: async () => {
          recipientReads.push(1);
          return { ok: true, durable: true, recipients: [{ userId: 'u1', telegramChatId: '123', watches: [{ symbol: 'SOL' }] }] };
        },
        getPersonalAlertState: async () => ({ watchTriggers: {} }),
        savePersonalAlertState: async () => ({ ok: true }),
      },
      sendMessage: async (token, chatId, text) => { sendCalls.push({ chatId, text }); return { ok: true }; },
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 1. personal-watch notifier — the consumer this branch fixes
// ─────────────────────────────────────────────────────────────

test('personal-watch: a 28h context sends NOTHING and names the reason', async () => {
  const h = watchHarness({ observedAt: iso(NOW - AGE_28H) });
  const res = await runPersonalWatchTriggers(h.deps);
  assert.equal(res.ok, false);
  assert.equal(res.enabled, true);
  assert.equal(res.reason, REASON_CONTEXT_STALE_EXPIRED);
  assert.equal(res.sent, 0);
  assert.equal(res.evaluated, 0);
  assert.deepEqual(h.sendCalls, [], 'NO Telegram send may occur on stale context');
});

test('personal-watch: it refuses BEFORE reading recipients or building a message', async () => {
  const h = watchHarness({ observedAt: iso(NOW - AGE_28H) });
  await runPersonalWatchTriggers(h.deps);
  assert.deepEqual(h.recipientReads, [], 'recipients must not even be read');
  assert.deepEqual(h.sendCalls, []);
});

test('personal-watch: stale market rows are never used for a trigger decision', async () => {
  // The fixture is a 25% mover with a 12% 1h move — it WOULD trigger if the
  // rows were used. Proof the refusal happens before evaluation, not after.
  const stale = watchHarness({ observedAt: iso(NOW - AGE_28H) });
  const staleRes = await runPersonalWatchTriggers(stale.deps);
  assert.equal(staleRes.evaluated, 0);
  assert.deepEqual(stale.sendCalls, []);

  // Same fixture, FRESH run: the path works and does send — so the guard is
  // what changed the outcome, not a broken harness.
  const fresh = watchHarness({ observedAt: iso(NOW - 2 * MIN) });
  const freshRes = await runPersonalWatchTriggers(fresh.deps);
  assert.equal(freshRes.reason, undefined, 'a fresh run must not be refused');
  assert.ok(freshRes.evaluated >= 1, 'fresh context is evaluated');
  assert.ok(fresh.sendCalls.length >= 1, 'fresh context still notifies');
});

test('personal-watch: the boundary is the shared 30-minute budget', async () => {
  assert.equal(PERSONAL_WATCH_MAX_CONTEXT_AGE_MS, 30 * MIN);
  assert.equal(PERSONAL_WATCH_MAX_CONTEXT_AGE_MS, CONTEXT_HARD_MAX_AGE_MS, 'one line for every store consumer');
  const inside = watchHarness({ observedAt: iso(NOW - (PERSONAL_WATCH_MAX_CONTEXT_AGE_MS - 1000)) });
  assert.notEqual((await runPersonalWatchTriggers(inside.deps)).reason, REASON_CONTEXT_STALE_EXPIRED);
  const outside = watchHarness({ observedAt: iso(NOW - (PERSONAL_WATCH_MAX_CONTEXT_AGE_MS + 1000)) });
  assert.equal((await runPersonalWatchTriggers(outside.deps)).reason, REASON_CONTEXT_STALE_EXPIRED);
  assert.deepEqual(outside.sendCalls, []);
});

test('personal-watch: a genuine read failure stays its own distinct reason', async () => {
  const sendCalls = [];
  const res = await runPersonalWatchTriggers({
    env: { PERSONAL_WATCH_TRIGGERS_ENABLED: 'true', TG_BOT_TOKEN: 'stub' },
    nowMs: NOW, database: {},
    contextStore: { getAtomizedMarketContext: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }) },
    store: { listPersonalWatchRecipients: async () => ({ ok: true, durable: true, recipients: [] }), getPersonalAlertState: async () => ({}) },
    sendMessage: async (...a) => { sendCalls.push(a); return { ok: true }; },
  });
  assert.equal(res.reason, 'CONTEXT_UNAVAILABLE');
  assert.notEqual(res.reason, REASON_CONTEXT_STALE_EXPIRED);
  assert.deepEqual(sendCalls, []);
});

test('personal-watch: the disabled flag still short-circuits first', async () => {
  const sendCalls = [];
  const res = await runPersonalWatchTriggers({
    env: {}, nowMs: NOW,
    contextStore: { getAtomizedMarketContext: async () => { throw new Error('must not be reached'); } },
    sendMessage: async (...a) => { sendCalls.push(a); return { ok: true }; },
  });
  assert.equal(res.reason, 'PERSONAL_WATCH_TRIGGERS_DISABLED');
  assert.deepEqual(sendCalls, []);
});

test('personal-watch: the guard is wired with the shared clock, not its own', () => {
  const src = read('netlify/functions/_personal-watch-notifier.mjs');
  assert.match(src, /maxAgeMs: PERSONAL_WATCH_MAX_CONTEXT_AGE_MS, now: nowMs,/);
  // Refusal precedes recipients and any send.
  const body = src.slice(src.indexOf('export async function runPersonalWatchTriggers'));
  assert.ok(body.indexOf('REASON_CONTEXT_STALE_EXPIRED') < body.indexOf('listPersonalWatchRecipients'));
  assert.ok(body.indexOf('REASON_CONTEXT_STALE_EXPIRED') < body.indexOf('sendMessage(token'));
});

// ─────────────────────────────────────────────────────────────
// 2. morning briefing — ALREADY fail-closed; pinned so it stays that way
// ─────────────────────────────────────────────────────────────

test('briefing: a 28h canonical run yields NO market rows', () => {
  const canonical = {
    ok: true,
    market: { observedAt: iso(NOW - AGE_28H), freshness: 'STALE', tickers: [{ market: 'spot', symbol: 'BTCUSDT', base_asset: 'BTC', quote_asset: 'USDT', last_price: '60000', price_change_percent: '5', quote_volume: '9e8' }] },
    radar: { status: 'PENDING', candidates: [] },
  };
  const ctx = buildMarketContext({ canonical, fleet: {}, env: {}, nowMs: NOW });
  assert.equal(ctx.market.usable, false, 'a 28h axis is not usable');
  assert.equal(ctx.market.reason, MORNING_BRIEFING_DATA_REASONS.MARKET_STALE);
  const data = gatherBriefingData({}, {}, ctx);
  assert.equal(data.marketRowsUsed, 0, 'a stale axis must contribute NOTHING');
  assert.equal(data.freshness.marketUsable, false);
  assert.equal(data.freshness.marketReason, MORNING_BRIEFING_DATA_REASONS.MARKET_STALE);
});

test('briefing: a fresh canonical run is used normally', () => {
  const canonical = {
    ok: true,
    market: { observedAt: iso(NOW - 2 * MIN), freshness: 'FRESH', tickers: [{ market: 'spot', symbol: 'BTCUSDT', base_asset: 'BTC', quote_asset: 'USDT', last_price: '60000', price_change_percent: '5', quote_volume: '9e8' }] },
    radar: { status: 'PENDING', candidates: [] },
  };
  const ctx = buildMarketContext({ canonical, fleet: {}, env: {}, nowMs: NOW });
  assert.equal(ctx.market.usable, true);
  assert.equal(gatherBriefingData({}, {}, ctx).marketRowsUsed, 1);
});

test('briefing: its own budget is at least as strict as the store budget', () => {
  assert.equal(maxDataAgeMs({}), DEFAULT_MAX_DATA_AGE_MS);
  assert.equal(DEFAULT_MAX_DATA_AGE_MS, 15 * MIN);
  assert.ok(DEFAULT_MAX_DATA_AGE_MS <= CONTEXT_HARD_MAX_AGE_MS,
    'the briefing must not be looser than the 30m store budget');
});

test('briefing: the withholding line is intact — a stale axis contributes nothing', () => {
  const src = read('scripts/briefing/morning-briefing.mjs');
  assert.match(src, /const markets = marketFresh \? \(Array\.isArray\(ctx\.markets\) \? ctx\.markets : \[\]\) : \[\];/);
  assert.match(src, /const candidates = candidatesFresh \? \(Array\.isArray\(ctx\.candidates\) \? ctx\.candidates : \[\]\) : \[\];/);
  assert.match(src, /A stale\/absent axis contributes NOTHING/);
});

// ─────────────────────────────────────────────────────────────
// 3. cron-alerts (ENTRY_READY → Telegram) — already guarded; pinned
// ─────────────────────────────────────────────────────────────

test('cron-alerts: a stale canonical RADAR is refused, no alert path entered', async () => {
  const stale = await loadCanonicalRadarForAlerts({
    nowMs: NOW, database: {},
    store: { getPublishedRadar: async () => ({ ok: true, radar: { status: 'READY', computedAt: iso(NOW - AGE_28H), candidates: [] } }) },
  });
  assert.equal(stale.ok, false);
  assert.match(String(stale.reason), /STALE|PENDING|EMPTY/);
});

test('cron-alerts: its freshness budget is tighter than the store budget', () => {
  assert.equal(CANONICAL_RADAR_STALE_MS, 6 * MIN);
  assert.ok(CANONICAL_RADAR_STALE_MS <= CONTEXT_HARD_MAX_AGE_MS);
  const src = read('netlify/functions/cron-alerts.mjs');
  assert.match(src, /if \(shaped\.dataFreshnessMs > CANONICAL_RADAR_STALE_MS\) return \{ ok: false, reason: 'RADAR_STALE' \};/);
});

// ─────────────────────────────────────────────────────────────
// 4. internal-only producers stay flag-disabled
// ─────────────────────────────────────────────────────────────

test('the internal producers are still gated off and unchanged', () => {
  assert.match(read('netlify/functions/_market-context-collector.mjs'), /if \(!marketContextCollectAllowed\(env\)\) \{/);
  assert.match(read('netlify/functions/market-context-collect-scheduled.mjs'), /if \(!marketContextCollectAllowed\(process\.env\)\) \{/);
  const breaker = read('netlify/functions/_cost-breaker.mjs');
  assert.match(breaker, /return env\[flag\] === 'true';/);
  assert.match(breaker, /if \(masterKillSwitchEngaged\(env\)\) return false;/);
});

test('every direct getAtomizedMarketContext caller is accounted for', () => {
  // If a NEW caller appears, this fails and forces a freshness decision for it.
  const callers = ['netlify/functions/context.mjs', 'netlify/functions/morning-briefing.mjs', 'netlify/functions/_personal-watch-notifier.mjs'];
  const found = [];
  for (const dir of ['netlify/functions']) {
    for (const f of fs.readdirSync(new URL('../' + dir, import.meta.url))) {
      if (!f.endsWith('.mjs')) continue;
      const p = dir + '/' + f;
      const src = read(p);
      if (/getAtomizedMarketContext\(/.test(src) && !p.endsWith('_market-context-store.mjs')) found.push(p);
    }
  }
  assert.deepEqual(found.sort(), callers.sort(), 'a new canonical-store caller needs its own freshness guard');
});

// ─────────────────────────────────────────────────────────────
// 5. nothing else moved
// ─────────────────────────────────────────────────────────────

test('/api/context expiry behaviour is unchanged by this branch', () => {
  const src = read('netlify/functions/context.mjs');
  assert.equal(CONTEXT_HARD_MAX_AGE_MS, 30 * MIN);
  assert.match(src, /maxAgeMs: CONTEXT_HARD_MAX_AGE_MS, now,/);
  assert.match(src, /function staleExpiredResponse\(req, context, now, cacheState\)/);
  assert.match(src, /status: 503,/);
});

test('no Telegram credential, sender or message shape is touched', () => {
  const src = read('netlify/functions/_personal-watch-notifier.mjs');
  // The sender is still resolved the same way and still called the same way.
  assert.match(src, /async function loadSender\(\) \{ return \(await import\('\.\/personal-alerts\.mjs'\)\)\.sendPersonalTelegram; \}/);
  assert.match(src, /const result = await sendMessage\(token, chatId, buildTriggerMessage\(trigger\)\);/);
  // No credential handling added, no new env read.
  assert.doesNotMatch(src, /TG_BOT_TOKEN\s*=/);
  assert.equal((src.match(/TG_BOT_TOKEN/g) || []).length, 1, 'the token is read exactly where it always was');
});

test('no trading, RADAR gate, env write or collector re-enable in the touched file', () => {
  const src = read('netlify/functions/_personal-watch-notifier.mjs');
  // CODE only. The file's own header deliberately names ENTRY_READY to record
  // that this path must never influence it, and the new guard comment names the
  // disabled collector flag as context — both are documentation, not behaviour.
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['ENTRY_READY', 'newOrder', 'createOrder', 'placeOrder', 'evaluateAbsorb', 'MARKET_CONTEXT_COLLECT_ENABLED']) {
    assert.ok(!code.includes(forbidden), 'the code must not mention ' + forbidden);
  }
  assert.doesNotMatch(code, /process\.env\.[A-Z_]+\s*=/);
  assert.doesNotMatch(code, /INSERT |UPDATE |DELETE /);
  // ...and the header note that keeps the two alert paths separate is still there.
  assert.match(src, /loosen an entry signal/);
  assert.match(src, /a change here can never weaken the entry gate/);
});
