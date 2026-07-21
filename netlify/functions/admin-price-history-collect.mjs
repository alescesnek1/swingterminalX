// Admin-only price-history collector. POST only, disabled by default behind
// PRICE_HISTORY_COLLECT_ENABLED — when the flag is absent/false this never
// fetches market data and never touches the DB. When enabled it fetches the
// same-origin /api/markets rows and forwards them to
// writeMarketSnapshotIfEnabled (_price-history-writer.mjs), which itself
// still requires PRICE_HISTORY_WRITE_ENABLED=true to actually persist.
//
// Auth: same shared Supabase-JWT identity as admin-observability.mjs /
// admin-price-history.mjs (_auth.mjs's getIdentity/isAdmin) — admin access
// always requires a cryptographically VERIFIED token, never decode-only.
//
// No RADAR/ENTRY_READY/trading/alert/Telegram side effects of any kind.
async function loadAuth() {
  return await import('./_auth.mjs');
}

async function loadWriter() {
  return await import('./_price-history-writer.mjs');
}

function headers(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin, Authorization',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  };
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(req) });
}

export const PRICE_HISTORY_COLLECT_ENV_FLAG = 'PRICE_HISTORY_COLLECT_ENABLED';
export const PRICE_HISTORY_COLLECT_SOURCE = 'admin_price_history_collect';
const MAX_ROWS = 2000;

function isCollectEnabled(deps) {
  const env = deps.env || (typeof process !== 'undefined' ? process.env : null);
  return !!env && env[PRICE_HISTORY_COLLECT_ENV_FLAG] === 'true';
}

// Accepts an array response, or { rows|coins|data|markets: [...] }. Never
// throws for an unexpected shape — an unusable payload just yields [].
function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['rows', 'coins', 'data', 'markets']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
}

export async function runAdminPriceHistoryCollect(req, deps = {}) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });

  // Reject non-POST before any auth/fetch/write work.
  if (req.method !== 'POST') {
    return json(req, { ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405);
  }

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
  try {
    identity = await getIdentity(req);
  } catch {
    return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);
  }
  if (!identity || !identity.ok) {
    return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);
  }

  let admin = false;
  try {
    admin = isAdmin(identity);
  } catch {
    return json(req, { ok: false, reason: 'FORBIDDEN' }, 403);
  }
  if (identity.verified !== true || !admin) {
    return json(req, { ok: false, reason: 'FORBIDDEN' }, 403);
  }

  if (!isCollectEnabled(deps)) {
    return json(req, { ok: true, collected: false, skipped: true, reason: 'COLLECT_DISABLED' });
  }

  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  let origin;
  try {
    origin = new URL(req.url).origin;
  } catch {
    return json(req, { ok: false, collected: false, reason: 'INVALID_REQUEST_URL' }, 400);
  }
  const marketsUrl = `${origin}/api/markets`;

  let payload;
  try {
    const res = await fetchImpl(marketsUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn('[ADMIN_PRICE_HISTORY_COLLECT] markets_fetch_failed', { status: res.status });
      return json(req, { ok: false, collected: false, reason: 'MARKET_FETCH_FAILED' }, 502);
    }
    payload = await res.json();
  } catch (err) {
    console.warn('[ADMIN_PRICE_HISTORY_COLLECT] markets_fetch_error', { name: err?.name || 'Error' });
    return json(req, { ok: false, collected: false, reason: 'MARKET_FETCH_FAILED' }, 502);
  }

  const rows = extractRows(payload).slice(0, MAX_ROWS);
  if (!rows.length) {
    return json(req, { ok: false, collected: false, reason: 'NO_MARKET_ROWS' });
  }

  let writer = deps.writeMarketSnapshotIfEnabled;
  if (!writer) {
    try {
      const mod = await (deps.loadWriter || loadWriter)();
      writer = mod.writeMarketSnapshotIfEnabled;
    } catch {
      return json(req, { ok: false, collected: false, reason: 'WRITER_UNAVAILABLE' }, 500);
    }
  }

  let writeResult;
  try {
    writeResult = await writer({ rows, source: PRICE_HISTORY_COLLECT_SOURCE, endpoint: PRICE_HISTORY_COLLECT_SOURCE, status: 'ok' });
  } catch (err) {
    console.warn('[ADMIN_PRICE_HISTORY_COLLECT] writer_threw', { name: err?.name || 'Error' });
    writeResult = { ok: true, skipped: false, written: false, reason: 'WRITE_ERROR' };
  }

  return json(req, {
    ok: true,
    collected: true,
    rowsFetched: rows.length,
    write: {
      skipped: !!(writeResult && writeResult.skipped),
      written: !!(writeResult && writeResult.written),
      reason: (writeResult && writeResult.reason) || null,
    },
  });
}

export default async function handler(req) {
  return await runAdminPriceHistoryCollect(req);
}

export const config = {
  path: '/api/admin-price-history-collect',
};
