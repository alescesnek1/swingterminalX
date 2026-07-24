import { makeRunKey, withContextTransaction } from './_market-context-store.mjs';

export const MARKET_CONTEXT_COLLECT_ENV_FLAG = 'MARKET_CONTEXT_COLLECT_ENABLED';
export const MARKET_CONTEXT_FUTURES_ENV_FLAG = 'MARKET_CONTEXT_FUTURES_ENABLED';
export const MARKET_CONTEXT_TOP_N_ENV_FLAG = 'MARKET_CONTEXT_MICROSTRUCTURE_TOP_N';

async function loadStore() { return await import('./_market-context-store.mjs'); }
async function loadSource() { return await import('./_binance-market-context-source.mjs'); }
function topN(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.min(Math.trunc(number), 8) : 5; }
function outcome(status, body) { return { status, body: { endpoint: 'market_context_collect_scheduled', ...body } }; }

// This is intentionally a private coordinator. The scheduled function imports
// it directly; there is no public POST writer route and no request body used as
// authorization. With the default flag it does not load DB or Binance modules.
export async function runMarketContextCollector(deps = {}) {
  const env = deps.env || process.env;
  if (env[MARKET_CONTEXT_COLLECT_ENV_FLAG] !== 'true') return outcome(200, { ok: true, skipped: true, reason: 'COLLECT_DISABLED' });
  let store;
  try { store = deps.store || await (deps.loadStore || loadStore)(); } catch { return outcome(503, { ok: false, reason: 'DB_UNAVAILABLE' }); }
  const observedAt = typeof deps.now === 'function' ? new Date(deps.now()) : new Date();
  const runKey = store.makeRunKey ? store.makeRunKey(observedAt) : makeRunKey(observedAt);
  const sourceOptions = { includeFutures: env[MARKET_CONTEXT_FUTURES_ENV_FLAG] === 'true', microstructureTopN: topN(env[MARKET_CONTEXT_TOP_N_ENV_FLAG]), fetchImpl: deps.fetchImpl };
  const transactional = deps.withTransaction || store.withContextTransaction || withContextTransaction;
  const tx = await transactional(async (db) => {
    const run = await store.upsertCollectionRunByKey(db, { runKey, status: 'started', observedAt, diagnostics: { source: 'binance_public_rest', futuresEnabled: sourceOptions.includeFutures } });
    if (!run.ok) return run;
    if (run.status === 'published') return { ok: true, skipped: true, reason: 'RUN_ALREADY_PUBLISHED', runKey };
    let source;
    try { source = deps.source || await (deps.loadSource || loadSource)(); } catch { return { ok: false, reason: 'MARKET_SOURCE_UNAVAILABLE' }; }
    const collected = await source.collectBinanceMarketContext(sourceOptions);
    if (!collected?.ok) return { ok: false, reason: collected?.reason || 'MARKET_FETCH_FAILED' };
    const revision = await store.insertMarketContextRevision(db, { runId: run.runId, observedAt: collected.observedAt, collectedAt: collected.collectedAt, dataStatus: collected.dataStatus, diagnostics: collected.diagnostics });
    if (!revision.ok) return revision;
    const rows = await store.insertMarketRows(db, revision, collected.rows);
    if (!rows.ok) return rows;
    const micro = await store.insertMicrostructureRows(db, revision, collected.microstructure);
    if (!micro.ok) return micro;
    const published = await store.publishContextHeadSafely(db, { marketRevisionId: revision.revisionId, runId: run.runId });
    if (!published.ok) return published;
    return { ok: true, runKey, revisionId: revision.revisionId, rowCount: rows.inserted, microstructureCount: micro.inserted, dataStatus: collected.dataStatus, futuresEnabled: sourceOptions.includeFutures };
  }, { getDbImpl: deps.getDbImpl });
  if (!tx?.ok) {
    console.warn('[MARKET_CONTEXT] cycle_failed', { reason: tx?.reason || 'DB_UNAVAILABLE', runKey });
    return outcome(tx?.reason === 'STALE_REVISION' ? 409 : 503, { ok: false, reason: tx?.reason || 'DB_UNAVAILABLE', runKey });
  }
  return outcome(200, tx.skipped ? { ok: true, skipped: true, reason: tx.reason, runKey } : { ok: true, skipped: false, runKey: tx.runKey, revisionId: tx.revisionId, rowCount: tx.rowCount, microstructureCount: tx.microstructureCount, dataStatus: tx.dataStatus, futuresEnabled: tx.futuresEnabled });
}
