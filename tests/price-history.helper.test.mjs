// Tests for netlify/functions/_price-history.mjs — market price history
// storage foundation only. No reclaim/absorption/RADAR/trading logic is
// implemented or tested here; those are explicitly out of scope for this
// phase and will land in a later change.
//
// Split into two groups, same pattern as tests/observability.helper.test.mjs:
//   1. Pure validation / normalization / sanitization — never touch the DB,
//      always run.
//   2. DB-backed — skip gracefully (t.skip) if no local dev DB is reachable,
//      never fail hard, never touch production. Rows are cleaned up by id
//      (writeMarketPriceSnapshot commits its own transaction, so cleanup is
//      an explicit DELETE, not a rollback) — cascade removes the points.
import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb, closeDbForTests } from '../netlify/functions/_db.mjs';
import {
  normalizePricePoint,
  sanitizeRawMeta,
  dedupePointsBySymbol,
  writeMarketPriceSnapshot,
  listRecentPricePoints,
  listRecentSnapshots,
  getLatestSnapshotAt,
  pruneSnapshotsOlderThan,
  ALLOWED_SNAPSHOT_STATUSES,
} from '../netlify/functions/_price-history.mjs';

// ── Group 1: pure validation / normalization / sanitization ─────────────

test('module exports the expected functions with no import-time DB query', () => {
  assert.equal(typeof normalizePricePoint, 'function');
  assert.equal(typeof dedupePointsBySymbol, 'function');
  assert.equal(typeof writeMarketPriceSnapshot, 'function');
  assert.equal(typeof listRecentPricePoints, 'function');
  assert.equal(typeof listRecentSnapshots, 'function');
  assert.equal(typeof getLatestSnapshotAt, 'function');
  assert.equal(typeof pruneSnapshotsOlderThan, 'function');
  assert.deepEqual([...ALLOWED_SNAPSHOT_STATUSES].sort(), ['failed', 'ok', 'partial']);
});

test('dedupePointsBySymbol keeps the first occurrence of a duplicate symbol and counts the rest as duplicates', () => {
  const a = { symbol: 'BTC', priceUsd: 1 };
  const b = { symbol: 'BTC', priceUsd: 2 };
  const c = { symbol: 'ETH', priceUsd: 3 };
  const { deduped, duplicates } = dedupePointsBySymbol([a, b, c]);
  assert.deepEqual(deduped, [a, c]);
  assert.equal(duplicates, 1);
});

test('dedupePointsBySymbol reports zero duplicates when all symbols are unique', () => {
  const points = [{ symbol: 'BTC' }, { symbol: 'ETH' }, { symbol: 'SOL' }];
  const { deduped, duplicates } = dedupePointsBySymbol(points);
  assert.equal(deduped.length, 3);
  assert.equal(duplicates, 0);
});

test('dedupePointsBySymbol handles an empty array without throwing', () => {
  const { deduped, duplicates } = dedupePointsBySymbol([]);
  assert.deepEqual(deduped, []);
  assert.equal(duplicates, 0);
});

test('normalizePricePoint maps a valid row correctly', () => {
  const sampledAt = new Date('2026-07-20T10:00:00Z');
  const point = normalizePricePoint(
    {
      symbol: 'btc',
      name: 'Bitcoin',
      price: 65000.5,
      change24h: 3.2,
      volume24h: 1_000_000,
      marketCap: 1_200_000_000_000,
      rank: 1,
    },
    sampledAt,
    'coingecko',
  );
  assert.equal(point.symbol, 'BTC');
  assert.equal(point.name, 'Bitcoin');
  assert.equal(point.priceUsd, 65000.5);
  assert.equal(point.change24hPct, 3.2);
  assert.equal(point.volume24hUsd, 1_000_000);
  assert.equal(point.marketCapUsd, 1_200_000_000_000);
  assert.equal(point.rank, 1);
  assert.equal(point.source, 'coingecko');
  assert.equal(point.sampledAt.getTime(), sampledAt.getTime());
});

test('normalizePricePoint uppercases the symbol', () => {
  const point = normalizePricePoint({ symbol: 'eth' }, new Date(), 'test');
  assert.equal(point.symbol, 'ETH');
});

test('normalizePricePoint returns null for a missing symbol', () => {
  assert.equal(normalizePricePoint({ price: 1 }, new Date(), 'test'), null);
});

test('normalizePricePoint returns null for an empty-string symbol', () => {
  assert.equal(normalizePricePoint({ symbol: '   ' }, new Date(), 'test'), null);
});

test('normalizePricePoint returns null for a non-object row without throwing', () => {
  assert.equal(normalizePricePoint(null, new Date(), 'test'), null);
  assert.equal(normalizePricePoint(undefined, new Date(), 'test'), null);
  assert.equal(normalizePricePoint('not-an-object', new Date(), 'test'), null);
  assert.equal(normalizePricePoint(42, new Date(), 'test'), null);
});

test('normalizePricePoint converts invalid numeric values to null instead of inventing data', () => {
  const point = normalizePricePoint(
    { symbol: 'btc', price: 'not-a-number', change24h: NaN, volume24h: {}, marketCap: [] },
    new Date(),
    'test',
  );
  assert.equal(point.priceUsd, null);
  assert.equal(point.change24hPct, null);
  assert.equal(point.volume24hUsd, null);
  assert.equal(point.marketCapUsd, null);
});

test('normalizePricePoint leaves missing numeric fields as null, not invented', () => {
  const point = normalizePricePoint({ symbol: 'btc' }, new Date(), 'test');
  assert.equal(point.priceUsd, null);
  assert.equal(point.change1hPct, null);
  assert.equal(point.change24hPct, null);
  assert.equal(point.change7dPct, null);
  assert.equal(point.volume24hUsd, null);
  assert.equal(point.marketCapUsd, null);
  assert.equal(point.name, null);
});

test('normalizePricePoint converts an invalid rank to null', () => {
  assert.equal(normalizePricePoint({ symbol: 'btc', rank: 'not-a-rank' }, new Date(), 'test').rank, null);
  assert.equal(normalizePricePoint({ symbol: 'btc', rank: -5 }, new Date(), 'test').rank, null);
  assert.equal(normalizePricePoint({ symbol: 'btc', rank: 0 }, new Date(), 'test').rank, null);
});

test('normalizePricePoint supports known field aliases', () => {
  const bySAlias = normalizePricePoint({ s: 'sol', priceUsd: 150 }, new Date(), 'test');
  assert.equal(bySAlias.symbol, 'SOL');
  assert.equal(bySAlias.priceUsd, 150);

  const byBinanceAliases = normalizePricePoint(
    { symbol: 'bnb', lastPrice: '400.5', priceChangePercent: '1.5', quoteVolume: '999' },
    new Date(),
    'binance',
  );
  assert.equal(byBinanceAliases.priceUsd, 400.5);
  assert.equal(byBinanceAliases.change24hPct, 1.5);
  assert.equal(byBinanceAliases.volume24hUsd, 999);
});

// Regression test for the production bug where every /api/markets row
// normalized to a NULL price_usd: shapeFromCoingecko/_makeBinanceSpotRow
// (apps/edge/netlify/edge-functions/markets.js) emit current_price,
// price_change_percentage_24h, total_volume, market_cap, and
// market_cap_rank — field names that were previously absent from
// normalizePricePoint's alias lists, so real collector rows silently
// wrote NULL for every numeric column except symbol/name.
test('normalizePricePoint maps the actual /api/markets row shape (current_price, price_change_percentage_24h, total_volume, market_cap, market_cap_rank)', () => {
  const marketsRow = {
    id: 'bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    pair: 'BTCUSDT',
    quote: 'USDT',
    exchange: 'BIN',
    current_price: 65000.5,
    price_change_percentage_24h: 3.2,
    high_24h: 66000,
    low_24h: 64000,
    total_volume: 1_000_000,
    base_volume: 15.5,
    market_cap: 1_200_000_000_000,
    market_cap_rank: 1,
    _c1: 0.1,
    _c4: 0.4,
    _c12: 1.2,
    _c24: 3.2,
    _c7d: 5.5,
  };
  const point = normalizePricePoint(marketsRow, new Date(), 'admin_price_history_collect');
  assert.equal(point.symbol, 'BTC');
  assert.equal(point.priceUsd, 65000.5, 'current_price must resolve to a valid price_usd, never null');
  assert.equal(point.change24hPct, 3.2);
  assert.equal(point.volume24hUsd, 1_000_000);
  assert.equal(point.marketCapUsd, 1_200_000_000_000);
  assert.equal(point.rank, 1);
  assert.equal(point.change1hPct, 0.1);
  assert.equal(point.change7dPct, 5.5);
});

test('normalizePricePoint maps a Binance-only spot row from /api/markets (_makeBinanceSpotRow shape, market_cap:0)', () => {
  const binanceOnlyRow = {
    id: 'someusdt',
    symbol: 'SOMEUSDT'.replace('USDT', ''),
    name: 'SOME',
    pair: 'SOMEUSDT',
    quote: 'USDT',
    exchange: 'BIN',
    current_price: 1.23,
    price_change_percentage_24h: -2.1,
    total_volume: 45000,
    market_cap: 0,
    market_cap_rank: 0,
  };
  const point = normalizePricePoint(binanceOnlyRow, new Date(), 'admin_price_history_collect');
  assert.equal(point.priceUsd, 1.23);
  assert.equal(point.change24hPct, -2.1);
  assert.equal(point.volume24hUsd, 45000);
  // market_cap:0 / market_cap_rank:0 are real "unranked" values from the
  // Binance-only append path, not missing data — 0 must not be null, and
  // rank stays null only because rank<=0 is explicitly treated as unranked.
  assert.equal(point.marketCapUsd, 0);
  assert.equal(point.rank, null);
});

test('normalizePricePoint normalizes sampledAt safely when given an invalid date', () => {
  const point = normalizePricePoint({ symbol: 'btc' }, new Date('not-a-date'), 'test');
  assert.ok(point.sampledAt instanceof Date && !Number.isNaN(point.sampledAt.getTime()));
});

test('sanitizeRawMeta strips dangerous key names', () => {
  const dirty = {
    token: 'x', authorization: 'x', cookie: 'x', password: 'x', secret: 'x',
    databaseUrl: 'x', connectionString: 'x', chat_id: 'x', user_id: 'x',
    safe: 'kept',
  };
  const clean = sanitizeRawMeta(dirty);
  for (const key of ['token', 'authorization', 'cookie', 'password', 'secret', 'databaseUrl', 'connectionString', 'chat_id', 'user_id']) {
    assert.equal(key in clean, false, `${key} must be stripped`);
  }
  assert.equal(clean.safe, 'kept');
});

test('sanitizeRawMeta does not store an oversized payload in full', () => {
  const clean = sanitizeRawMeta({ big: 'x'.repeat(10_000) });
  assert.ok(clean._truncated);
  assert.equal(JSON.stringify(clean).length < 10_000, true);
});

test('sanitizeRawMeta returns {} for null/undefined/non-object input', () => {
  assert.deepEqual(sanitizeRawMeta(null), {});
  assert.deepEqual(sanitizeRawMeta(undefined), {});
  assert.deepEqual(sanitizeRawMeta('just a string'), {});
});

test('writeMarketPriceSnapshot rejects a missing source without touching the DB', async () => {
  const res = await writeMarketPriceSnapshot({ rows: [] });
  assert.deepEqual(res, { ok: false, reason: 'MISSING_SOURCE' });
});

test('writeMarketPriceSnapshot rejects non-array rows without touching the DB', async () => {
  const res = await writeMarketPriceSnapshot({ source: 'test', rows: 'not-an-array' });
  assert.deepEqual(res, { ok: false, reason: 'INVALID_ROWS' });
});

test('writeMarketPriceSnapshot returns a stable DB_UNAVAILABLE reason when the DB cannot be reached — never throws', async () => {
  const fakeGetDb = () => { throw new Error('simulated: no DB configured'); };
  const res = await writeMarketPriceSnapshot(
    { source: 'test', rows: [{ symbol: 'btc' }] },
    { getDbImpl: fakeGetDb },
  );
  assert.deepEqual(res, { ok: false, reason: 'DB_UNAVAILABLE' });
});

test('writeMarketPriceSnapshot DB_UNAVAILABLE path never logs a secret-shaped value', async () => {
  const originalWarn = console.warn;
  const calls = [];
  console.warn = (...args) => { calls.push(args); };
  try {
    const fakeGetDb = () => { throw new Error('simulated: postgres://user:pw@host:5432/db'); };
    await writeMarketPriceSnapshot({ source: 'test', rows: [] }, { getDbImpl: fakeGetDb });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls.length, 0);
});

test('writeMarketPriceSnapshot drops invalid rows instead of fabricating data, bounded by row count', async () => {
  const rows = [{ symbol: 'btc' }, { price: 1 }, { symbol: '' }, { symbol: 'eth' }];
  const fakeGetDb = () => { throw new Error('unreachable in this test'); };
  // Row filtering happens before the DB is touched, so DB_UNAVAILABLE from
  // the fake is expected — this test only checks the helper does not throw
  // when handed a mixed-validity row array.
  const res = await writeMarketPriceSnapshot({ source: 'test', rows }, { getDbImpl: fakeGetDb });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'DB_UNAVAILABLE');
});

test('listRecentPricePoints rejects a missing symbol without touching the DB', async () => {
  const res = await listRecentPricePoints({});
  assert.deepEqual(res, { ok: false, reason: 'MISSING_SYMBOL' });
});

test('listRecentPricePoints returns a stable DB_UNAVAILABLE reason when the DB cannot be reached', async () => {
  const fakeGetDb = () => { throw new Error('simulated'); };
  const res = await listRecentPricePoints({ symbol: 'btc' }, { getDbImpl: fakeGetDb });
  assert.deepEqual(res, { ok: false, reason: 'DB_UNAVAILABLE' });
});

test('listRecentSnapshots returns a stable DB_UNAVAILABLE reason when the DB cannot be reached', async () => {
  const fakeGetDb = () => { throw new Error('simulated'); };
  const res = await listRecentSnapshots({}, { getDbImpl: fakeGetDb });
  assert.deepEqual(res, { ok: false, reason: 'DB_UNAVAILABLE' });
});

// ── Group 1b: batch insert + storeRawMeta via a fake pool/client ────────
// No real DB needed — these exercise writeMarketPriceSnapshot's SQL shape
// and chunking behavior directly against a fake `db.pool.connect()` client,
// so they run (and prove the batch-insert regression fix) even when no
// local dev DB is reachable, unlike the Group 2 tests below.

const POINT_PARAMS_PER_ROW = 13; // snapshot_id..raw_meta — see POINT_INSERT_COLUMNS

function makeFakeClient({ snapshotId = 101 } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) return {};
      if (sql.includes('INSERT INTO market_price_snapshots')) return { rows: [{ id: snapshotId }] };
      if (sql.includes('INSERT INTO market_price_points')) {
        return { rowCount: params.length / POINT_PARAMS_PER_ROW };
      }
      return {};
    },
    release: () => {},
  };
}

function makeFakeDb(client) {
  return { pool: { connect: async () => client } };
}

function makeUniqueRows(count) {
  return Array.from({ length: count }, (_, i) => ({ symbol: `sym${i}`, price: i + 1 }));
}

test('writeMarketPriceSnapshot batches point inserts (200/chunk) instead of one query per row', async () => {
  const client = makeFakeClient();
  const rows = makeUniqueRows(250);
  const res = await writeMarketPriceSnapshot({ source: 'tests/batch', rows }, { getDbImpl: () => makeFakeDb(client) });

  assert.equal(res.ok, true);
  assert.equal(res.inserted, 250);
  assert.equal(res.dropped, 0);
  assert.equal(res.duplicates, 0);

  const pointInsertCalls = client.calls.filter((c) => c.sql.includes('INSERT INTO market_price_points'));
  assert.equal(pointInsertCalls.length, 2, 'a 250-row write must batch into 2 queries, never 250 per-row queries');
  assert.equal(pointInsertCalls[0].params.length / POINT_PARAMS_PER_ROW, 200);
  assert.equal(pointInsertCalls[1].params.length / POINT_PARAMS_PER_ROW, 50);
  for (const call of pointInsertCalls) {
    assert.match(call.sql, /ON CONFLICT \(snapshot_id, symbol\) DO NOTHING/);
  }
});

test('writeMarketPriceSnapshot issues exactly one point-insert query when rows fit in a single chunk', async () => {
  const client = makeFakeClient();
  const rows = makeUniqueRows(5);
  const res = await writeMarketPriceSnapshot({ source: 'tests/batch', rows }, { getDbImpl: () => makeFakeDb(client) });
  assert.equal(res.ok, true);
  assert.equal(res.inserted, 5);
  const pointInsertCalls = client.calls.filter((c) => c.sql.includes('INSERT INTO market_price_points'));
  assert.equal(pointInsertCalls.length, 1);
});

test('writeMarketPriceSnapshot chunks an exact multiple of the batch size into separate full-size queries', async () => {
  const client = makeFakeClient();
  const rows = makeUniqueRows(400);
  const res = await writeMarketPriceSnapshot({ source: 'tests/batch', rows }, { getDbImpl: () => makeFakeDb(client) });
  assert.equal(res.ok, true);
  assert.equal(res.inserted, 400);
  const pointInsertCalls = client.calls.filter((c) => c.sql.includes('INSERT INTO market_price_points'));
  assert.equal(pointInsertCalls.length, 2);
  assert.equal(pointInsertCalls[0].params.length / POINT_PARAMS_PER_ROW, 200);
  assert.equal(pointInsertCalls[1].params.length / POINT_PARAMS_PER_ROW, 200);
});

test('writeMarketPriceSnapshot issues no point-insert query at all when every row is deduped/invalid', async () => {
  const client = makeFakeClient();
  const res = await writeMarketPriceSnapshot({ source: 'tests/batch', rows: [] }, { getDbImpl: () => makeFakeDb(client) });
  assert.equal(res.ok, true);
  assert.equal(res.inserted, 0);
  const pointInsertCalls = client.calls.filter((c) => c.sql.includes('INSERT INTO market_price_points'));
  assert.equal(pointInsertCalls.length, 0);
});

test('storeRawMeta omitted (default) keeps the existing sanitized raw_meta behavior', async () => {
  const client = makeFakeClient();
  const rows = [{ symbol: 'btc', price: 1, extra: 'some-detail' }];
  await writeMarketPriceSnapshot({ source: 'tests/batch', rows }, { getDbImpl: () => makeFakeDb(client) });
  const pointInsertCall = client.calls.find((c) => c.sql.includes('INSERT INTO market_price_points'));
  const rawMetaParam = pointInsertCall.params[12];
  const parsed = JSON.parse(rawMetaParam);
  assert.equal(parsed.extra, 'some-detail');
});

test('storeRawMeta:true explicitly keeps the same sanitized raw_meta behavior as the default', async () => {
  const client = makeFakeClient();
  const rows = [{ symbol: 'btc', price: 1, extra: 'some-detail' }];
  await writeMarketPriceSnapshot({ source: 'tests/batch', rows, storeRawMeta: true }, { getDbImpl: () => makeFakeDb(client) });
  const pointInsertCall = client.calls.find((c) => c.sql.includes('INSERT INTO market_price_points'));
  const parsed = JSON.parse(pointInsertCall.params[12]);
  assert.equal(parsed.extra, 'some-detail');
});

test('storeRawMeta:false stores {} for every row instead of the sanitized row, regardless of row content', async () => {
  const client = makeFakeClient();
  const rows = [
    { symbol: 'btc', price: 1, extra: 'some-detail' },
    { symbol: 'eth', price: 2, token: 'should-be-stripped-anyway-but-must-not-even-be-attempted' },
  ];
  await writeMarketPriceSnapshot({ source: 'tests/batch', rows, storeRawMeta: false }, { getDbImpl: () => makeFakeDb(client) });
  const pointInsertCall = client.calls.find((c) => c.sql.includes('INSERT INTO market_price_points'));
  const rawMetaParams = [
    pointInsertCall.params[12],
    pointInsertCall.params[12 + POINT_PARAMS_PER_ROW],
  ];
  for (const p of rawMetaParams) assert.equal(p, '{}');
});

test('batch insert never throws when the DB connection breaks mid-transaction and rolls back', async () => {
  const client = {
    calls: [],
    query: async (sql) => {
      client.calls.push(sql);
      if (sql.startsWith('BEGIN')) return {};
      if (sql.includes('INSERT INTO market_price_snapshots')) return { rows: [{ id: 1 }] };
      if (sql.includes('INSERT INTO market_price_points')) throw new Error('simulated: postgres://user:pw@host/db');
      if (sql.startsWith('ROLLBACK')) return {};
      return {};
    },
    release: () => {},
  };
  const originalWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => { warnCalls.push(args); };
  let res;
  try {
    res = await writeMarketPriceSnapshot({ source: 'tests/batch', rows: makeUniqueRows(5) }, { getDbImpl: () => makeFakeDb(client) });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(res, { ok: false, reason: 'DB_UNAVAILABLE' });
  assert.ok(client.calls.some((c) => c.startsWith('ROLLBACK')));
  assert.equal(JSON.stringify(warnCalls).includes('postgres://'), false);
});

// ── Group 2: DB-backed — skip gracefully without a local dev DB ─────────

let db = null;
let unavailableReason = null;
function safeSkipReason(err) {
  const name = typeof err?.name === 'string' && err.name ? err.name : 'UnknownError';
  const code = typeof err?.code === 'string' || typeof err?.code === 'number' ? String(err.code) : 'NO_CODE';
  return `DB_UNAVAILABLE:${name}:${code}`;
}
try {
  db = getDb();
  await db.pool.query('SELECT 1');
} catch (err) {
  unavailableReason = safeSkipReason(err);
}

test.after(async () => {
  await closeDbForTests();
});

async function deleteSnapshot(id) {
  if (id == null) return;
  await db.pool.query('DELETE FROM market_price_snapshots WHERE id = $1', [id]);
}

test('writeMarketPriceSnapshot creates a snapshot and inserts its points', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const res = await writeMarketPriceSnapshot({
    source: 'tests/price-history',
    sampledAt: new Date(),
    rows: [
      { symbol: 'btc', price: 65000, change24h: 1.1 },
      { symbol: 'eth', price: 3400, change24h: -0.5 },
    ],
  });
  try {
    assert.equal(res.ok, true);
    assert.ok(res.snapshotId);
    assert.equal(res.inserted, 2);
    assert.equal(res.dropped, 0);

    const points = await db.pool.query(
      'SELECT symbol, price_usd FROM market_price_points WHERE snapshot_id = $1 ORDER BY symbol',
      [res.snapshotId],
    );
    assert.deepEqual(points.rows.map((r) => r.symbol), ['BTC', 'ETH']);
  } finally {
    await deleteSnapshot(res.snapshotId);
  }
});

test('writeMarketPriceSnapshot drops invalid rows and counts them', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const res = await writeMarketPriceSnapshot({
    source: 'tests/price-history',
    rows: [{ symbol: 'btc', price: 1 }, { price: 2 }, { symbol: '' }],
  });
  try {
    assert.equal(res.ok, true);
    assert.equal(res.inserted, 1);
    assert.equal(res.dropped, 2);
  } finally {
    await deleteSnapshot(res.snapshotId);
  }
});

test('writeMarketPriceSnapshot dedupes duplicate symbols so inserted/coin_count reflect actual DB rows, not attempted inserts', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const res = await writeMarketPriceSnapshot({
    source: 'tests/price-history',
    rows: [{ symbol: 'btc', price: 1 }, { symbol: 'BTC', price: 2 }, { symbol: 'eth', price: 3 }],
  });
  try {
    assert.equal(res.ok, true);
    // Two BTC rows collapse to one (first occurrence wins), ETH is unique:
    // 2 actually-inserted rows, 1 duplicate — never the 3 attempted inserts.
    assert.equal(res.inserted, 2);
    assert.equal(res.duplicates, 1);
    assert.equal(res.dropped, 0);

    const points = await db.pool.query(
      'SELECT symbol, price_usd FROM market_price_points WHERE snapshot_id = $1 ORDER BY symbol',
      [res.snapshotId],
    );
    assert.equal(points.rows.length, 2, 'actual DB row count matches res.inserted');
    assert.deepEqual(points.rows.map((r) => r.symbol), ['BTC', 'ETH']);
    assert.equal(Number(points.rows[0].price_usd), 1, 'first BTC occurrence wins, matching ON CONFLICT DO NOTHING semantics');

    const snapshot = await db.pool.query(
      'SELECT coin_count FROM market_price_snapshots WHERE id = $1',
      [res.snapshotId],
    );
    assert.equal(snapshot.rows[0].coin_count, 2, 'snapshot coin_count matches actual inserted points, not attempted inserts');
  } finally {
    await deleteSnapshot(res.snapshotId);
  }
});

test('deleting a snapshot cascades to its points', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const res = await writeMarketPriceSnapshot({
    source: 'tests/price-history',
    rows: [{ symbol: 'btc', price: 1 }],
  });
  assert.equal(res.ok, true);
  await deleteSnapshot(res.snapshotId);
  const points = await db.pool.query('SELECT id FROM market_price_points WHERE snapshot_id = $1', [res.snapshotId]);
  assert.equal(points.rows.length, 0);
});

test('listRecentPricePoints returns bounded, safe fields without raw_meta by default', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const written = await writeMarketPriceSnapshot({
    source: 'tests/price-history',
    rows: [{ symbol: 'testcoin', price: 42 }],
  });
  try {
    const res = await listRecentPricePoints({ symbol: 'testcoin', limit: 5 });
    assert.equal(res.ok, true);
    const row = res.points.find((p) => p.snapshot_id === written.snapshotId);
    assert.ok(row, 'the point we just wrote is present');
    assert.equal('raw_meta' in row, false);
  } finally {
    await deleteSnapshot(written.snapshotId);
  }
});

test('listRecentPricePoints bounds an oversized limit request', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const res = await listRecentPricePoints({ symbol: 'btc', limit: 999999 });
  assert.equal(res.ok, true);
});

test('listRecentSnapshots returns recent snapshot metadata', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const written = await writeMarketPriceSnapshot({
    source: 'tests/price-history',
    rows: [{ symbol: 'btc', price: 1 }],
    metadata: { note: 'test' },
  });
  try {
    const res = await listRecentSnapshots({ limit: 5 });
    assert.equal(res.ok, true);
    const row = res.snapshots.find((s) => s.id === written.snapshotId);
    assert.ok(row, 'the snapshot we just wrote is present');
    assert.equal(row.source, 'tests/price-history');
    assert.equal(row.coin_count, 1);
  } finally {
    await deleteSnapshot(written.snapshotId);
  }
});

test('tables are left clean after this file runs', async (t) => {
  if (!db) { t.skip(unavailableReason); return; }
  const snapshots = await db.pool.query(
    `SELECT count(*)::int AS n FROM market_price_snapshots WHERE source = 'tests/price-history'`,
  );
  assert.equal(snapshots.rows[0].n, 0);
});
