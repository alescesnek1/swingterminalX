// Tests for netlify/functions/_price-history-writer.mjs — the disabled-by-
// default, feature-flagged wrapper around writeMarketPriceSnapshot. Not
// wired into any endpoint yet (see the module header for why), so every
// test here injects deps directly rather than touching a real DB, env, or
// HTTP endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  writeMarketSnapshotIfEnabled,
  PRICE_HISTORY_WRITE_ENV_FLAG,
  DEFAULT_PRICE_HISTORY_SOURCE,
} from '../netlify/functions/_price-history-writer.mjs';

test('module exports the expected function and constants with no import-time DB/env access', () => {
  assert.equal(typeof writeMarketSnapshotIfEnabled, 'function');
  assert.equal(PRICE_HISTORY_WRITE_ENV_FLAG, 'PRICE_HISTORY_WRITE_ENABLED');
  assert.equal(typeof DEFAULT_PRICE_HISTORY_SOURCE, 'string');
});

test('flag absent means no DB call and a stable skip result', async () => {
  let writeCalled = false;
  const res = await writeMarketSnapshotIfEnabled(
    { rows: [{ symbol: 'btc' }] },
    { env: {}, writeMarketPriceSnapshot: async () => { writeCalled = true; return { ok: true }; } },
  );
  assert.deepEqual(res, { ok: true, skipped: true, reason: 'DISABLED' });
  assert.equal(writeCalled, false);
});

test('flag explicitly false means no DB call and a stable skip result', async () => {
  let writeCalled = false;
  const res = await writeMarketSnapshotIfEnabled(
    { rows: [{ symbol: 'btc' }] },
    { env: { PRICE_HISTORY_WRITE_ENABLED: 'false' }, writeMarketPriceSnapshot: async () => { writeCalled = true; return { ok: true }; } },
  );
  assert.deepEqual(res, { ok: true, skipped: true, reason: 'DISABLED' });
  assert.equal(writeCalled, false);
});

test('a non-boolean-string flag value is treated as disabled (strict "true" match only)', async () => {
  let writeCalled = false;
  const res = await writeMarketSnapshotIfEnabled(
    { rows: [] },
    { env: { PRICE_HISTORY_WRITE_ENABLED: '1' }, writeMarketPriceSnapshot: async () => { writeCalled = true; return { ok: true }; } },
  );
  assert.deepEqual(res, { ok: true, skipped: true, reason: 'DISABLED' });
  assert.equal(writeCalled, false);
});

test('flag true calls writeMarketPriceSnapshot with a small, sanitized metadata object', async () => {
  let capturedArgs = null;
  const res = await writeMarketSnapshotIfEnabled(
    { rows: [{ symbol: 'btc' }, { symbol: 'eth' }], source: 'test_source', endpoint: '/api/markets', status: 'ok' },
    {
      env: { PRICE_HISTORY_WRITE_ENABLED: 'true' },
      writeMarketPriceSnapshot: async (args) => { capturedArgs = args; return { ok: true, snapshotId: 1, inserted: 2, dropped: 0, duplicates: 0 }; },
    },
  );
  assert.equal(res.ok, true);
  assert.equal(res.skipped, false);
  assert.equal(res.written, true);
  assert.equal(res.snapshotId, 1);
  assert.equal(res.inserted, 2);

  assert.ok(capturedArgs);
  assert.equal(capturedArgs.source, 'test_source');
  assert.deepEqual(capturedArgs.rows, [{ symbol: 'btc' }, { symbol: 'eth' }]);
  assert.deepEqual(capturedArgs.metadata, { rowCount: 2, endpoint: '/api/markets', dataStatus: 'ok' });
  // metadata must never carry the raw rows themselves.
  assert.equal('rows' in capturedArgs.metadata, false);
});

test('missing source falls back to DEFAULT_PRICE_HISTORY_SOURCE', async () => {
  let capturedArgs = null;
  await writeMarketSnapshotIfEnabled(
    { rows: [] },
    {
      env: { PRICE_HISTORY_WRITE_ENABLED: 'true' },
      writeMarketPriceSnapshot: async (args) => { capturedArgs = args; return { ok: true, snapshotId: 1, inserted: 0, dropped: 0, duplicates: 0 }; },
    },
  );
  assert.equal(capturedArgs.source, DEFAULT_PRICE_HISTORY_SOURCE);
});

test('DB unavailable (writeMarketPriceSnapshot returns ok:false) does not throw and reports written:false', async () => {
  const res = await writeMarketSnapshotIfEnabled(
    { rows: [{ symbol: 'btc' }] },
    {
      env: { PRICE_HISTORY_WRITE_ENABLED: 'true' },
      writeMarketPriceSnapshot: async () => ({ ok: false, reason: 'DB_UNAVAILABLE' }),
    },
  );
  assert.deepEqual(res, { ok: true, skipped: false, written: false, reason: 'DB_UNAVAILABLE' });
});

test('a thrown error from writeMarketPriceSnapshot never propagates to the caller', async () => {
  const res = await writeMarketSnapshotIfEnabled(
    { rows: [{ symbol: 'btc' }] },
    {
      env: { PRICE_HISTORY_WRITE_ENABLED: 'true' },
      writeMarketPriceSnapshot: async () => { throw new Error('simulated: postgres://user:pw@host:5432/db'); },
    },
  );
  assert.deepEqual(res, { ok: true, skipped: false, written: false, reason: 'WRITE_ERROR' });
});

test('a thrown error from writeMarketPriceSnapshot is never logged with a secret-shaped value', async () => {
  const originalWarn = console.warn;
  const calls = [];
  console.warn = (...args) => { calls.push(args); };
  try {
    await writeMarketSnapshotIfEnabled(
      { rows: [] },
      {
        env: { PRICE_HISTORY_WRITE_ENABLED: 'true' },
        writeMarketPriceSnapshot: async () => { throw new Error('simulated: postgres://user:pw@host:5432/db'); },
      },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls.length, 1);
  const serialized = JSON.stringify(calls[0]);
  assert.equal(serialized.includes('postgres://'), false);
  assert.equal(serialized.includes('user:pw'), false);
});

test('a module-load failure never propagates to the caller', async () => {
  const res = await writeMarketSnapshotIfEnabled(
    { rows: [] },
    {
      env: { PRICE_HISTORY_WRITE_ENABLED: 'true' },
      loadPriceHistory: async () => { throw new Error('simulated module load failure'); },
    },
  );
  assert.deepEqual(res, { ok: true, skipped: false, written: false, reason: 'MODULE_LOAD_FAILED' });
});

test('non-array rows are treated as an empty batch instead of throwing', async () => {
  let capturedArgs = null;
  const res = await writeMarketSnapshotIfEnabled(
    { rows: 'not-an-array' },
    {
      env: { PRICE_HISTORY_WRITE_ENABLED: 'true' },
      writeMarketPriceSnapshot: async (args) => { capturedArgs = args; return { ok: true, snapshotId: 1, inserted: 0, dropped: 0, duplicates: 0 }; },
    },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(capturedArgs.rows, []);
  assert.equal(capturedArgs.metadata.rowCount, 0);
});

test('a missing/non-object input does not throw', async () => {
  const res = await writeMarketSnapshotIfEnabled(undefined, {
    env: { PRICE_HISTORY_WRITE_ENABLED: 'true' },
    writeMarketPriceSnapshot: async () => ({ ok: true, snapshotId: 1, inserted: 0, dropped: 0, duplicates: 0 }),
  });
  assert.equal(res.ok, true);
});

test('real process.env is the default source and is unset-safe (flag absent means disabled)', async () => {
  // No `env` override here — exercises the real process.env read path.
  // Explicitly unset for the duration of this test (then restored) so the
  // assertion is deterministic regardless of the runner's shell env.
  const had = 'PRICE_HISTORY_WRITE_ENABLED' in process.env;
  const prev = process.env.PRICE_HISTORY_WRITE_ENABLED;
  delete process.env.PRICE_HISTORY_WRITE_ENABLED;
  try {
    const res = await writeMarketSnapshotIfEnabled({ rows: [] });
    assert.deepEqual(res, { ok: true, skipped: true, reason: 'DISABLED' });
  } finally {
    if (had) process.env.PRICE_HISTORY_WRITE_ENABLED = prev;
  }
});
