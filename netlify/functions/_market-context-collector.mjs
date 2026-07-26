import { makeRunKey, withContextTransaction } from './_market-context-store.mjs';

export const MARKET_CONTEXT_COLLECT_ENV_FLAG = 'MARKET_CONTEXT_COLLECT_ENABLED';
export const MARKET_CONTEXT_FUTURES_ENV_FLAG = 'MARKET_CONTEXT_FUTURES_ENABLED';
export const MARKET_CONTEXT_TOP_N_ENV_FLAG = 'MARKET_CONTEXT_MICROSTRUCTURE_TOP_N';
export const MARKET_CONTEXT_MULTI_TF_ENV_FLAG = 'MARKET_CONTEXT_MULTI_TF_ENABLED';
export const MARKET_CONTEXT_MULTI_TF_TOP_N_ENV_FLAG = 'MARKET_CONTEXT_MULTI_TF_TOP_N';

async function loadStore() { return await import('./_market-context-store.mjs'); }
async function loadSource() { return await import('./_binance-market-context-source.mjs'); }
function topN(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 8) : 5; }
function outcome(status, body) { return { status, body: { endpoint: 'market_context_collect_scheduled', ...body } }; }

// Private three-minute coordinator. A collection run is audit metadata only;
// every persisted market value is an atomic time-addressable database row.
export async function runMarketContextCollector(deps = {}) {
  const env = deps.env || process.env;
  if (env[MARKET_CONTEXT_COLLECT_ENV_FLAG] !== 'true') return outcome(200, { ok: true, skipped: true, reason: 'COLLECT_DISABLED' });
  let store; try { store = deps.store || await (deps.loadStore || loadStore)(); } catch { return outcome(503, { ok: false, reason: 'DB_UNAVAILABLE' }); }
  const observedAt = typeof deps.now === 'function' ? new Date(deps.now()) : new Date();
  const runKey = store.makeRunKey ? store.makeRunKey(observedAt) : makeRunKey(observedAt);
  const multiTfTopN = Number(env[MARKET_CONTEXT_MULTI_TF_TOP_N_ENV_FLAG]);
  const options = { includeFutures: env[MARKET_CONTEXT_FUTURES_ENV_FLAG] === 'true', microstructureTopN: topN(env[MARKET_CONTEXT_TOP_N_ENV_FLAG]), includeMultiTimeframe: env[MARKET_CONTEXT_MULTI_TF_ENV_FLAG] === 'true', multiTimeframeTopN: Number.isFinite(multiTfTopN) && multiTfTopN > 0 ? multiTfTopN : undefined, fetchImpl: deps.fetchImpl };
  const transaction = deps.withTransaction || store.withContextTransaction || withContextTransaction;
  const tx = await transaction(async (db) => {
    const run = await store.upsertCollectionRunByKey(db, { runKey, observedAt, diagnostics: { source: 'binance_public_rest', futuresEnabled: options.includeFutures } });
    if (!run.ok) return run;
    if (run.status === 'published') return { ok: true, skipped: true, reason: 'RUN_ALREADY_PUBLISHED', runKey };
    let source; try { source = deps.source || await (deps.loadSource || loadSource)(); } catch { return { ok: false, reason: 'MARKET_SOURCE_UNAVAILABLE' }; }
    const collected = await source.collectBinanceMarketContext(options);
    if (!collected?.ok) return { ok: false, reason: collected?.reason || 'MARKET_FETCH_FAILED' };
    const written = await store.insertAtomicMarketRecords(db, { runId: run.runId, observedAt: collected.observedAt, rows: collected.rows, microstructure: collected.microstructure });
    if (!written.ok) return written;
    const completed = await store.completeCollectionRun(db, { runId: run.runId, completedAt: collected.collectedAt, diagnostics: { ...collected.diagnostics, dataStatus: collected.dataStatus, tickerCount: written.tickerCount, candleCount: written.candleCount, orderBookLevelCount: written.orderBookLevelCount, aggTradeCount: written.aggTradeCount, measurementCount: written.measurementCount } });
    if (!completed.ok) return completed;
    return { ok: true, runKey, runId: run.runId, dataStatus: collected.dataStatus, futuresEnabled: options.includeFutures, futuresStatus: collected.diagnostics?.futuresStatus ?? null, futuresFailureCode: collected.diagnostics?.futuresFailureCode ?? null, futuresTickerCount: collected.diagnostics?.futuresTickerCount ?? 0, multiTimeframeCovered: collected.diagnostics?.multiTimeframeCovered ?? 0, ...written };
  }, { getDbImpl: deps.getDbImpl });
  if (!tx?.ok) { console.warn('[MARKET_CONTEXT] cycle_failed', { reason: tx?.reason || 'DB_UNAVAILABLE', runKey }); return outcome(503, { ok: false, reason: tx?.reason || 'DB_UNAVAILABLE', runKey }); }
  const body = tx.skipped ? { ok: true, skipped: true, reason: tx.reason, runKey } : { ok: true, skipped: false, runKey: tx.runKey, runId: tx.runId, dataStatus: tx.dataStatus, futuresEnabled: tx.futuresEnabled, futuresStatus: tx.futuresStatus, futuresFailureCode: tx.futuresFailureCode, futuresTickerCount: tx.futuresTickerCount, multiTimeframeCovered: tx.multiTimeframeCovered, tickerCount: tx.tickerCount, candleCount: tx.candleCount, orderBookLevelCount: tx.orderBookLevelCount, aggTradeCount: tx.aggTradeCount, measurementCount: tx.measurementCount };
  if (!tx.skipped) console.info('[MARKET_CONTEXT] cycle_completed', { runKey: body.runKey, runId: body.runId, dataStatus: body.dataStatus, futuresEnabled: body.futuresEnabled, futuresStatus: body.futuresStatus, futuresFailureCode: body.futuresFailureCode, futuresTickerCount: body.futuresTickerCount, multiTimeframeCovered: body.multiTimeframeCovered, tickerCount: body.tickerCount, candleCount: body.candleCount, orderBookLevelCount: body.orderBookLevelCount, aggTradeCount: body.aggTradeCount, measurementCount: body.measurementCount });
  // A requested venue that silently returns nothing must never look like success:
  // futures enabled but not complete is surfaced as a visible warning with its code.
  if (!tx.skipped && tx.futuresEnabled === true && tx.futuresStatus !== 'complete') console.warn('[MARKET_CONTEXT] futures_unavailable', { runKey: body.runKey, futuresStatus: body.futuresStatus, futuresFailureCode: body.futuresFailureCode });
  return outcome(200, body);
}