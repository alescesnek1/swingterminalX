// Background collector. Same work as the scheduled path, but Netlify gives a
// background function ~15 minutes instead of the scheduled 30s ceiling.
//
// Why it exists: measuring the whole USD-stable universe costs 3 public GETs per
// symbol (~1500 calls for ~500 symbols). That cannot fit in 30s no matter how the
// work is ordered, and without it only a handful of symbols ever carry the
// order-book and flow evidence EXECUTION_SCORE needs — so no coin outside that
// handful could ever reach ENTRY_READY.
//
// This endpoint is HTTP-reachable, so it is closed by default: every call must
// present the worker token, compared in constant time. The token is never logged.
import { timingSafeEqual } from 'node:crypto';
import { runMarketContextCollector } from './_market-context-collector.mjs';
import { runRadarContextPublisher } from './_radar-context-publisher.mjs';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req) {
  const expected = process.env.BOT_WORKER_TOKEN;
  if (!expected) {
    console.warn('[MARKET_CONTEXT_BG] missing_worker_token');
    return new Response(JSON.stringify({ ok: false, error: 'missing BOT_WORKER_TOKEN (server configuration)' }), { status: 500, headers: JSON_HEADERS });
  }
  const provided = req?.headers?.get ? req.headers.get('x-bot-worker-token') : null;
  if (!tokenMatches(provided, expected)) {
    console.warn('[MARKET_CONTEXT_BG] unauthorized_invocation');
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized: x-bot-worker-token required' }), { status: 401, headers: JSON_HEADERS });
  }

  const startedMs = Date.now();
  const market = await runMarketContextCollector();
  let radar = null;
  if (market?.body?.ok && market.body.skipped !== true) {
    try { radar = (await runRadarContextPublisher()).body; }
    catch (error) { console.warn('[RADAR_PUBLISH] publisher_threw', { name: error?.name || 'Error' }); radar = { ok: false, reason: 'RADAR_PUBLISH_FAILED' }; }
  }
  console.info('[MARKET_CONTEXT_BG] cycle_finished', { durationMs: Date.now() - startedMs, skipped: market?.body?.skipped === true, measurementCount: market?.body?.measurementCount ?? null, radarOk: radar?.ok ?? null });
  return new Response(JSON.stringify({ ...market.body, radar }), { status: market.status, headers: JSON_HEADERS });
}
