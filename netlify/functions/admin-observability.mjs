// Phase 2C: admin-only, read-only observability endpoint. Surfaces recent
// `system_events` / `ingest_runs` rows plus a 24h count summary so the owner
// can see "did something break" without a DB client.
//
// GET only. No POST/DELETE/diagnostic-write path in this phase — see
// docs discussion in the Phase 2C task: a gated diagnostic write was
// explicitly optional, and the safer default (no write path at all) was
// chosen instead of adding a second, rarely-used write gate to maintain.
//
// Auth: same shared Supabase-JWT identity as the rest of the backend
// (`_auth.mjs`). Admin control here follows the same rule as everywhere
// else in this repo (see `_auth.mjs` canControlSession) — admin access
// always requires a cryptographically VERIFIED token, never decode-only.
import { getIdentity, isAdmin } from './_auth.mjs';
import { listRecentSystemEvents, listRecentIngestRuns, countSystemEventsSince } from './_observability.mjs';

function headers(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin, Authorization',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  };
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(req) });
}

const RECENT_LIMIT = 50;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function runAdminObservability(req, deps = {}) {
  const verifyIdentity = deps.getIdentity || getIdentity;
  const checkAdmin = deps.isAdmin || isAdmin;
  const reads = deps.reads || { listRecentSystemEvents, listRecentIngestRuns, countSystemEventsSince };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });

  // Reject non-GET methods before auth or DB work. This endpoint has no write path.
  if (req.method !== 'GET') {
    return json(req, { ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405);
  }

  let identity;
  try {
    identity = await verifyIdentity(req);
  } catch {
    return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);
  }
  if (!identity || !identity.ok) {
    return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);
  }

  let admin = false;
  try {
    admin = checkAdmin(identity);
  } catch {
    return json(req, { ok: false, reason: 'FORBIDDEN' }, 403);
  }
  if (identity.verified !== true || !admin) {
    return json(req, { ok: false, reason: 'FORBIDDEN' }, 403);
  }

  let events;
  let runs;
  let counts;
  try {
    [events, runs, counts] = await Promise.all([
      reads.listRecentSystemEvents({ limit: RECENT_LIMIT }),
      reads.listRecentIngestRuns({ limit: RECENT_LIMIT }),
      reads.countSystemEventsSince({ sinceMs: WINDOW_MS }),
    ]);
  } catch {
    return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503);
  }

  if (!events.ok || !runs.ok || !counts.ok) {
    return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503);
  }

  return json(req, {
    ok: true,
    systemEvents: events.events,
    ingestRuns: runs.runs,
    last24h: { byLevel: counts.byLevel, bySource: counts.bySource },
  });
}

export default async function handler(req) {
  return await runAdminObservability(req);
}

export const config = {
  path: '/api/admin-observability',
};
