import { runMarketContextCollector } from './_market-context-collector.mjs';
import { runRadarContextPublisher } from './_radar-context-publisher.mjs';

function response(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Netlify invokes this on its own schedule. No `path` is configured, no public
// POST writer exists, and the default collector flag makes every invocation a
// no-op without database/network access. After a market run is published, the
// RADAR publisher (also flag-gated, default no-op) computes and persists the
// derived RADAR result for that run. RADAR failure never fails the market cycle:
// the market data still publishes and RADAR simply stays PENDING for that run.
export default async function handler() {
  const market = await runMarketContextCollector();
  let radar = null;
  if (market?.body?.ok && market.body.skipped !== true) {
    try { radar = (await runRadarContextPublisher()).body; }
    catch (error) { console.warn('[RADAR_PUBLISH] publisher_threw', { name: error?.name || 'Error' }); radar = { ok: false, reason: 'RADAR_PUBLISH_FAILED' }; }
  }
  return response({ ...market.body, radar }, market.status);
}

export const config = { schedule: '*/3 * * * *' };
