// radar-microstructure-refresh.mjs — MANUAL, NON-PRODUCTION DIAGNOSTIC ONLY for
// the RADAR static microstructure overlay. There is intentionally NO scheduled
// cron here, and there is NO production scheduler at all.
//
// WHY THERE IS NO SCHEDULER
//   Static microstructure is a provider-backed OPTIONAL overlay, not an automatic
//   Binance scraping cron. The production default is MARKET_DATA_PROVIDER=none →
//   the producer makes ZERO external fetches and the UI shows "provider
//   unavailable" (fail-closed). Binance public fapi is reachable only from an
//   operator's local PC; GitHub-hosted runners AND Netlify serverless egress are
//   both region-blocked (HTTP 451), so neither can run an automatic schedule.
//
//   This function is kept only as an on-demand, token-protected diagnostic. Even
//   when invoked, it does nothing unless the ambient Netlify env explicitly sets
//   MARKET_DATA_PROVIDER=binance-public (NOT recommended in production); with the
//   default provider it returns a clean provider-unavailable result.
//
// SAFETY POSTURE (identical to the CLI producer)
//   • Provider-gated: only MARKET_DATA_PROVIDER=binance-public performs any fetch.
//   • READ-ONLY (binance-public mode): GET /api/bot/radar-candidates, public
//     Binance fapi depth/premiumIndex, POST /api/bot/radar-microstructure.
//   • Not a trading worker: no local Binance worker, no worker bot session, no
//     live/testnet lifecycle, no order/signed Binance endpoints, no key/secret.
//   • Fail-closed: missing BOT_WORKER_TOKEN returns a clear non-secret error.
//   • Secrets/headers/response bodies are never logged.
//
// It reuses the exact same producer logic via runRadarMicrostructureProducer.

import { runRadarMicrostructureProducer } from '../../scripts/radar/radar-microstructure-producer.mjs';

// Layer the producer config defaults onto the ambient Netlify env without
// mutating process.env. CONTROL_BASE_URL falls back to the deploy URL.
//
// IMPORTANT: MARKET_DATA_PROVIDER is intentionally NOT defaulted here — it passes
// through from the ambient env (default "none"), so this function never performs
// an external Binance fetch unless the operator explicitly sets
// MARKET_DATA_PROVIDER=binance-public on the site (fail-closed by default).
function producerEnv(env) {
  return {
    ...env,
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
    JSON.stringify({
      ok: result.ok,
      reason: result.reason,
      provider: result.provider,
      providerStatus: result.providerStatus,
      posted: result.posted,
      ...result.summary,
    }),
    { status, headers: JSON_HEADERS }
  );
};

// NO scheduled cron — and no production scheduler exists anywhere. Static
// microstructure is a provider-backed optional overlay (default
// MARKET_DATA_PROVIDER=none → fail-closed, zero external fetch). Netlify
// serverless egress is region-blocked by Binance public fapi (HTTP 451) anyway,
// so an automatic schedule here would always measure zero. This function stays
// manual-only (token-protected) and non-production, for diagnostics only.
