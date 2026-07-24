import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRunKey, sanitizeDiagnostics, publishContextHeadSafely, getPublishedContext } from '../netlify/functions/_market-context-store.mjs';

test('makeRunKey uses a deterministic UTC three-minute bucket', () => {
  assert.equal(makeRunKey(new Date('2026-07-24T12:04:59.999Z')), 'global:2026-07-24T12:03:00.000Z');
  assert.equal(makeRunKey(new Date('2026-07-24T12:06:00.000Z')), 'global:2026-07-24T12:06:00.000Z');
});

test('sanitizeDiagnostics strips secret-shaped values at every depth', () => {
  const clean = sanitizeDiagnostics({ count: 2, authorization: 'Bearer x', nested: { apiKey: 'no', status: 'ok' }, headers: { accept: 'x' }, rows: [{ token: 'x', code: 'PARTIAL' }] });
  assert.deepEqual(clean, { count: 2, nested: { status: 'ok' }, rows: [{ code: 'PARTIAL' }] });
  assert.doesNotMatch(JSON.stringify(clean), /Bearer|apiKey|token|headers/i);
});

test('older market revision cannot overwrite a newer published head', async () => {
  const calls = [];
  const db = { query: async (sql) => {
    calls.push(sql);
    if (sql.includes('FROM context_heads')) return { rows: [{ published_market_revision_id: 9, observed_at: '2026-07-24T12:06:00.000Z' }] };
    if (sql.includes('FROM market_context_snapshots WHERE id')) return { rows: [{ observed_at: '2026-07-24T12:03:00.000Z' }] };
    throw new Error('unexpected query');
  } };
  const result = await publishContextHeadSafely(db, { marketRevisionId: 8 });
  assert.deepEqual(result, { ok: false, reason: 'STALE_REVISION' });
  assert.equal(calls.some((sql) => sql.startsWith('UPDATE context_heads')), false);
});

test('published context is one coherent market/radar envelope', async () => {
  const db = { query: async (sql) => {
    if (sql.includes('FROM context_heads h')) return { rows: [{ published_market_revision_id: 12, published_radar_revision_id: null, published_at: '2026-07-24T12:00:00.000Z', observed_at: new Date().toISOString(), collected_at: new Date().toISOString(), data_status: 'partial', diagnostics: { rows: 1 }, radar_status: null, radar_market_revision_id: null }] };
    if (sql.includes('FROM market_context_rows')) return { rows: [{ market: 'spot', symbol: 'BTCUSDT', data_status: 'complete' }] };
    if (sql.includes('FROM market_microstructure_rows')) return { rows: [{ market: 'spot', symbol: 'BTCUSDT', data_status: 'partial', missing_inputs: ['DEPTH'] }] };
    throw new Error('unexpected query');
  } };
  const context = await getPublishedContext(db);
  assert.equal(context.ok, true); assert.equal(context.contextVersion, 12);
  assert.equal(context.market.revision, 12); assert.equal(context.radar.marketRevision, 12);
  assert.equal(context.radar.status, 'PENDING'); assert.equal(context.market.microstructure[0].data_status, 'partial');
});
