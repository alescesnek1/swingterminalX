import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKET_CONTEXT_COLLECT_ENV_FLAG, runMarketContextCollector } from '../netlify/functions/_market-context-collector.mjs';

test('collector is a no-op by default and does not load dependencies', async () => {
  let loaded = false; const result = await runMarketContextCollector({ env: {}, loadStore: async () => { loaded = true; throw new Error('must not load'); } });
  assert.equal(result.status, 200); assert.equal(result.body.reason, 'COLLECT_DISABLED'); assert.equal(loaded, false);
});

test('collector persists atomized records and completes only the audit run', async () => {
  const store = { makeRunKey: () => 'global:2026-07-24T12:00:00.000Z', withContextTransaction: async (fn) => await fn({}), upsertCollectionRunByKey: async () => ({ ok: true, runId: 4, status: 'started' }), insertAtomicMarketRecords: async () => ({ ok: true, tickerCount: 1, candleCount: 2, orderBookLevelCount: 4, aggTradeCount: 3, measurementCount: 1 }), completeCollectionRun: async () => ({ ok: true }) };
  const source = { collectBinanceMarketContext: async () => ({ ok: true, observedAt: new Date(), collectedAt: new Date(), dataStatus: 'partial', diagnostics: {}, rows: [{ market: 'spot' }], microstructure: [{ market: 'spot' }] }) };
  const result = await runMarketContextCollector({ env: { [MARKET_CONTEXT_COLLECT_ENV_FLAG]: 'true' }, store, source, now: () => Date.parse('2026-07-24T12:00:01.000Z') });
  assert.equal(result.status, 200); assert.equal(result.body.runId, 4); assert.equal(result.body.tickerCount, 1); assert.equal(result.body.orderBookLevelCount, 4); assert.equal('revisionId' in result.body, false);
});