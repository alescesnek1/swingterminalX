import test from 'node:test';
import assert from 'node:assert/strict';
import { runContextRead } from '../netlify/functions/context.mjs';

function request(method = 'GET') { return new Request('https://example.test/api/context', { method, headers: { Origin: 'https://example.test' } }); }

test('context API rejects missing identity before database work', async () => {
  const response = await runContextRead(request(), { getIdentity: async () => ({ ok: false }) });
  assert.equal(response.status, 401); assert.equal((await response.json()).reason, 'UNAUTHENTICATED');
});

test('context API returns the coherent store envelope without writes', async () => {
  const envelope = { ok: true, contextVersion: 5, market: { revision: 5, observedAt: '2026-07-24T12:00:00.000Z', collectedAt: '2026-07-24T12:00:01.000Z', freshness: 'FRESH', rows: [], microstructure: [], dataQuality: {} }, radar: { revision: null, marketRevision: 5, status: 'PENDING', payload: null } };
  const response = await runContextRead(request(), { getIdentity: async () => ({ ok: true, verified: true }), store: { getPublishedContext: async () => envelope }, database: {} });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), envelope);
});
