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

// Ceiling matches the collector: every symbol the collector measured should be
// eligible for RADAR, otherwise EXECUTION_SCORE has no order-book/flow evidence
// for the rest and they can never reach ENTRY_READY.
function topN(env) { const n = Number(env[MARKET_CONTEXT_TOP_N_ENV_FLAG]); return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 600) : 5; }
function outcome(status, body) { return { status, body: { endpoint: 'radar_context_publish', ...body } }; }
function num(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value); }

function tickerToMarket(t) {
  return {
    symbol: t.symbol, market: t.market === 'futures' ? 'futures' : 'spot', status: 'TRADING',
    lastPrice: num(t.last_price), price: num(t.last_price),
    quoteVolume: num(t.quote_volume), quoteVolume24h: num(t.quote_volume), volume: num(t.quote_volume),
    priceChangePercent: num(t.price_change_percent), change24hPct: num(t.price_change_percent),
    change1hPct: num(t.change_1h_pct), change4hPct: num(t.change_4h_pct), change12hPct: num(t.change_12h_pct), change7dPct: num(t.change_7d_pct),
    highPrice: num(t.high_price), lowPrice: num(t.low_price), baseVolume: num(t.base_volume), tradeCount: t.trade_count ?? null,
    // The reclaim evaluator looks for its source levels under the scanner's field
    // names (high_24h / low_24h, see RECLAIM_SOURCE_FIELD_NAMES). Emitting only
    // the camelCase highPrice/lowPrice meant it found NO source field at all and
    // every canonical candidate reported RECLAIM_DATA_SOURCE_MISSING — "no reclaim
    // data" — even with a perfectly good 24h range in the row.
    high_24h: num(t.high_price), low_24h: num(t.low_price),
    high24h: num(t.high_price), low24h: num(t.low_price),
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
  // `trusted` is now a provider verdict, so it alone must not claim STRICT: a
  // live, fresh provider whose every symbol failed validation confirms nothing.
  // DEGRADED is the honest panel state for that — the feed is up, the coverage
  // is not. STRICT requires at least one symbol that actually passed.
  return {
    MICROSTRUCTURE_PROVIDER: stale ? 'STALE' : !trusted ? (hasMicro ? 'UNTRUSTED' : 'OFFLINE') : coverage > 0 ? 'ONLINE' : hasMicro ? 'DEGRADED' : 'OFFLINE',
    LAST_UPDATE: bundle?.run?.observedAt || new Date(nowMs).toISOString(),
    DATA_LATENCY_MS: Math.max(0, Date.now() - observedMs),
    ORDER_BOOK_FEED: hasMicro ? 'OK' : 'MISSING',
    TRADES_FEED: hasMicro ? 'OK' : 'MISSING',
    OI_FEED: 'UNSUPPORTED',
    FUNDING_FEED: 'UNSUPPORTED',
    ABSORB_MODE: trusted && !stale && coverage > 0 ? 'STRICT' : hasMicro ? 'PROXY' : 'DISABLED',
    COVERAGE_SYMBOLS: coverage,
    WINDOW_SEC: bundle?.windowSec ?? null,
  };
}

// Why STRICT absorb did — or did not — confirm on this run. A bare coverage
// count makes a rejected measurement indistinguishable from a genuinely quiet
// market, so every non-ready symbol carries the validator's own reason, and the
// supplied → measured → distinct → ready funnel is reported so a silent loss
// (e.g. two venues of one symbol collapsing onto a single key) stays visible.
function buildAbsorbCoverage(validated, rollingSnapshot, bundle) {
  const rows = Object.entries(validated?.data || {});
  const rejections = {};
  const symbolStatus = {};
  let strictReady = 0;
  for (const [symbol, row] of rows) {
    if (row?.strictReady === true) { strictReady += 1; symbolStatus[symbol] = 'READY'; continue; }
    const reason = typeof row?.foundationReason === 'string' && row.foundationReason ? row.foundationReason : 'unknown';
    rejections[reason] = (rejections[reason] || 0) + 1;
    symbolStatus[symbol] = reason;
  }
  const supplied = (bundle?.microSymbols || []).length;
  const measured = Number(rollingSnapshot?.diagnostics?.measured) || 0;
  const distinct = rollingSnapshot?.data ? Object.keys(rollingSnapshot.data).length : 0;
  return {
    SUPPLIED_MEASUREMENTS: supplied,
    BRIDGE_MEASURED: measured,
    DISTINCT_SYMBOLS: distinct,
    COLLAPSED_DUPLICATES: Math.max(0, measured - distinct),
    NORMALIZED_ROWS: rows.length,
    STRICT_READY: strictReady,
    REJECTIONS: rejections,
    SYMBOL_STATUS: symbolStatus,
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
    // A run's observed_at is stamped when collection STARTS. Request pacing makes a
    // cycle take a minute or more, so measurements taken near the end are newer
    // than it — and the trusted-row validator, which allows only 60s of clock
    // skew, then rejected every one of them as 'measurement-stale'. The rolling
    // snapshot is as of the moment its data was actually complete, so validate it
    // against the NEWEST measurement rather than the run's start.
    const measuredAt = (bundle.microSymbols || [])
      .map((s) => Number(s?.absorb?.rollingMeasuredAtMs ?? s?.observedAtMs))
      .filter((v) => Number.isFinite(v));
    const rollingNowMs = measuredAt.length ? Math.max(nowMs, ...measuredAt) : nowMs;
    const rollingSnapshot = bridge.buildCollectorRollingSnapshot(bundle.microSymbols || [], { nowMs: rollingNowMs, updatedAtMs: rollingNowMs });
    const validatedRolling = rolling.normalizeRollingMicrostructureSnapshot(rollingSnapshot, { nowMs: rollingNowMs });
    const klinesSnapshot = buildKlinesSnapshot(bundle.microSymbols || [], rollingNowMs);
    // `now` must not predate the snapshot it is evaluating. The RADAR's own
    // staleness check is `updatedAtMs > now + 60s`, so passing the run's START
    // time against data completed ~94s later marked the whole snapshot STALE —
    // which the matrix renders as "DATA OFF" on every row. The moment the data
    // was complete is the truthful "now" for evaluating that data.
    const result = radar.evaluateTradingRadar({ markets, source: 'canonical_context', fetchedAt: bundle.run.observedAt, now: rollingNowMs, rollingMicrostructureSnapshot: rollingSnapshot, klinesSnapshot });
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const entryReadyCount = Array.isArray(result.entryReady) ? result.entryReady.length : 0;
    const providerStatus = buildProviderStatus(validatedRolling, bundle, nowMs);
    providerStatus.ABSORB_COVERAGE = buildAbsorbCoverage(validatedRolling, rollingSnapshot, bundle);
    const written = await store.insertRadarRunResult(db, {
      runId: bundle.run.id, status: 'ready', source: 'canonical_context', computedAt: new Date(nowMs),
      candidates, entryReadyCount, marketRegime: result.marketRegime, pipeline: result.pipeline,
      absorbFunnel: result.absorbFunnel, universeDiagnostics: result.universeDiagnostics, providerStatus,
    });
    if (!written.ok) return written;
    return { ok: true, runId: bundle.run.id, candidateCount: written.candidateCount, entryReadyCount, trustedMicro: providerStatus.COVERAGE_SYMBOLS, absorbCoverage: providerStatus.ABSORB_COVERAGE, absorbMode: providerStatus.ABSORB_MODE };
  }, { getDbImpl: deps.getDbImpl });

  if (!tx?.ok) { console.warn('[RADAR_PUBLISH] cycle_failed', { reason: tx?.reason || 'DB_UNAVAILABLE' }); return outcome(503, { ok: false, reason: tx?.reason || 'DB_UNAVAILABLE' }); }
  if (tx.skipped) return outcome(200, { ok: true, skipped: true, reason: tx.reason });
  console.info('[RADAR_PUBLISH] cycle_completed', { runId: tx.runId, candidateCount: tx.candidateCount, entryReadyCount: tx.entryReadyCount, trustedMicro: tx.trustedMicro });
  console.info('[RADAR_ABSORB] coverage', { runId: tx.runId, absorbMode: tx.absorbMode, ...tx.absorbCoverage });
  if (tx.absorbCoverage && tx.absorbCoverage.SUPPLIED_MEASUREMENTS > 0 && tx.absorbCoverage.STRICT_READY === 0) {
    console.warn('[RADAR_ABSORB] no_strict_coverage', { runId: tx.runId, rejections: tx.absorbCoverage.REJECTIONS });
  }
  return outcome(200, { ok: true, skipped: false, runId: tx.runId, candidateCount: tx.candidateCount, entryReadyCount: tx.entryReadyCount, trustedMicro: tx.trustedMicro });
}
