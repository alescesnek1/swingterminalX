import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKET_CONTEXT_COLLECT_ENV_FLAG, runMarketContextCollector } from '../netlify/functions/_market-context-collector.mjs';

test('collector is a no-op by default and does not load its dependencies', async () => {
  let loaded = false;
  const result = await runMarketContextCollector({ env: {}, loadStore: async () => { loaded = true; throw new Error('must not load'); } });
  assert.equal(result.status, 200); assert.equal(result.body.reason, 'COLLECT_DISABLED'); assert.equal(loaded, false);
});

test('collector saves one immutable revision through the store transaction only', async () => {
  const calls = [];
  const store = {
    makeRunKey: () => 'global:2026-07-24T12:00:00.000Z',
    withContextTransaction: async (fn) => await fn({}),
    upsertCollectionRunByKey: async () => ({ ok: true, runId: 4, status: 'started' }),
    insertMarketContextRevision: async () => ({ ok: true, revisionId: 9, observedAt: new Date() }),
    insertMarketRows: async () => ({ ok: true, inserted: 1 }),
    insertMicrostructureRows: async () => ({ ok: true, inserted: 1 }),
    publishContextHeadSafely: async () => ({ ok: true }),
  };
  const source = { collectBinanceMarketContext: async () => ({ ok: true, observedAt: new Date(), collectedAt: new Date(), dataStatus: 'partial', diagnostics: {}, rows: [{ market: 'spot' }], microstructure: [{ market: 'spot' }] }) };
  const result = await runMarketContextCollector({ env: { [MARKET_CONTEXT_COLLECT_ENV_FLAG]: 'true' }, store, source, now: () => Date.parse('2026-07-24T12:00:01.000Z') });
  assert.equal(result.status, 200); assert.equal(result.body.revisionId, 9); assert.equal(result.body.dataStatus, 'partial');
});
