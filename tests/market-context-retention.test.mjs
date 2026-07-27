import test from 'node:test';
import assert from 'node:assert/strict';
import { runMarketContextRetention } from '../netlify/functions/_market-context-retention.mjs';

const NOW = 1_800_000_000_000;
const H = 3600_000;
function harness(capture) {
  return {
    now: () => NOW,
    withTransaction: async (cb) => cb({}),
    store: { withContextTransaction: async (cb) => cb({}), pruneCanonicalContext: async (_db, opts) => { capture.opts = opts; return { ok: true, protectedRunId: 9, deleted: { tickers: 3 } }; } },
  };
}

test('retention is a no-op unless explicitly enabled', async () => {
  const capture = {};
  const res = await runMarketContextRetention({ env: {}, ...harness(capture) });
  assert.equal(res.body.skipped, true);
  assert.equal(res.body.reason, 'RETENTION_DISABLED');
  assert.equal(capture.opts, undefined);
});

test('enabled retention prunes with default 48h market / 168h radar cutoffs', async () => {
  const capture = {};
  const res = await runMarketContextRetention({ env: { MARKET_CONTEXT_RETENTION_ENABLED: 'true' }, ...harness(capture) });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.skipped, false);
  assert.equal(new Date(capture.opts.marketCutoff).getTime(), NOW - 48 * H);
  assert.equal(new Date(capture.opts.radarCutoff).getTime(), NOW - 168 * H);
  assert.equal(res.body.protectedRunId, 9);
});

test('a below-floor market window is clamped to the 6h minimum (no wiping fresh data)', async () => {
  const capture = {};
  await runMarketContextRetention({ env: { MARKET_CONTEXT_RETENTION_ENABLED: 'true', MARKET_CONTEXT_RETENTION_MARKET_HOURS: '1' }, ...harness(capture) });
  assert.equal(new Date(capture.opts.marketCutoff).getTime(), NOW - 6 * H);
});

test('radar retention is never shorter than market retention', async () => {
  const capture = {};
  await runMarketContextRetention({ env: { MARKET_CONTEXT_RETENTION_ENABLED: 'true', MARKET_CONTEXT_RETENTION_MARKET_HOURS: '48', MARKET_CONTEXT_RETENTION_RADAR_HOURS: '10' }, ...harness(capture) });
  assert.equal(new Date(capture.opts.radarCutoff).getTime(), NOW - 48 * H);
});
