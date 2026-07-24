import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('market Context Store migration defines immutable global revisions and safe head pointers', async () => {
  const sql = await readFile(new URL('../netlify/database/migrations/20260724150000_add_market_context_revision_store/migration.sql', import.meta.url), 'utf8');
  for (const table of ['context_heads', 'market_collection_runs', 'market_context_snapshots', 'market_context_rows', 'market_microstructure_rows', 'radar_context_snapshots', 'radar_candidate_snapshots']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /UNIQUE \(scope_id, run_key\)/);
  assert.match(sql, /published_radar_market_revision_id = published_market_revision_id/);
  assert.match(sql, /UNIQUE \(revision_id, market, symbol\)/);
  assert.doesNotMatch(sql, /token|authorization|api_key/i);
});
