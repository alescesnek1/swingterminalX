import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('atomic market migration guards legacy data, removes snapshot tables, and creates indexed atomic records', async () => {
  const sql = await readFile(new URL('../netlify/database/migrations/20260724190000_replace_context_snapshots_with_atomic_market_records/migration.sql', import.meta.url), 'utf8');
  for (const table of ['market_instruments', 'market_ticker_observations', 'market_candles_1m', 'market_order_book_levels', 'market_agg_trades', 'market_microstructure_measurements']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  for (const legacy of ['context_heads', 'market_context_snapshots', 'market_context_rows', 'market_microstructure_rows', 'radar_context_snapshots', 'radar_candidate_snapshots']) assert.match(sql, new RegExp(`DROP TABLE IF EXISTS ${legacy}`));
  assert.match(sql, /UNIQUE \(run_id, market, symbol\)/);
  assert.match(sql, /UNIQUE \(market, symbol, open_time\)/);
  assert.match(sql, /UNIQUE \(market, symbol, agg_trade_id\)/);
  for (const index of ['market_order_book_levels_market_symbol_time_idx', 'market_agg_trades_market_symbol_time_idx', 'market_microstructure_measurements_market_symbol_time_idx']) assert.match(sql, new RegExp(index));
  assert.match(sql, /Refusing to remove non-empty legacy Context Store tables/);
});