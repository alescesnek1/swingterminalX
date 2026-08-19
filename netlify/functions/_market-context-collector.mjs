import { makeRunKey, withContextTransaction } from './_market-context-store.mjs';
import { marketContextCollectAllowed, noteCostBreakerBlock, REASON_MARKET_CONTEXT_COLLECT_DISABLED } from './_cost-breaker.mjs';

export const MARKET_CONTEXT_COLLECT_ENV_FLAG = 'MARKET_CONTEXT_COLLECT_ENABLED';
export const MARKET_CONTEXT_FUTURES_ENV_FLAG = 'MARKET_CONTEXT_FUTURES_ENABLED';
export const MARKET_CONTEXT_TOP_N_ENV_FLAG = 'MARKET_CONTEXT_MICROSTRUCTURE_TOP_N';
export const MARKET_CONTEXT_MULTI_TF_ENV_FLAG = 'MARKET_CONTEXT_MULTI_TF_ENABLED';
export const MARKET_CONTEXT_MULTI_TF_TOP_N_ENV_FLAG = 'MARKET_CONTEXT_MULTI_TF_TOP_N';
export const MARKET_CONTEXT_CONCURRENCY_ENV_FLAG = 'MARKET_CONTEXT_MICROSTRUCTURE_CONCURRENCY';
export const MARKET_CONTEXT_RAW_SAMPLE_ENV_FLAG = 'MARKET_CONTEXT_RAW_SAMPLE_TOP_N';
export const MARKET_CONTEXT_WEIGHT_BUDGET_ENV_FLAG = 'MARKET_CONTEXT_WEIGHT_BUDGET_PER_MIN';
export const MARKET_CONTEXT_FUTURES_TOP_N_ENV_FLAG = 'MARKET_CONTEXT_FUTURES_MICROSTRUCTURE_TOP_N';
// How the measurement budget is spread across the liquid pool. POOL_SIZE bounds the
// eligible universe (an illiquid pair the universe filter rejects must never consume
// a slot); MAJOR_SLOTS reserves the top-liquidity coins so BTC/ETH context is always
// measured, and every remaining slot goes to the deepest 24h drawdowns — the coins
// that can actually carry the dislocation+flush setup. Unset takes the source
// module's defaults; neither flag can widen the budget past MICROSTRUCTURE_TOP_N.
export const MARKET_CONTEXT_POOL_SIZE_ENV_FLAG = 'MARKET_CONTEXT_MICROSTRUCTURE_POOL_SIZE';
export const MARKET_CONTEXT_MAJOR_SLOTS_ENV_FLAG = 'MARKET_CONTEXT_MICROSTRUCTURE_MAJOR_SLOTS';

async function loadStore() { return await import('./_market-context-store.mjs'); }
async function loadSource() { return await import('./_binance-market-context-source.mjs'); }
async function loadAbsorb() { return await import('./_market-context-absorb.mjs'); }
// Ceiling matches MAX_MICROSTRUCTURE_TOP_N in the source module: the whole
// USD-stable universe is reachable, but only from the background collector — the
// 30s scheduled path cannot fetch that many symbols and should stay configured small.
function topN(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 600) : 5; }
function outcome(status, body) { return { status, body: { endpoint: 'market_context_collect_scheduled', ...body } }; }

// Private three-minute coordinator. A collection run is audit metadata only;
// every persisted market value is an atomic time-addressable database row.
export async function runMarketContextCollector(deps = {}) {
  const env = deps.env || process.env;
  // Emergency cost breaker — returns before the store module is imported, so no
  // @netlify/database load and no pool.connect(). Routed through the shared
  // breaker so the master DB_READS_ENABLED=false lever disables this too.
  if (!marketContextCollectAllowed(env)) {
    noteCostBreakerBlock('market_context_collector', REASON_MARKET_CONTEXT_COLLECT_DISABLED);
    return outcome(200, { ok: true, skipped: true, reason: 'COLLECT_DISABLED', costGuard: REASON_MARKET_CONTEXT_COLLECT_DISABLED });
  }
  let store; try { store = deps.store || await (deps.loadStore || loadStore)(); } catch { return outcome(503, { ok: false, reason: 'DB_UNAVAILABLE' }); }
  const observedAt = typeof deps.now === 'function' ? new Date(deps.now()) : new Date();
  const runKey = store.makeRunKey ? store.makeRunKey(observedAt) : makeRunKey(observedAt);
  const multiTfTopN = Number(env[MARKET_CONTEXT_MULTI_TF_TOP_N_ENV_FLAG]);
  const options = { includeFutures: env[MARKET_CONTEXT_FUTURES_ENV_FLAG] === 'true', microstructureTopN: topN(env[MARKET_CONTEXT_TOP_N_ENV_FLAG]), includeMultiTimeframe: env[MARKET_CONTEXT_MULTI_TF_ENV_FLAG] === 'true', multiTimeframeTopN: Number.isFinite(multiTfTopN) && multiTfTopN > 0 ? multiTfTopN : undefined, microstructureConcurrency: Number(env[MARKET_CONTEXT_CONCURRENCY_ENV_FLAG]) || undefined, weightBudgetPerMin: Number.isFinite(Number(env[MARKET_CONTEXT_WEIGHT_BUDGET_ENV_FLAG])) ? Number(env[MARKET_CONTEXT_WEIGHT_BUDGET_ENV_FLAG]) : undefined, futuresMicrostructureTopN: Number(env[MARKET_CONTEXT_FUTURES_TOP_N_ENV_FLAG]) || undefined, microstructurePoolSize: Number(env[MARKET_CONTEXT_POOL_SIZE_ENV_FLAG]) || undefined, microstructureMajorSlots: Number(env[MARKET_CONTEXT_MAJOR_SLOTS_ENV_FLAG]) || undefined, fetchImpl: deps.fetchImpl };
  const rawSampleTopN = Number(env[MARKET_CONTEXT_RAW_SAMPLE_ENV_FLAG]);
  const transaction = deps.withTransaction || store.withContextTransaction || withContextTransaction;
  const tx = await transaction(async (db) => {
    const run = await store.upsertCollectionRunByKey(db, { runKey, observedAt, diagnostics: { source: 'binance_public_rest', futuresEnabled: options.includeFutures } });
    if (!run.ok) return run;
    if (run.status === 'published') return { ok: true, skipped: true, reason: 'RUN_ALREADY_PUBLISHED', runKey };
    let source; try { source = deps.source || await (deps.loadSource || loadSource)(); } catch { return { ok: false, reason: 'MARKET_SOURCE_UNAVAILABLE' }; }
    const collected = await source.collectBinanceMarketContext(options);
    if (!collected?.ok) return { ok: false, reason: collected?.reason || 'MARKET_FETCH_FAILED' };
    // Absorption is computed HERE, while the raw trades and candles are still in
    // memory, and stored as one derived row per symbol. Recomputing it on read
    // costs two queries per symbol, which does not scale past a handful.
    let absorb; try { absorb = deps.absorb || await (deps.loadAbsorb || loadAbsorb)(); } catch { absorb = null; }
    let microstructure = collected.microstructure;
    let absorbDiagnostics = { absorbComputed: 0, absorbWithDepthBaseline: 0, absorbWindowSec: null };
    if (absorb && typeof store.getMicrostructureBaseline === 'function') {
      const baseline = await store.getMicrostructureBaseline(db, collected.observedAt);
      if (!baseline?.ok) console.warn('[MARKET_CONTEXT] absorb_baseline_unavailable', { reason: baseline?.reason || 'DB_UNAVAILABLE' });
      const attached = absorb.attachAbsorbRows(collected.microstructure, baseline?.ok ? baseline : null, collected.observedAt);
      microstructure = attached.rows;
      absorbDiagnostics = attached.diagnostics;
    }
    const written = await store.insertAtomicMarketRecords(db, { runId: run.runId, observedAt: collected.observedAt, rows: collected.rows, microstructure, rawSampleTopN: Number.isFinite(rawSampleTopN) && rawSampleTopN >= 0 ? rawSampleTopN : undefined });
    if (!written.ok) return written;
    const completed = await store.completeCollectionRun(db, { runId: run.runId, completedAt: collected.collectedAt, diagnostics: { ...collected.diagnostics, ...absorbDiagnostics, dataStatus: collected.dataStatus, tickerCount: written.tickerCount, candleCount: written.candleCount, orderBookLevelCount: written.orderBookLevelCount, aggTradeCount: written.aggTradeCount, measurementCount: written.measurementCount } });
    if (!completed.ok) return completed;
    return { ok: true, runKey, runId: run.runId, dataStatus: collected.dataStatus, futuresEnabled: options.includeFutures, futuresStatus: collected.diagnostics?.futuresStatus ?? null, futuresFailureCode: collected.diagnostics?.futuresFailureCode ?? null, futuresTickerCount: collected.diagnostics?.futuresTickerCount ?? 0, multiTimeframeCovered: collected.diagnostics?.multiTimeframeCovered ?? 0, pacingWaitedMs: collected.diagnostics?.pacingWaitedMs ?? 0, rateLimitedSymbols: collected.diagnostics?.rateLimitedSymbols ?? 0, ...absorbDiagnostics, ...written };
  }, { getDbImpl: deps.getDbImpl });
  if (!tx?.ok) { console.warn('[MARKET_CONTEXT] cycle_failed', { reason: tx?.reason || 'DB_UNAVAILABLE', runKey }); return outcome(503, { ok: false, reason: tx?.reason || 'DB_UNAVAILABLE', runKey }); }
  const body = tx.skipped ? { ok: true, skipped: true, reason: tx.reason, runKey } : { ok: true, skipped: false, runKey: tx.runKey, runId: tx.runId, dataStatus: tx.dataStatus, futuresEnabled: tx.futuresEnabled, futuresStatus: tx.futuresStatus, futuresFailureCode: tx.futuresFailureCode, futuresTickerCount: tx.futuresTickerCount, multiTimeframeCovered: tx.multiTimeframeCovered, tickerCount: tx.tickerCount, candleCount: tx.candleCount, orderBookLevelCount: tx.orderBookLevelCount, aggTradeCount: tx.aggTradeCount, measurementCount: tx.measurementCount, absorbComputed: tx.absorbComputed, absorbWithDepthBaseline: tx.absorbWithDepthBaseline, absorbWindowSec: tx.absorbWindowSec };
  if (!tx.skipped) console.info('[MARKET_CONTEXT] cycle_completed', { runKey: body.runKey, runId: body.runId, dataStatus: body.dataStatus, futuresEnabled: body.futuresEnabled, futuresStatus: body.futuresStatus, futuresFailureCode: body.futuresFailureCode, futuresTickerCount: body.futuresTickerCount, multiTimeframeCovered: body.multiTimeframeCovered, tickerCount: body.tickerCount, candleCount: body.candleCount, orderBookLevelCount: body.orderBookLevelCount, aggTradeCount: body.aggTradeCount, measurementCount: body.measurementCount, absorbComputed: tx.absorbComputed, absorbWithDepthBaseline: tx.absorbWithDepthBaseline, absorbWindowSec: tx.absorbWindowSec, pacingWaitedMs: tx.pacingWaitedMs, rateLimitedSymbols: tx.rateLimitedSymbols });
  // Measured symbols with no usable N-1 depth cannot yield a depth-rebuild input,
  // so STRICT can never confirm for them. Silent low coverage would look identical
  // to a quiet market, so the shortfall is reported.
  if (!tx.skipped && tx.measurementCount > 0 && (tx.absorbWithDepthBaseline || 0) < tx.measurementCount) console.warn('[MARKET_CONTEXT] absorb_baseline_shortfall', { runKey: body.runKey, measured: tx.measurementCount, withBaseline: tx.absorbWithDepthBaseline || 0, windowSec: tx.absorbWindowSec });
  // Being throttled by the upstream must never look like a healthy cycle: a rate
  // limited symbol silently loses its depth/trades and drops out of STRICT.
  if (!tx.skipped && (tx.rateLimitedSymbols || 0) > 0) console.warn('[MARKET_CONTEXT] upstream_rate_limited', { runKey: body.runKey, rateLimitedSymbols: tx.rateLimitedSymbols, pacingWaitedMs: tx.pacingWaitedMs || 0 });
  // A requested venue that silently returns nothing must never look like success:
  // futures enabled but not complete is surfaced as a visible warning with its code.
  if (!tx.skipped && tx.futuresEnabled === true && tx.futuresStatus !== 'complete') console.warn('[MARKET_CONTEXT] futures_unavailable', { runKey: body.runKey, futuresStatus: body.futuresStatus, futuresFailureCode: body.futuresFailureCode });
  return outcome(200, body);
}