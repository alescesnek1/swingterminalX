import { runMarketContextCollector } from './_market-context-collector.mjs';
import { runRadarContextPublisher } from './_radar-context-publisher.mjs';

export const MARKET_CONTEXT_BACKGROUND_ENV_FLAG = 'MARKET_CONTEXT_BACKGROUND_ENABLED';

function response(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Hands the cycle to the background collector, which gets ~15 minutes instead of
// this function's 30s ceiling. Netlify answers a background invocation with 202
// and runs it detached, so this returns as soon as the work is accepted — the
// outcome shows up in the background function's own logs, not here.
export async function dispatchBackgroundCollection(env = process.env, fetchImpl = fetch) {
  const base = env.CONTROL_BASE_URL;
  const token = env.BOT_WORKER_TOKEN;
  if (!base || !token) { console.warn('[MARKET_CONTEXT] background_dispatch_misconfigured', { hasBaseUrl: !!base, hasToken: !!token }); return { ok: false, reason: 'BACKGROUND_DISPATCH_MISCONFIGURED' }; }
  let url;
  try { url = new URL('/.netlify/functions/market-context-collect-background', base).toString(); }
  catch { console.warn('[MARKET_CONTEXT] background_dispatch_bad_base_url'); return { ok: false, reason: 'BACKGROUND_DISPATCH_MISCONFIGURED' }; }
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'x-bot-worker-token': token, 'Content-Type': 'application/json' }, body: '{}' });
    // 202 is the only success: anything else means the cycle never started, which
    // must be visible rather than looking like a healthy dispatch.
    if (res.status !== 202) { console.warn('[MARKET_CONTEXT] background_dispatch_rejected', { status: res.status }); return { ok: false, reason: 'BACKGROUND_DISPATCH_REJECTED', status: res.status }; }
    return { ok: true, status: res.status };
  } catch (error) { console.warn('[MARKET_CONTEXT] background_dispatch_failed', { name: error?.name || 'Error' }); return { ok: false, reason: 'BACKGROUND_DISPATCH_FAILED' }; }
}

// Netlify invokes this on its own schedule. No `path` is configured, no public
// POST writer exists, and the default collector flag makes every invocation a
// no-op without database/network access. After a market run is published, the
// RADAR publisher (also flag-gated, default no-op) computes and persists the
// derived RADAR result for that run. RADAR failure never fails the market cycle:
// the market data still publishes and RADAR simply stays PENDING for that run.
export default async function handler() {
  if (process.env[MARKET_CONTEXT_BACKGROUND_ENV_FLAG] === 'true') {
    const dispatched = await dispatchBackgroundCollection();
    return response({ endpoint: 'market_context_collect_scheduled', ok: dispatched.ok, dispatchedToBackground: true, reason: dispatched.reason ?? null }, dispatched.ok ? 202 : 503);
  }
  const market = await runMarketContextCollector();
  let radar = null;
  if (market?.body?.ok && market.body.skipped !== true) {
    try { radar = (await runRadarContextPublisher()).body; }
    catch (error) { console.warn('[RADAR_PUBLISH] publisher_threw', { name: error?.name || 'Error' }); radar = { ok: false, reason: 'RADAR_PUBLISH_FAILED' }; }
  }
  return response({ ...market.body, radar }, market.status);
}

export const config = { schedule: '*/3 * * * *' };
