// Private RADAR publisher. Runs after a market collection run is published: it
// reads that one run's canonical atomic data from Postgres, evaluates the Trading
// RADAR (regime, stages, STRICT/PROXY Absorb, reclaim, readiness) over it, and
// persists a single derived RADAR result for the run. Consumers read the stored
// result — nothing recomputes RADAR on the hot read path.
//
// STRICT_ABSORB is measured from the database via the collector rolling bridge; a
// symbol only confirms when its stored microstructure is complete and trusted,
// otherwise the pipeline reports UNKNOWN. No fabricated confirmations.
export const MARKET_CONTEXT_RADAR_ENV_FLAG = 'MARKET_CONTEXT_RADAR_ENABLED';
export const MARKET_CONTEXT_TOP_N_ENV_FLAG = 'MARKET_CONTEXT_MICROSTRUCTURE_TOP_N';

async function loadStore() { return await import('./_market-context-store.mjs'); }
async function loadRadar() { return await import('../../scripts/radar/trading-radar.mjs'); }
async function loadBridge() { return await import('../../scripts/radar/collector-absorb-bridge.mjs'); }
async function loadRolling() { return await import('../../scripts/radar/rolling-microstructure-snapshot.mjs'); }

function topN(env) { const n = Number(env[MARKET_CONTEXT_TOP_N_ENV_FLAG]); return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 8) : 5; }
function outcome(status, body) { return { status, body: { endpoint: 'radar_context_publish', ...body } }; }
function num(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value); }

function tickerToMarket(t) {
  return {
    symbol: t.symbol, market: t.market === 'futures' ? 'futures' : 'spot', status: 'TRADING',
    lastPrice: num(t.last_price), price: num(t.last_price),
    quoteVolume: num(t.quote_volume), quoteVolume24h: num(t.quote_volume), volume: num(t.quote_volume),
    priceChangePercent: num(t.price_change_percent), change24hPct: num(t.price_change_percent),
    highPrice: num(t.high_price), lowPrice: num(t.low_price), baseVolume: num(t.base_volume), tradeCount: t.trade_count ?? null,
  };
}

function buildKlinesSnapshot(microSymbols, nowMs) {
  const data = {};
  for (const s of microSymbols) if (s && s.symbol && Array.isArray(s.klines) && s.klines.length) data[String(s.symbol).toUpperCase()] = s.klines;
  return { timeframe: '1m', updatedAtMs: nowMs, data };
}

// Honest Provider Status Panel data, driven by the VALIDATED rolling snapshot
// (not the asserted trust flag). Spot-only for now → OI/funding UNSUPPORTED.
function buildProviderStatus(validated, bundle, nowMs) {
  const trusted = validated?.trusted === true;
  const stale = validated?.stale === true;
  const coverage = validated?.data ? Object.values(validated.data).filter((row) => row?.strictReady === true).length : 0;
  const hasMicro = (bundle?.microSymbols || []).length > 0;
  const observedMs = bundle?.run?.observedAt ? new Date(bundle.run.observedAt).getTime() : nowMs;
  return {
    MICROSTRUCTURE_PROVIDER: trusted ? 'ONLINE' : stale ? 'STALE' : hasMicro ? 'DEGRADED' : 'OFFLINE',
    LAST_UPDATE: bundle?.run?.observedAt || new Date(nowMs).toISOString(),
    DATA_LATENCY_MS: Math.max(0, Date.now() - observedMs),
    ORDER_BOOK_FEED: hasMicro ? 'OK' : 'MISSING',
    TRADES_FEED: hasMicro ? 'OK' : 'MISSING',
    OI_FEED: 'UNSUPPORTED',
    FUNDING_FEED: 'UNSUPPORTED',
    ABSORB_MODE: trusted ? 'STRICT' : hasMicro ? 'PROXY' : 'DISABLED',
    COVERAGE_SYMBOLS: coverage,
    WINDOW_SEC: bundle?.windowSec ?? null,
  };
}

// Coordinator. With the default flag this returns immediately without importing
// the RADAR engine, DB, or bridge.
export async function runRadarContextPublisher(deps = {}) {
  const env = deps.env || process.env;
  if (env[MARKET_CONTEXT_RADAR_ENV_FLAG] !== 'true') return outcome(200, { ok: true, skipped: true, reason: 'RADAR_DISABLED' });
  let store; try { store = deps.store || await (deps.loadStore || loadStore)(); } catch { return outcome(503, { ok: false, reason: 'DB_UNAVAILABLE' }); }
  let radar; try { radar = deps.radar || await (deps.loadRadar || loadRadar)(); } catch { return outcome(503, { ok: false, reason: 'RADAR_MODULE_UNAVAILABLE' }); }
  let bridge; try { bridge = deps.bridge || await (deps.loadBridge || loadBridge)(); } catch { return outcome(503, { ok: false, reason: 'BRIDGE_MODULE_UNAVAILABLE' }); }
  let rolling; try { rolling = deps.rolling || await (deps.loadRolling || loadRolling)(); } catch { return outcome(503, { ok: false, reason: 'ROLLING_MODULE_UNAVAILABLE' }); }
  const transaction = deps.withTransaction || store.withContextTransaction;

  const tx = await transaction(async (db) => {
    const bundle = deps.bundle || await store.getRadarInputBundle(db, { topN: topN(env), tickerLimit: 1000 });
    if (!bundle?.ok) return bundle || { ok: false, reason: 'DB_UNAVAILABLE' };
    if (!bundle.run) return { ok: true, skipped: true, reason: 'NO_PUBLISHED_RUN' };
    const nowMs = bundle.run.observedAt ? new Date(bundle.run.observedAt).getTime() : Date.now();
    const markets = (bundle.tickers || []).map(tickerToMarket);
    const rollingSnapshot = bridge.buildCollectorRollingSnapshot(bundle.microSymbols || [], { nowMs, updatedAtMs: nowMs });
    const validatedRolling = rolling.normalizeRollingMicrostructureSnapshot(rollingSnapshot, { nowMs });
    const klinesSnapshot = buildKlinesSnapshot(bundle.microSymbols || [], nowMs);
    const result = radar.evaluateTradingRadar({ markets, source: 'canonical_context', fetchedAt: bundle.run.observedAt, now: nowMs, rollingMicrostructureSnapshot: rollingSnapshot, klinesSnapshot });
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const entryReadyCount = Array.isArray(result.entryReady) ? result.entryReady.length : 0;
    const providerStatus = buildProviderStatus(validatedRolling, bundle, nowMs);
    const written = await store.insertRadarRunResult(db, {
      runId: bundle.run.id, status: 'ready', source: 'canonical_context', computedAt: new Date(nowMs),
      candidates, entryReadyCount, marketRegime: result.marketRegime, pipeline: result.pipeline,
      absorbFunnel: result.absorbFunnel, universeDiagnostics: result.universeDiagnostics, providerStatus,
    });
    if (!written.ok) return written;
    return { ok: true, runId: bundle.run.id, candidateCount: written.candidateCount, entryReadyCount, trustedMicro: providerStatus.COVERAGE_SYMBOLS };
  }, { getDbImpl: deps.getDbImpl });

  if (!tx?.ok) { console.warn('[RADAR_PUBLISH] cycle_failed', { reason: tx?.reason || 'DB_UNAVAILABLE' }); return outcome(503, { ok: false, reason: tx?.reason || 'DB_UNAVAILABLE' }); }
  if (tx.skipped) return outcome(200, { ok: true, skipped: true, reason: tx.reason });
  console.info('[RADAR_PUBLISH] cycle_completed', { runId: tx.runId, candidateCount: tx.candidateCount, entryReadyCount: tx.entryReadyCount, trustedMicro: tx.trustedMicro });
  return outcome(200, { ok: true, skipped: false, runId: tx.runId, candidateCount: tx.candidateCount, entryReadyCount: tx.entryReadyCount, trustedMicro: tx.trustedMicro });
}
