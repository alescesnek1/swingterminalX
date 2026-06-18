import { enrichRadarCandidatesMicrostructure, radarMicrostructureConfigFromEnv } from '../auto/microstructure-enrichment.mjs';
import crypto from 'node:crypto';

export async function fetchRadarCandidates(controlUrl, token, fetchFn = globalThis.fetch) {
  const url = `${controlUrl}/api/bot/radar-candidates`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { 'X-BOT-WORKER-TOKEN': token },
      signal: controller.signal,
    });
    clearTimeout(id);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.radarCandidates || [];
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

export async function postMicrostructure(controlUrl, token, workerId, data, fetchFn = globalThis.fetch) {
  const url = `${controlUrl}/api/bot/radar-microstructure`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BOT-WORKER-TOKEN': token,
      },
      body: JSON.stringify({
        workerId,
        data,
        fetchedAt: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
    clearTimeout(id);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.ok;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

function emptySummary() {
  return {
    candidatesReceived: 0,
    scanLimit: 0,
    targetMeasured: 0,
    candidatesScanned: 0,
    attempted: 0,
    measured: 0,
    skippedNoFapiSymbol: 0,
    failedFetch: 0,
    keys: [],
  };
}

// Reusable, side-effect-light runner shared by the CLI and the Netlify
// scheduled function. Performs exactly ONE read-only cycle:
//   GET /api/bot/radar-candidates  →  public Binance fapi depth/premiumIndex
//   →  POST /api/bot/radar-microstructure
// It NEVER calls process.exit and NEVER throws for runtime/network failures;
// callers map the returned { ok, reason, summary } to their own exit/HTTP code.
// Secrets (token, headers) and response bodies are never logged.
export async function runRadarMicrostructureProducer({
  env = process.env,
  fetchFn = globalThis.fetch,
  logger = console,
  cache,
} = {}) {
  const log = (logger && typeof logger.log === 'function') ? (...a) => logger.log(...a) : () => {};
  const logError = (logger && typeof logger.error === 'function') ? (...a) => logger.error(...a) : log;

  const config = radarMicrostructureConfigFromEnv(env);
  if (!config.enabled) {
    log('WORKER_RADAR_MICROSTRUCTURE_ENABLED is not true. Exiting.');
    return { ok: true, reason: 'disabled', posted: false, summary: emptySummary(), keys: [] };
  }

  const token = env.BOT_WORKER_TOKEN;
  if (!token) {
    logError('Missing BOT_WORKER_TOKEN.');
    return { ok: false, reason: 'missing-token', posted: false, summary: emptySummary(), keys: [] };
  }

  const controlUrlRaw = env.CONTROL_BASE_URL || env.BOT_BASE_URL;
  if (!controlUrlRaw) {
    logError('Missing CONTROL_BASE_URL or BOT_BASE_URL.');
    return { ok: false, reason: 'missing-base-url', posted: false, summary: emptySummary(), keys: [] };
  }
  const controlUrl = String(controlUrlRaw).replace(/\/+$/, '');

  const workerId = `radar_producer_${crypto.randomBytes(4).toString('hex')}`;
  const cacheMap = cache instanceof Map ? cache : new Map();

  log(`[PRODUCER] Starting Radar Microstructure Producer (targetMeasured=${config.topN} scanLimit=${config.scanLimit})`);

  // 1. Fetch candidates (read-only). A failure here is non-fatal for the
  //    scheduler — log the reason and return a clean, zeroed summary.
  let candidates = [];
  try {
    candidates = await fetchRadarCandidates(controlUrl, token, fetchFn);
  } catch (err) {
    logError(`[PRODUCER][ERROR] radar-candidates fetch failed: ${err.message}`);
    const summary = emptySummary();
    log(JSON.stringify({ tag: 'radar-microstructure', ...summary, posted: false, reason: 'candidates-fetch-failed' }));
    return { ok: true, reason: 'candidates-fetch-failed', posted: false, summary, keys: [] };
  }

  // 2. Enrich (fapi-first symbol resolution + public depth/premiumIndex).
  const diagnostics = { perCandidate: [] };
  const data = await enrichRadarCandidatesMicrostructure(candidates, {
    config,
    env,
    fetchImpl: fetchFn,
    cache: cacheMap,
    now: Date.now,
    diagnostics,
  });
  const keys = Object.keys(data);

  // 2a. Per-candidate safe trail. NEVER logs the token, request headers, or any
  //     Binance/backend response body — only derived symbol metadata.
  for (const r of diagnostics.perCandidate) {
    log(
      `[PRODUCER] candidate rank=${r.index} symbol=${r.symbol} base=${r.base} pair=${r.pair} ` +
      `futures_pair=${r.futures_pair} quote=${r.quote} binance_market=${r.binance_market} ` +
      `-> fapiSymbol=${r.fapiSymbol || 'none'} source=${r.source || 'none'} ` +
      `measured=${r.measured ? 'yes' : 'no'}${r.skipReason ? ` skip=${r.skipReason}` : ''}`
    );
  }

  // 3. Post only when something was measured. Post failure is non-fatal
  //    (next tick re-posts) — see docs/radar-microstructure.md exit policy.
  let posted = false;
  if (keys.length) {
    try {
      posted = await postMicrostructure(controlUrl, token, workerId, data, fetchFn);
    } catch (err) {
      logError(`[PRODUCER][ERROR] post failed: ${err.message}`);
    }
  }

  const summary = {
    candidatesReceived: diagnostics.candidatesReceived,
    scanLimit: diagnostics.scanLimit,
    targetMeasured: diagnostics.targetMeasured,
    candidatesScanned: diagnostics.candidatesScanned,
    attempted: diagnostics.attempted,
    measured: diagnostics.measured,
    skippedNoFapiSymbol: diagnostics.skippedNoFapiSymbol,
    failedFetch: diagnostics.failedFetch,
    keys: keys.slice(0, 20),
  };

  // 4. Structured summary (counts only).
  log(JSON.stringify({ tag: 'radar-microstructure', ...summary, posted }));

  if (!keys.length) {
    log('[PRODUCER] No microstructure data measured.');
  } else {
    log(`[PRODUCER] Posted ${keys.length} metrics ok=${posted}`);
  }

  return { ok: true, reason: keys.length ? 'measured' : 'no-data', posted, summary, keys };
}

// CLI entry point. Maps the runner result to a process exit code: only a
// configuration error (missing token / base URL) is non-zero; runtime/network
// failures stay 0 so a scheduler/cron never red-marks a transient blip.
export async function main() {
  const isLoop = process.argv.includes('--loop');
  const cache = new Map();

  const first = await runRadarMicrostructureProducer({ env: process.env, fetchFn: globalThis.fetch, logger: console, cache });
  if (first.reason === 'missing-token' || first.reason === 'missing-base-url') {
    process.exit(1);
  }

  if (isLoop) {
    const config = radarMicrostructureConfigFromEnv(process.env);
    const intervalMs = config.cacheMs > 0 ? config.cacheMs : 10000;
    console.log(`[PRODUCER] Running in loop mode every ${intervalMs}ms.`);
    setInterval(() => {
      runRadarMicrostructureProducer({ env: process.env, fetchFn: globalThis.fetch, logger: console, cache })
        .catch((err) => console.error(err));
    }, intervalMs);
  }
}

const isMainModule = (() => {
  try { return !!process.argv[1] && process.argv[1] === import.meta.filename; } catch { return true; }
})();

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
