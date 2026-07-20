// Admin-only, read-only endpoint for the market price history tables
// (market_price_snapshots / market_price_points — see
// netlify/database/migrations/20260720130902_add-market-price-history).
// Local/owner debug tool for the storage foundation added in this phase.
//
// GET only. No write path here or anywhere else yet — see
// _price-history-writer.mjs for the disabled-by-default write wrapper,
// which is not wired into any endpoint in this phase.
//
// Auth: same shared Supabase-JWT identity as admin-observability.mjs
// (_auth.mjs's getIdentity/isAdmin) — admin access always requires a
// cryptographically VERIFIED token, never decode-only.
async function loadAuth() {
  return await import('./_auth.mjs');
}

async function loadPriceHistory() {
  return await import('./_price-history.mjs');
}

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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function runAdminPriceHistory(req, deps = {}) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });

  // Reject non-GET methods before auth or DB work. This endpoint has no write path.
  if (req.method !== 'GET') {
    return json(req, { ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405);
  }

  let verifyIdentity = deps.getIdentity;
  let checkAdmin = deps.isAdmin;
  if (!verifyIdentity || !checkAdmin) {
    try {
      const auth = await (deps.loadAuth || loadAuth)();
      verifyIdentity ||= auth.getIdentity;
      checkAdmin ||= auth.isAdmin;
    } catch {
      return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);
    }
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

  let reads = deps.reads;
  if (!reads) {
    try {
      reads = await (deps.loadPriceHistory || loadPriceHistory)();
    } catch {
      return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503);
    }
  }

  const url = new URL(req.url);
  const limit = parseLimit(url.searchParams.get('limit'));
  const rawSymbol = url.searchParams.get('symbol');
  const symbol = typeof rawSymbol === 'string' && rawSymbol.trim() ? rawSymbol.trim().toUpperCase() : null;

  let snapshotsRes;
  let pointsRes = { ok: true, points: [] };
  try {
    snapshotsRes = await reads.listRecentSnapshots({ limit });
    if (symbol) {
      pointsRes = await reads.listRecentPricePoints({ symbol, limit });
    }
  } catch {
    return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503);
  }

  if (!snapshotsRes.ok || !pointsRes.ok) {
    return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503);
  }

  return json(req, {
    ok: true,
    symbolFilter: symbol,
    snapshots: snapshotsRes.snapshots,
    points: pointsRes.points,
  });
}

export default async function handler(req) {
  return await runAdminPriceHistory(req);
}

export const config = {
  path: '/api/admin-price-history',
};
