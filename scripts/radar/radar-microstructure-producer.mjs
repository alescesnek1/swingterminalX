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
      // 1. Fetch candidates
      let candidates = [];
      try {
        candidates = await fetchRadarCandidates(controlUrl, token);
      } catch (err) {
        throw new Error(`radar-candidates fetch failed: ${err.message}`);
      }
      
      if (!candidates.length) {
        console.log('[PRODUCER] No candidates received.');
        return;
      }

      // 2. Enrich
      const data = await enrichRadarCandidatesMicrostructure(candidates, {
        config,
        env: process.env,
        cache,
        now: Date.now,
      });

      const keys = Object.keys(data);
      if (keys.length === 0) {
        console.log('[PRODUCER] No microstructure data measured.');
        return;
      }

      // 3. Post
      const ok = await postMicrostructure(controlUrl, token, workerId, data);
      console.log(`[PRODUCER] Posted ${keys.length} metrics ok=${ok}`);
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
