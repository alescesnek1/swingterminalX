// Admin-only, read-only debug endpoint for price-history analytics. The pure
// helpers never write, alert, score decision gates, or affect trading/ENTRY_READY.
//
// `/api/orderbook` is an authenticated Deno Edge Function. There is no safe
// Node reuse in this phase, so normal calls report NOT_WIRED_THIS_PHASE rather
// than making a duplicate upstream request. `deps.orderbook` is test-only.
import {
  analyzeAbsorptionFromPointsAndOrderbook,
  analyzeReclaimFromPoints,
} from './_price-history-signals.mjs';

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 200;

async function loadAuth() { return await import('./_auth.mjs'); }
async function loadPriceHistory() { return await import('./_price-history.mjs'); }

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

function boundedInt(raw, fallback, min, max) {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

function parseSymbol(raw) {
  const symbol = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return /^[A-Z0-9]{1,30}$/.test(symbol) ? symbol : null;
}

export async function runAdminPriceHistorySignals(req, deps = {}) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });
  if (req.method !== 'GET') return json(req, { ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405);

  let getIdentity = deps.getIdentity;
  let isAdmin = deps.isAdmin;
  if (!getIdentity || !isAdmin) {
    try {
      const auth = await (deps.loadAuth || loadAuth)();
      getIdentity ||= auth.getIdentity;
      isAdmin ||= auth.isAdmin;
    } catch {
      return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);
    }
  }

  let identity;
  try { identity = await getIdentity(req); } catch { return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401); }
  if (!identity?.ok) return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);
  let admin = false;
  try { admin = isAdmin(identity); } catch { return json(req, { ok: false, reason: 'FORBIDDEN' }, 403); }
  if (identity.verified !== true || !admin) return json(req, { ok: false, reason: 'FORBIDDEN' }, 403);

  const url = new URL(req.url);
  const symbol = parseSymbol(url.searchParams.get('symbol'));
  if (!symbol) return json(req, { ok: false, reason: 'MISSING_OR_INVALID_SYMBOL' }, 400);
  const limit = boundedInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 8, MAX_LIMIT);
  const lookback = boundedInt(url.searchParams.get('lookback'), 20, 5, 200);
  const confirmations = boundedInt(url.searchParams.get('confirmations'), 2, 1, 10);

  let reads = deps.reads;
  if (!reads) {
    try { reads = await (deps.loadPriceHistory || loadPriceHistory)(); } catch { return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503); }
  }
  let history;
  try { history = await reads.listRecentPricePoints({ symbol, limit }); } catch { return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503); }
  if (!history?.ok || !Array.isArray(history.points)) return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503);

  const options = { lookback, confirmations };
  const reclaim = analyzeReclaimFromPoints({ symbol, points: history.points, options });
  const absorption = analyzeAbsorptionFromPointsAndOrderbook({ symbol, points: history.points, orderbook: deps.orderbook, options });
  return json(req, {
    ok: true,
    symbol,
    points: history.points.length,
    orderbookUsed: absorption.orderbookUsed,
    orderbookReason: absorption.orderbookUsed && deps.orderbook !== undefined ? 'INJECTED_TEST_ORDERBOOK' : 'NOT_WIRED_THIS_PHASE',
    reclaim,
    absorption,
  });
}

export default async function handler(req) { return await runAdminPriceHistorySignals(req); }

export const config = { path: '/api/admin-price-history-signals' };
