// radar-microstructure-refresh.mjs — production scheduler for the RADAR static
// microstructure overlay, running as a Netlify Scheduled Function.
//
// WHY THIS EXISTS
//   The previous GitHub Actions cron always failed: GitHub-hosted runners are
//   region-blocked by Binance public fapi (HTTP 451), so every measurement was
//   skip=http-451-or-region-block. Netlify's egress can reach Binance fapi, so
//   the scheduled refresh lives here instead. The GitHub workflow is kept only
//   as a manual diagnostic (workflow_dispatch), with no automatic cron.
//
// SAFETY POSTURE (identical to the CLI producer)
//   • READ-ONLY: GET /api/bot/radar-candidates, public Binance fapi
//     depth/premiumIndex, POST /api/bot/radar-microstructure. Nothing else.
//   • Not a trading worker: no local Binance worker, no worker bot session, no
//     live/testnet lifecycle, no order/signed Binance endpoints, no key/secret.
//   • Fail-closed: missing BOT_WORKER_TOKEN returns a clear non-secret error.
//   • Secrets/headers/response bodies are never logged.
//
// It reuses the exact same producer logic via runRadarMicrostructureProducer.

import { runRadarMicrostructureProducer } from '../../scripts/radar/radar-microstructure-producer.mjs';

// Layer the producer config defaults onto the ambient Netlify env without
// mutating process.env. CONTROL_BASE_URL falls back to the deploy URL.
function producerEnv(env) {
  return {
    ...env,
    WORKER_RADAR_MICROSTRUCTURE_ENABLED: env.WORKER_RADAR_MICROSTRUCTURE_ENABLED ?? 'true',
    WORKER_RADAR_MICROSTRUCTURE_TOP_N: env.WORKER_RADAR_MICROSTRUCTURE_TOP_N ?? '5',
    WORKER_RADAR_MICROSTRUCTURE_SCAN_LIMIT: env.WORKER_RADAR_MICROSTRUCTURE_SCAN_LIMIT ?? '50',
    WORKER_RADAR_MICROSTRUCTURE_CACHE_MS: env.WORKER_RADAR_MICROSTRUCTURE_CACHE_MS ?? '10000',
    CONTROL_BASE_URL: env.CONTROL_BASE_URL || env.URL || 'https://swingterminalx.netlify.app',
  };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default async (req) => {
  const token = process.env.BOT_WORKER_TOKEN;

  // Distinguish a Netlify scheduled trigger (POSTs a JSON body with `next_run`)
  // from an external/manual HTTP call. Manual calls MUST present the worker
  // token — we never expose an unauthenticated refresh endpoint.
  let isScheduled = false;
  try {
    if (req && typeof req.text === 'function') {
      const raw = await req.text();
      if (raw) {
        const body = JSON.parse(raw);
        if (body && body.next_run) isScheduled = true;
      }
    }
  } catch { /* not a scheduled JSON body */ }

  if (!isScheduled) {
    const provided = (req && req.headers && typeof req.headers.get === 'function')
      ? req.headers.get('x-bot-worker-token')
      : null;
    if (!token || !provided || provided !== token) {
      return new Response(
        JSON.stringify({ ok: false, error: 'unauthorized: x-bot-worker-token required for manual invocation' }),
        { status: 401, headers: JSON_HEADERS }
      );
    }
  }

  // Fail closed if the server has no token to authenticate its own read-only
  // control-plane calls.
  if (!token) {
    return new Response(
      JSON.stringify({ ok: false, error: 'missing BOT_WORKER_TOKEN (server configuration)' }),
      { status: 500, headers: JSON_HEADERS }
    );
  }

  const result = await runRadarMicrostructureProducer({
    env: producerEnv(process.env),
    fetchFn: globalThis.fetch,
    logger: console,
  });

  // 200 even when nothing measured; only a missing-config failure is non-200.
  const status = (result.reason === 'missing-token' || result.reason === 'missing-base-url') ? 500 : 200;
  return new Response(
    JSON.stringify({ ok: result.ok, reason: result.reason, posted: result.posted, ...result.summary }),
    { status, headers: JSON_HEADERS }
  );
};

// Production cron: every 10 minutes (static UTC). Netlify egress reaches Binance
// public fapi, unlike GitHub-hosted runners.
export const config = {
  schedule: '*/10 * * * *',
};
