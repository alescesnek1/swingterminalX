// Emergency Netlify cost breaker — the guards that stop Netlify DATABASE
// compute draining.
//
// WHY THESE TESTS EXIST: Netlify bills database compute per GB-hour of an AWAKE
// database. Production sleeps the database after 5 minutes of inactivity, so any
// recurring touch under that interval keeps it awake permanently and bills
// continuously even when each query is cheap. The bill under investigation shows
// 920.63 GB-hours / 9,206.3 credits of database compute against a database that
// "still shows recent activity" — a sleep problem.
//
// Each test below asserts one thing: that a disabled path returns BEFORE it can
// connect, fetch, read or write. They assert cost behaviour only. No trading,
// order, signing, Telegram, ENTRY_READY or RADAR-gate behaviour is touched here
// or by the code they cover.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COST_BREAKER_MASTER_ENV_FLAG,
  costGuardHeaders,
  flagEnabled,
  marketContextCollectAllowed,
  masterKillSwitchEngaged,
  priceHistoryCollectAllowed,
  priceHistoryMetaReadsAllowed,
  priceHistoryPruneAllowed,
  priceHistoryReadsAllowed,
  priceHistoryScheduleAllowed,
  priceHistoryWritesAllowed,
  REASON_COST_BREAKER_DISABLED_PATH,
  REASON_DB_HISTORY_READS_DISABLED,
  REASON_MARKET_CONTEXT_COLLECT_DISABLED,
  REASON_PRICE_HISTORY_DISABLED,
} from '../netlify/functions/_cost-breaker.mjs';

import { runMarketContextCollector } from '../netlify/functions/_market-context-collector.mjs';
import { runPriceHistoryCollectScheduled } from '../netlify/functions/price-history-collect-scheduled.mjs';
import { runPriceHistoryPruneScheduled } from '../netlify/functions/price-history-prune-scheduled.mjs';
import { writeMarketSnapshotIfEnabled } from '../netlify/functions/_price-history-writer.mjs';
import { loadValuationHistoryForCandidates, applyValuationHistoryToRadar } from '../netlify/functions/_radar-valuation-context.mjs';
import { runContextRead, resetContextCacheForTests, CONTEXT_CACHE_DEFAULT_MS } from '../netlify/functions/context.mjs';
import { runCockpitRadarStateRead } from '../netlify/functions/cockpit-radar-state.mjs';

// ── 0. the gate itself fails closed ─────────────────────────────────────────

test('every gate requires the exact string "true" — unset, blank and lookalikes are OFF', () => {
  const gates = [
    priceHistoryScheduleAllowed, priceHistoryCollectAllowed, priceHistoryWritesAllowed,
    priceHistoryPruneAllowed, priceHistoryReadsAllowed, marketContextCollectAllowed,
  ];
  const flags = [
    'PRICE_HISTORY_SCHEDULE_ENABLED', 'PRICE_HISTORY_COLLECT_ENABLED', 'PRICE_HISTORY_WRITE_ENABLED',
    'PRICE_HISTORY_PRUNE_ENABLED', 'PRICE_HISTORY_READS_ENABLED', 'MARKET_CONTEXT_COLLECT_ENABLED',
  ];
  for (let i = 0; i < gates.length; i += 1) {
    const gate = gates[i]; const flag = flags[i];
    assert.equal(gate({}), false, `${flag} unset is OFF`);
    for (const value of ['', '   ', '1', 'TRUE', 'True', 'yes', 'on', 'false', 0, 1, true, null, undefined]) {
      assert.equal(gate({ [flag]: value }), false, `${flag}=${String(value)} is OFF`);
    }
    assert.equal(gate({ [flag]: 'true' }), true, `${flag}='true' is the only ON`);
  }
  // flagEnabled tolerates junk input rather than throwing.
  assert.equal(flagEnabled(null, 'X'), false);
  assert.equal(flagEnabled({}, ''), false);
});

test('the master kill switch engages only on the exact string "false", and can only ever subtract', () => {
  assert.equal(masterKillSwitchEngaged({}), false, 'unset does not blackout the app');
  assert.equal(masterKillSwitchEngaged({ [COST_BREAKER_MASTER_ENV_FLAG]: 'true' }), false);
  assert.equal(masterKillSwitchEngaged({ [COST_BREAKER_MASTER_ENV_FLAG]: 'FALSE' }), false, 'a typo cannot blackout');
  assert.equal(masterKillSwitchEngaged({ [COST_BREAKER_MASTER_ENV_FLAG]: 'false' }), true);
  // Engaged, it overrides every narrow ON flag.
  const allOn = {
    [COST_BREAKER_MASTER_ENV_FLAG]: 'false',
    PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true',
    PRICE_HISTORY_WRITE_ENABLED: 'true', PRICE_HISTORY_PRUNE_ENABLED: 'true',
    PRICE_HISTORY_READS_ENABLED: 'true', MARKET_CONTEXT_COLLECT_ENABLED: 'true',
  };
  assert.equal(priceHistoryScheduleAllowed(allOn), false);
  assert.equal(priceHistoryCollectAllowed(allOn), false);
  assert.equal(priceHistoryWritesAllowed(allOn), false);
  assert.equal(priceHistoryPruneAllowed(allOn), false);
  assert.equal(priceHistoryReadsAllowed(allOn), false);
  assert.equal(priceHistoryMetaReadsAllowed(allOn), false);
  assert.equal(marketContextCollectAllowed(allOn), false);
});

test('the observability headers carry stable codes only — never a secret or user value', () => {
  const h = costGuardHeaders(REASON_DB_HISTORY_READS_DISABLED, { 'Content-Type': 'application/json' });
  assert.equal(h['X-Cost-Guard'], 'engaged');
  assert.equal(h['X-DB-Read-Guard'], 'DB_HISTORY_READS_DISABLED');
  assert.equal(h['Content-Type'], 'application/json', 'existing headers are preserved');
  // An unrecognised reason never becomes a header value — no arbitrary string
  // (which could carry a token, an email or a connection detail) can get out.
  const junk = costGuardHeaders('postgres://user:pw@host/db');
  assert.equal(junk['X-Cost-Guard'], 'pass');
  assert.equal(junk['X-DB-Read-Guard'], undefined);
  for (const value of Object.values(h)) {
    assert.equal(/postgres:|Bearer |password|token=/i.test(String(value)), false);
  }
});

// ── 1. scheduled price-history returns before DB connect / fetch / write ─────

const SCHEDULER_SECRET = 'cost-breaker-test-scheduler-secret';
const SCHEDULER_HEADER = 'x-price-history-scheduler-secret';
const COLLECT_URL = 'https://swingterminalx.netlify.app/api/price-history-collect-scheduled';
const PRUNE_URL = 'https://swingterminalx.netlify.app/api/price-history-prune-scheduled';

function schedulerReq(url) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SCHEDULER_HEADER]: SCHEDULER_SECRET },
    body: '{}',
  });
}

// Every dependency is a tripwire: if a disabled run reaches any of them the test
// fails, which is the only way to prove "returns BEFORE the DB connection".
function tripwires() {
  const hit = { db: 0, fetch: 0, write: 0, prune: 0, moduleLoad: 0 };
  return {
    hit,
    loadPriceHistory: async () => { hit.moduleLoad += 1; throw new Error('module must not load'); },
    loadCoingeckoSource: async () => { hit.moduleLoad += 1; throw new Error('module must not load'); },
    getLatestSnapshotAt: async () => { hit.db += 1; return { ok: true, sampledAt: null }; },
    fetchCoinGeckoMarketRows: async () => { hit.fetch += 1; return { ok: true, rows: [{ symbol: 'btc', current_price: 1 }] }; },
    writeMarketPriceSnapshot: async () => { hit.write += 1; return { ok: true, snapshotId: 1 }; },
    pruneSnapshotsOlderThan: async () => { hit.prune += 1; return { ok: true, prunedSnapshots: 9 }; },
  };
}

test('1. scheduled price-history collect, SCHEDULE disabled: returns 200 before any DB connect, fetch or write', async () => {
  const t = tripwires();
  const res = await runPriceHistoryCollectScheduled(schedulerReq(COLLECT_URL), {
    ...t, env: { PRICE_HISTORY_SCHEDULER_SECRET: SCHEDULER_SECRET },
  });
  assert.equal(res.status, 200, 'never a 500, and never a status that makes the scheduler retry-storm');
  const body = await res.json();
  assert.equal(body.reason, 'SCHEDULE_DISABLED');
  assert.equal(body.costGuard, REASON_PRICE_HISTORY_DISABLED);
  assert.equal(body.collected, false);
  assert.deepEqual(t.hit, { db: 0, fetch: 0, write: 0, prune: 0, moduleLoad: 0 });
  assert.equal(res.headers.get('X-Cost-Guard'), 'engaged');
  assert.equal(res.headers.get('X-DB-Read-Guard'), REASON_PRICE_HISTORY_DISABLED);
});

test('1b. scheduled price-history collect, COLLECT disabled: same — schedule on, collection off', async () => {
  const t = tripwires();
  const res = await runPriceHistoryCollectScheduled(schedulerReq(COLLECT_URL), {
    ...t,
    env: { PRICE_HISTORY_SCHEDULER_SECRET: SCHEDULER_SECRET, PRICE_HISTORY_SCHEDULE_ENABLED: 'true' },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).reason, 'COLLECT_DISABLED');
  assert.deepEqual(t.hit, { db: 0, fetch: 0, write: 0, prune: 0, moduleLoad: 0 });
});

test('1c. the master kill switch alone disables the scheduled collector even with every flag on', async () => {
  const t = tripwires();
  const res = await runPriceHistoryCollectScheduled(schedulerReq(COLLECT_URL), {
    ...t,
    env: {
      PRICE_HISTORY_SCHEDULER_SECRET: SCHEDULER_SECRET,
      PRICE_HISTORY_SCHEDULE_ENABLED: 'true', PRICE_HISTORY_COLLECT_ENABLED: 'true',
      PRICE_HISTORY_WRITE_ENABLED: 'true',
      [COST_BREAKER_MASTER_ENV_FLAG]: 'false',
    },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).reason, 'SCHEDULE_DISABLED');
  assert.deepEqual(t.hit, { db: 0, fetch: 0, write: 0, prune: 0, moduleLoad: 0 });
});

test('1d. the scheduler auth gate still runs first — the breaker weakens no auth', async () => {
  const t = tripwires();
  const unauthed = new Request(COLLECT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const res = await runPriceHistoryCollectScheduled(unauthed, {
    ...t, env: { PRICE_HISTORY_SCHEDULER_SECRET: SCHEDULER_SECRET },
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).reason, 'SCHEDULER_UNAUTHENTICATED');
});

test('1e. scheduled prune disabled: deletes nothing, returns 200, never loads the storage module', async () => {
  const t = tripwires();
  const res = await runPriceHistoryPruneScheduled(schedulerReq(PRUNE_URL), {
    ...t,
    // Retention days deliberately set: the breaker must return before the
    // retention value is even considered.
    env: { PRICE_HISTORY_SCHEDULER_SECRET: SCHEDULER_SECRET, PRICE_HISTORY_RETENTION_DAYS: '14' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reason, 'PRUNE_DISABLED');
  assert.equal(body.prunedSnapshots, 0);
  assert.equal(t.hit.prune, 0, 'no DELETE was issued');
  assert.equal(t.hit.moduleLoad, 0);
  assert.equal(res.headers.get('X-DB-Read-Guard'), REASON_PRICE_HISTORY_DISABLED);
});

// ── 2. market-context collector returns before DB connect / fetch / write ────

test('2. market-context collector disabled: returns 200 before the store module, the DB or any upstream fetch', async () => {
  let storeLoaded = 0; let sourceLoaded = 0; let txOpened = 0; let dbCreated = 0;
  const result = await runMarketContextCollector({
    env: {},   // MARKET_CONTEXT_COLLECT_ENABLED unset — the emergency default
    loadStore: async () => { storeLoaded += 1; throw new Error('store must not load'); },
    loadSource: async () => { sourceLoaded += 1; throw new Error('source must not load'); },
    withTransaction: async () => { txOpened += 1; return { ok: true }; },
    getDbImpl: () => { dbCreated += 1; throw new Error('getDb must not be called'); },
    fetchImpl: () => { throw new Error('no upstream fetch on a disabled cycle'); },
  });
  assert.equal(result.status, 200, 'a disabled cycle is not a failure — Netlify must not retry it');
  assert.equal(result.body.skipped, true);
  assert.equal(result.body.reason, 'COLLECT_DISABLED');
  assert.equal(result.body.costGuard, REASON_MARKET_CONTEXT_COLLECT_DISABLED);
  assert.equal(storeLoaded, 0, 'the Postgres store module was never imported');
  assert.equal(sourceLoaded, 0, 'the Binance source module was never imported');
  assert.equal(txOpened, 0, 'no transaction was opened');
  assert.equal(dbCreated, 0, 'no connection was created');
});

test('2b. the master kill switch disables the market-context collector even with the collect flag on', async () => {
  let txOpened = 0;
  const result = await runMarketContextCollector({
    env: { MARKET_CONTEXT_COLLECT_ENABLED: 'true', [COST_BREAKER_MASTER_ENV_FLAG]: 'false' },
    loadStore: async () => { throw new Error('store must not load'); },
    withTransaction: async () => { txOpened += 1; return { ok: true }; },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.reason, 'COLLECT_DISABLED');
  assert.equal(txOpened, 0);
});

test('2c. the scheduled market-context entrypoint returns before it can even dispatch the background cycle', async () => {
  // The background branch used to fire an HTTP call to the background function
  // BEFORE the collector flag was consulted — a second function invocation
  // every three minutes for a collector that was switched off.
  const mod = await import('../netlify/functions/market-context-collect-scheduled.mjs');
  const saved = {
    collect: process.env.MARKET_CONTEXT_COLLECT_ENABLED,
    background: process.env.MARKET_CONTEXT_BACKGROUND_ENABLED,
    base: process.env.CONTROL_BASE_URL,
    token: process.env.BOT_WORKER_TOKEN,
  };
  try {
    delete process.env.MARKET_CONTEXT_COLLECT_ENABLED;
    process.env.MARKET_CONTEXT_BACKGROUND_ENABLED = 'true';
    process.env.CONTROL_BASE_URL = 'https://swingterminalx.netlify.app';
    process.env.BOT_WORKER_TOKEN = 'test-worker-token';
    const res = await mod.default();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reason, 'COLLECT_DISABLED');
    assert.equal(body.dispatchedToBackground, false, 'no background invocation was spent');
    assert.equal(body.costGuard, REASON_MARKET_CONTEXT_COLLECT_DISABLED);
    assert.equal(res.headers.get('X-DB-Read-Guard'), REASON_MARKET_CONTEXT_COLLECT_DISABLED);
  } finally {
    for (const [key, value] of Object.entries({
      MARKET_CONTEXT_COLLECT_ENABLED: saved.collect,
      MARKET_CONTEXT_BACKGROUND_ENABLED: saved.background,
      CONTROL_BASE_URL: saved.base,
      BOT_WORKER_TOKEN: saved.token,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ── 3. a write-disabled path cannot write even if the caller tries ───────────

test('3. write disabled: the storage module refuses even when a caller passes a working connection', async () => {
  // Bypass every endpoint and call the storage layer directly with a perfectly
  // good injected pool — the emergency gate lives INSIDE the module, so the
  // caller cannot route around it.
  const { writeMarketPriceSnapshot } = await import('../netlify/functions/_price-history.mjs');
  let connects = 0; let queries = 0;
  const workingDb = () => ({
    pool: {
      connect: async () => { connects += 1; return { query: async () => { queries += 1; return { rows: [{ id: 1 }] }; }, release() {} }; },
      query: async () => { queries += 1; return { rows: [{ id: 1 }] }; },
    },
  });
  const res = await writeMarketPriceSnapshot(
    { source: 'cost-breaker-test', rows: [{ symbol: 'btc', current_price: 1, name: 'Bitcoin' }] },
    { env: {}, getDbImpl: workingDb },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, REASON_PRICE_HISTORY_DISABLED);
  assert.equal(res.written, false);
  assert.equal(res.inserted, 0);
  assert.equal(connects, 0, 'no connection was taken from the pool');
  assert.equal(queries, 0, 'no statement ran');
});

test('3b. the prune path cannot delete when disabled, even with a valid retention and a working connection', async () => {
  const { pruneSnapshotsOlderThan } = await import('../netlify/functions/_price-history.mjs');
  let queries = 0;
  const res = await pruneSnapshotsOlderThan({ days: 14 }, {
    env: {},
    getDbImpl: () => ({ pool: { query: async () => { queries += 1; return { rows: [], rowCount: 0 }; } } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, REASON_PRICE_HISTORY_DISABLED);
  assert.equal(res.prunedSnapshots, 0);
  assert.equal(queries, 0, 'no DELETE ran');
});

test('3c. the best-effort writer wrapper is off by default and off under the master switch', async () => {
  let wrote = 0;
  const write = async () => { wrote += 1; return { ok: true, snapshotId: 1 }; };
  const off = await writeMarketSnapshotIfEnabled({ rows: [{ symbol: 'btc' }] }, { env: {}, writeMarketPriceSnapshot: write });
  assert.deepEqual(off, { ok: true, skipped: true, reason: 'DISABLED' });
  const masterOff = await writeMarketSnapshotIfEnabled({ rows: [{ symbol: 'btc' }] }, {
    env: { PRICE_HISTORY_WRITE_ENABLED: 'true', [COST_BREAKER_MASTER_ENV_FLAG]: 'false' },
    writeMarketPriceSnapshot: write,
  });
  assert.deepEqual(masterOff, { ok: true, skipped: true, reason: 'DISABLED' });
  assert.equal(wrote, 0);
});

// ── 4. price-history reads degrade to UNKNOWN without a DB connection ────────

test('4. price-history reads disabled: every reader returns a named disabled reason and no rows, without connecting', async () => {
  const ph = await import('../netlify/functions/_price-history.mjs');
  let connects = 0;
  const tripwireDb = () => { connects += 1; throw new Error('getDb must not be called'); };

  const points = await ph.listRecentPricePoints({ symbol: 'BTC' }, { env: {}, getDbImpl: tripwireDb });
  assert.equal(points.ok, false);
  assert.equal(points.reason, REASON_DB_HISTORY_READS_DISABLED);
  assert.deepEqual(points.points, [], 'no rows are fabricated');

  const batch = await ph.listRecentPricePointsForSymbols({ symbols: ['BTC', 'ETH'] }, { env: {}, getDbImpl: tripwireDb });
  assert.equal(batch.ok, false);
  assert.equal(batch.reason, REASON_DB_HISTORY_READS_DISABLED);
  assert.equal(batch.bySymbol.size, 0);

  const snapshots = await ph.listRecentSnapshots({}, { env: {}, getDbImpl: tripwireDb });
  assert.equal(snapshots.ok, false);
  assert.equal(snapshots.reason, REASON_DB_HISTORY_READS_DISABLED);
  assert.deepEqual(snapshots.snapshots, []);

  const latest = await ph.getLatestSnapshotAt({ source: 'scheduled_price_history' }, { env: {}, getDbImpl: tripwireDb });
  assert.equal(latest.ok, false);
  assert.equal(latest.reason, REASON_DB_HISTORY_READS_DISABLED);
  assert.equal(latest.sampledAt, null, 'null, not a timestamp that would pass a spacing guard');

  assert.equal(connects, 0, 'not one connection was created across four readers');
});

test('4b. enabling collection alone re-opens the collector spacing read, but not the panel reads', async () => {
  const ph = await import('../netlify/functions/_price-history.mjs');
  const env = { PRICE_HISTORY_COLLECT_ENABLED: 'true' };
  const latest = await ph.getLatestSnapshotAt({ source: 's' }, {
    env, getDbImpl: () => ({ pool: { query: async () => ({ rows: [{ sampled_at: '2026-08-19T00:00:00.000Z' }] }) } }),
  });
  assert.equal(latest.ok, true, 'the min-spacing guard works without a second flag');
  const points = await ph.listRecentPricePoints({ symbol: 'BTC' }, { env, getDbImpl: () => { throw new Error('must not connect'); } });
  assert.equal(points.reason, REASON_DB_HISTORY_READS_DISABLED, 'panel reads stay off');
});

// ── 5. historical valuation disabled reads UNKNOWN / HISTORY_DISABLED, not FAIR ─

test('5. valuation history disabled: reported as HISTORY_DISABLED, and no band is invented', async () => {
  const ph = await import('../netlify/functions/_price-history.mjs');
  const candidates = [
    { symbol: 'BTCUSDT', valuation: { band: 'UNKNOWN', basis: 'momentum_only' } },
    { symbol: 'ETHUSDT', valuation: { band: 'UNKNOWN', basis: 'momentum_only' } },
  ];
  const loaded = await loadValuationHistoryForCandidates(
    candidates,
    (opts) => ph.listRecentPricePointsForSymbols(opts, { env: {}, getDbImpl: () => { throw new Error('must not connect'); } }),
  );
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, REASON_DB_HISTORY_READS_DISABLED);
  assert.equal(loaded.layers.size, 0, 'no history layer was synthesised');

  const radar = applyValuationHistoryToRadar({ candidates }, loaded);
  const s = radar.valuationSummary;
  assert.equal(s.historyAvailable, false);
  assert.equal(s.historyDisabled, true);
  assert.equal(s.historyUnavailableReason, 'HISTORY_DISABLED', 'the UI must be able to say HISTORY_DISABLED');
  assert.equal(s.historySymbolsWithData, 0);
  assert.equal(s.historyEnrichedCandidates, 0, 'not one candidate had its valuation rewritten');
  // The decisive assertion: a disabled read must never produce a FAIR reading.
  for (const c of candidates) {
    assert.notEqual(c.valuation.band, 'FAIR', 'a read that never happened cannot report FAIR');
    assert.equal(c.valuation.band, 'UNKNOWN');
    assert.equal(c.valuation.basis, 'momentum_only', 'the momentum-only reading is left exactly as it was');
  }
  // And it stays advisory — it cannot reach a gate or Telegram.
  assert.equal(s.affectsGate, false);
  assert.equal(s.isEntrySignal, false);
  assert.equal(s.affectsTelegram, false);
});

test('5b. the RADAR price-history corroboration fails closed to UNKNOWN and is labelled HISTORY_DISABLED, never DB_UNAVAILABLE', async () => {
  const ph = await import('../netlify/functions/_price-history.mjs');
  const { loadPriceHistoryContextsForCandidates } = await import('../netlify/functions/_price-history-radar-context.mjs');
  const contexts = await loadPriceHistoryContextsForCandidates(
    [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }],
    (opts) => ph.listRecentPricePoints(opts, { env: {}, getDbImpl: () => { throw new Error('must not connect'); } }),
  );
  assert.equal(contexts.size, 2);
  for (const ctx of contexts.values()) {
    // Fail-closed: UNKNOWN on both axes. It can only ever withhold setup
    // corroboration, never grant it — so a disabled read cannot promote a
    // candidate, and it is NOT a bearish/rejected verdict either.
    assert.equal(ctx.status, 'HISTORY_DISABLED', 'declining to read is not a database outage');
    assert.equal(ctx.reclaim.status, 'UNKNOWN');
    assert.equal(ctx.absorption.status, 'UNKNOWN');
    assert.equal(ctx.affectsServerGate, false, 'no scoring support is granted');
    assert.equal(ctx.affectsTelegram, false, 'and it can never reach Telegram');
  }
});

// ── 6. /api/context stays auth-gated, and only the master lever degrades it ──

const CONTEXT_URL = 'https://swingterminalx.netlify.app/api/context';
const VERIFIED = { ok: true, verified: true, userId: 'u-1', email: 'owner@example.com' };

function contextReq() { return new Request(CONTEXT_URL, { method: 'GET' }); }

test('6. /api/context is still auth-gated — every unauthenticated shape gets 401 and no DB read', async () => {
  resetContextCacheForTests();
  let dbReads = 0;
  const store = { getAtomizedMarketContext: async () => { dbReads += 1; return { ok: true, market: { tickers: [] } }; } };
  for (const identity of [
    { ok: false, reason: 'no token' },
    { ok: true, verified: false },
    null,
  ]) {
    const res = await runContextRead(contextReq(), { store, database: {}, getIdentity: async () => identity, env: {} });
    assert.equal(res.status, 401, 'unauthenticated callers are refused');
    assert.equal((await res.json()).reason, 'UNAUTHENTICATED');
  }
  // A throwing identity provider must also fail closed, not fall through.
  const threw = await runContextRead(contextReq(), {
    store, database: {}, getIdentity: async () => { throw new Error('boom'); }, env: {},
  });
  assert.equal(threw.status, 401);
  assert.equal(dbReads, 0, 'auth runs before any database work');
});

test('6b. /api/context stays available under the emergency narrow flags — it is the core read', async () => {
  resetContextCacheForTests();
  const store = { getAtomizedMarketContext: async () => ({ ok: true, market: { tickers: [], observedAt: new Date().toISOString() }, run: { id: 1 } }) };
  const res = await runContextRead(contextReq(), {
    store, database: {}, getIdentity: async () => VERIFIED,
    env: { PRICE_HISTORY_READS_ENABLED: undefined, MARKET_CONTEXT_COLLECT_ENABLED: undefined },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('6c. the master lever degrades /api/context honestly — after auth, 200, no DB read', async () => {
  resetContextCacheForTests();
  let dbReads = 0;
  const store = { getAtomizedMarketContext: async () => { dbReads += 1; return { ok: true, market: { tickers: [] } }; } };
  const env = { [COST_BREAKER_MASTER_ENV_FLAG]: 'false' };

  // Auth still first: the breaker must not become an auth bypass.
  const anon = await runContextRead(contextReq(), { store, database: {}, getIdentity: async () => ({ ok: false }), env });
  assert.equal(anon.status, 401);

  const res = await runContextRead(contextReq(), { store, database: {}, getIdentity: async () => VERIFIED, env });
  assert.equal(res.status, 200, 'a deliberate degradation is not a 5xx');
  const body = await res.json();
  assert.equal(body.ok, false, 'honest: the browser falls back to /api/markets, which touches no database');
  assert.equal(body.degraded, true);
  assert.equal(body.reason, REASON_COST_BREAKER_DISABLED_PATH);
  assert.equal(dbReads, 0);
  assert.equal(res.headers.get('X-DB-Read-Guard'), REASON_COST_BREAKER_DISABLED_PATH);
});

test('6d. the default memo is the collector publish interval, so no read is spent on a run that cannot have changed', () => {
  assert.equal(CONTEXT_CACHE_DEFAULT_MS, 180_000);
});

test('6e. the single-coin RADAR verdict read stays auth-gated and degrades only under the master lever', async () => {
  const url = 'https://swingterminalx.netlify.app/api/cockpit-radar-state?symbol=BTCUSDT';
  let dbReads = 0;
  const store = { getRadarCandidateState: async () => { dbReads += 1; return { ok: true, state: null }; } };

  const anon = await runCockpitRadarStateRead(new Request(url), {
    store, database: {}, getIdentity: async () => ({ ok: false }), env: { [COST_BREAKER_MASTER_ENV_FLAG]: 'false' },
  });
  assert.equal(anon.status, 401);

  const res = await runCockpitRadarStateRead(new Request(url), {
    store, database: {}, getIdentity: async () => VERIFIED, env: { [COST_BREAKER_MASTER_ENV_FLAG]: 'false' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.disabled, true);
  assert.equal(body.reason, REASON_COST_BREAKER_DISABLED_PATH);
  // A disabled read must not read as "the server scored nothing for this coin",
  // which the operator would take for a rejected setup.
  assert.notEqual(body.reason, 'NOT_SCORED');
  assert.notEqual(body.reason, 'RADAR_STATE_EMPTY');
  assert.equal(dbReads, 0);
});

// ── 7. no disabled path is ever a 500 ───────────────────────────────────────

test('7. every disabled path answers 2xx — an emergency breaker must not create an error storm', async () => {
  const t = tripwires();
  const statuses = [];
  statuses.push((await runPriceHistoryCollectScheduled(schedulerReq(COLLECT_URL), { ...t, env: { PRICE_HISTORY_SCHEDULER_SECRET: SCHEDULER_SECRET } })).status);
  statuses.push((await runPriceHistoryPruneScheduled(schedulerReq(PRUNE_URL), { ...t, env: { PRICE_HISTORY_SCHEDULER_SECRET: SCHEDULER_SECRET } })).status);
  statuses.push((await runMarketContextCollector({ env: {}, loadStore: async () => { throw new Error('x'); } })).status);
  resetContextCacheForTests();
  statuses.push((await runContextRead(contextReq(), {
    store: { getAtomizedMarketContext: async () => ({ ok: true, market: { tickers: [] } }) },
    database: {}, getIdentity: async () => VERIFIED, env: { [COST_BREAKER_MASTER_ENV_FLAG]: 'false' },
  })).status);
  for (const status of statuses) {
    assert.ok(status >= 200 && status < 300, `disabled path answered ${status}, expected 2xx`);
  }
});
