import { fetchWithTimeoutAndRetry } from '../auto/binance-public.mjs';
import { enrichRadarCandidatesMicrostructure, radarMicrostructureConfigFromEnv } from '../auto/microstructure-enrichment.mjs';
import crypto from 'node:crypto';

export async function fetchRadarCandidates(controlUrl, token) {
  const url = `${controlUrl}/api/bot/radar-candidates`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
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

export async function postMicrostructure(controlUrl, token, workerId, data) {
  const url = `${controlUrl}/api/bot/radar-microstructure`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
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

export async function main() {
  const config = radarMicrostructureConfigFromEnv(process.env);
  if (!config.enabled) {
    console.log('WORKER_RADAR_MICROSTRUCTURE_ENABLED is not true. Exiting.');
    return;
  }

  const token = process.env.BOT_WORKER_TOKEN;
  if (!token) {
    console.error('Missing BOT_WORKER_TOKEN.');
    process.exit(1);
  }

  const controlUrlRaw = process.env.CONTROL_BASE_URL || process.env.BOT_BASE_URL;
  if (!controlUrlRaw) {
    console.error('Missing CONTROL_BASE_URL or BOT_BASE_URL.');
    process.exit(1);
  }
  const controlUrl = String(controlUrlRaw).replace(/\/+$/, '');

  const workerId = `radar_producer_${crypto.randomBytes(4).toString('hex')}`;
  const isLoop = process.argv.includes('--loop');
  const cacheMs = config.cacheMs > 0 ? config.cacheMs : 10000;
  
  // Custom fetchImpl to pass headers correctly for the control plane. Wait, fetchWithTimeoutAndRetry
  // in binance-public.mjs does NOT take headers parameter. It only sends { Accept: 'application/json' }.
  // So we must rewrite fetchRadarCandidates to use standard fetch with headers.
  
  console.log(`[PRODUCER] Starting Radar Microstructure Producer (topN=${config.topN})`);

  let cache = new Map();
  
  async function runCycle() {
    try {
      // 1. Fetch candidates (read-only). A failure here is non-fatal for the
      //    scheduler — log the reason and exit the cycle cleanly.
      let candidates = [];
      try {
        candidates = await fetchRadarCandidates(controlUrl, token);
      } catch (err) {
        console.error(`[PRODUCER][ERROR] radar-candidates fetch failed: ${err.message}`);
        console.log(JSON.stringify({
          tag: 'radar-microstructure', candidatesReceived: 0, candidatesSelected: 0,
          attempted: 0, measured: 0, skippedNoFapiSymbol: 0, failedFetch: 0,
          posted: false, reason: 'candidates-fetch-failed',
        }));
        return;
      }

      // 2. Enrich (fapi-first symbol resolution + public depth/premiumIndex).
      const diagnostics = { perCandidate: [] };
      const data = await enrichRadarCandidatesMicrostructure(candidates, {
        config,
        env: process.env,
        cache,
        now: Date.now,
        diagnostics,
      });
      const keys = Object.keys(data);

      // 2a. Per-candidate safe trail. NEVER logs the token, request headers, or
      //     any Binance/backend response body — only derived symbol metadata.
      for (const r of diagnostics.perCandidate) {
        console.log(
          `[PRODUCER] candidate symbol=${r.symbol} base=${r.base} pair=${r.pair} ` +
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
          posted = await postMicrostructure(controlUrl, token, workerId, data);
        } catch (err) {
          console.error(`[PRODUCER][ERROR] post failed: ${err.message}`);
        }
      }

      // 4. Structured summary (counts only).
      console.log(JSON.stringify({
        tag: 'radar-microstructure',
        candidatesReceived: diagnostics.candidatesReceived,
        candidatesSelected: diagnostics.candidatesSelected,
        attempted: diagnostics.attempted,
        measured: diagnostics.measured,
        skippedNoFapiSymbol: diagnostics.skippedNoFapiSymbol,
        failedFetch: diagnostics.failedFetch,
        keys: keys.slice(0, 20),
        posted,
      }));

      if (!keys.length) {
        console.log('[PRODUCER] No microstructure data measured.');
      } else {
        console.log(`[PRODUCER] Posted ${keys.length} metrics ok=${posted}`);
      }
    } catch (err) {
      console.error(`[PRODUCER][ERROR] ${err.message}`);
    }
  }

  if (isLoop) {
    console.log(`[PRODUCER] Running in loop mode every ${cacheMs}ms.`);
    await runCycle();
    setInterval(() => {
      runCycle().catch(err => console.error(err));
    }, cacheMs);
  } else {
    await runCycle();
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
