// Tests for listRecentPricePointsForSymbols in netlify/functions/_price-history.mjs
// — the batched, bounded multi-symbol point reader added for the RADAR
// oversold/overbought (valuation) read.
//
// Pure-input validation and bounding are asserted with an injected fake pool, so
// nothing here needs (or touches) a database. The DB-unavailable path is
// asserted the same way the rest of _price-history.mjs asserts it: by an
// injected getDbImpl that throws.
import test from 'node:test';
import assert from 'node:assert/strict';

// The emergency cost breaker (netlify/functions/_cost-breaker.mjs) gates every
// export of _price-history.mjs on process.env, defaulting to OFF. These suites
// exercise the storage behaviour BEHIND that gate, so they enable it explicitly.
// node --test gives each file its own process, so this leaks into no other
// suite, and the breaker's own default-off behaviour is asserted separately in
// tests/cost.breaker.test.mjs.
process.env.PRICE_HISTORY_READS_ENABLED = 'true';
process.env.PRICE_HISTORY_WRITE_ENABLED = 'true';
process.env.PRICE_HISTORY_PRUNE_ENABLED = 'true';

import { listRecentPricePointsForSymbols } from '../netlify/functions/_price-history.mjs';

function fakeDb(rows, capture) {
  return {
    getDbImpl: () => ({
      pool: {
        query: async (sql, params) => {
          if (capture) capture.push({ sql, params });
          return { rows, rowCount: rows.length };
        },
      },
    }),
  };
}

test('a non-array or empty symbol list is rejected without a query', async () => {
  const capture = [];
  const deps = fakeDb([], capture);
  assert.deepEqual(await listRecentPricePointsForSymbols({}, deps), { ok: false, reason: 'INVALID_SYMBOLS' });
  assert.deepEqual(await listRecentPricePointsForSymbols({ symbols: 'BTC' }, deps), { ok: false, reason: 'INVALID_SYMBOLS' });
  assert.deepEqual(await listRecentPricePointsForSymbols({ symbols: [] }, deps), { ok: false, reason: 'MISSING_SYMBOLS' });
  assert.deepEqual(await listRecentPricePointsForSymbols({ symbols: ['', '   ', null] }, deps), { ok: false, reason: 'MISSING_SYMBOLS' });
  assert.equal(capture.length, 0, 'invalid input must never reach the database');
});

test('symbols are upper-cased, trimmed, deduped, and over-long ones dropped', async () => {
  const capture = [];
  const res = await listRecentPricePointsForSymbols(
    { symbols: [' btc ', 'BTC', 'eth', 'X'.repeat(40)] },
    fakeDb([], capture),
  );
  assert.equal(res.ok, true);
  assert.deepEqual(capture[0].params[0], ['BTC', 'ETH']);
});

test('the read is hard-bounded: at most 60 symbols and 200 points each, with the truncation reported', async () => {
  const capture = [];
  const symbols = Array.from({ length: 200 }, (_, i) => `SYM${i}`);
  const res = await listRecentPricePointsForSymbols({ symbols, pointsPerSymbol: 5000 }, fakeDb([], capture));
  assert.equal(res.ok, true);
  assert.equal(capture[0].params[0].length, 60);
  assert.equal(capture[0].params[1], 200);
  assert.equal(res.symbolsRequested, 60);
  assert.equal(res.symbolsDropped, 140, 'a truncated read must never look like full coverage');
});

test('a missing or non-positive pointsPerSymbol falls back to the default, never to unbounded', async () => {
  const capture = [];
  await listRecentPricePointsForSymbols({ symbols: ['BTC'] }, fakeDb([], capture));
  await listRecentPricePointsForSymbols({ symbols: ['BTC'], pointsPerSymbol: 0 }, fakeDb([], capture));
  await listRecentPricePointsForSymbols({ symbols: ['BTC'], pointsPerSymbol: -10 }, fakeDb([], capture));
  await listRecentPricePointsForSymbols({ symbols: ['BTC'], pointsPerSymbol: 'lots' }, fakeDb([], capture));
  for (const call of capture) assert.equal(call.params[1], 60);
});

test('rows are grouped per symbol and the statement bounds rows per symbol in SQL, not in JS', async () => {
  const capture = [];
  const rows = [
    { symbol: 'BTC', price_usd: '3', sampled_at: '2026-08-01T02:00:00.000Z' },
    { symbol: 'BTC', price_usd: '2', sampled_at: '2026-08-01T01:00:00.000Z' },
    { symbol: 'ETH', price_usd: '9', sampled_at: '2026-08-01T02:00:00.000Z' },
  ];
  const res = await listRecentPricePointsForSymbols({ symbols: ['BTC', 'ETH', 'SOL'] }, fakeDb(rows, capture));
  assert.equal(res.ok, true);
  assert.ok(res.bySymbol instanceof Map);
  assert.equal(res.bySymbol.get('BTC').length, 2);
  assert.equal(res.bySymbol.get('ETH').length, 1);
  assert.equal(res.bySymbol.has('SOL'), false, 'a symbol with no stored rows is simply absent');
  assert.equal(res.symbolsReturned, 2);
  assert.match(capture[0].sql, /ROW_NUMBER\(\) OVER \(PARTITION BY symbol ORDER BY sampled_at DESC\)/);
  assert.match(capture[0].sql, /WHERE rn <= \$2/);
  assert.doesNotMatch(capture[0].sql, /raw_meta/, 'raw_meta must never be read here');
});

test('a DB-unavailable or failing query returns a stable reason, never throws and never fakes rows', async () => {
  const noDb = await listRecentPricePointsForSymbols({ symbols: ['BTC'] }, {
    getDbImpl: () => { throw new Error('postgres://user:pw@host/db unreachable'); },
  });
  assert.deepEqual(noDb, { ok: false, reason: 'DB_UNAVAILABLE' });

  const failingQuery = await listRecentPricePointsForSymbols({ symbols: ['BTC'] }, {
    getDbImpl: () => ({ pool: { query: async () => { throw Object.assign(new Error('boom'), { code: '42P01' }); } } }),
  });
  assert.deepEqual(failingQuery, { ok: false, reason: 'DB_UNAVAILABLE' });
});
