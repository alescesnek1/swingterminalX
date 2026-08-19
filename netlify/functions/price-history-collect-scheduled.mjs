// Scheduled (external-caller) price-history collector. POST only, guarded
// by its own scheduler secret — never Netlify's native scheduled-function
// trigger (see the header note below) and never the admin JWT auth used by
// admin-price-history-collect.mjs.
//
// WHY A SEPARATE COLLECTOR: admin-price-history-collect.mjs forwards the
// caller's Supabase Authorization header to /api/markets, which requires a
// cryptographically verified user JWT (apps/edge/netlify/edge-functions/lib/
// security.js verifyAuth) — an unattended scheduler has no user session and
// can never present one without storing a live user credential or a
// service-role key, both unacceptable. This function instead fetches
// CoinGecko's public /coins/markets pages directly
// (_coingecko-markets-source.mjs) — the same public upstream /api/markets
// itself calls, no auth, no key — then writes through the same
// writeMarketPriceSnapshot storage path (_price-history.mjs) used
// everywhere else in this phase.
//
// SCHEDULER AUTH: same timing-safe-compare pattern as
// personal-alerts.mjs's isSchedulerAuthenticated, but with its OWN header
// (x-price-history-scheduler-secret) and OWN env var
// (PRICE_HISTORY_SCHEDULER_SECRET) — never personal-alerts' scheduler
// secret. A request body field (including any Netlify-style `next_run`) is
// NEVER trusted as authentication.
//
// FLAG GATES, IN ORDER (each gate short-circuits before the next touches
// anything): scheduler auth -> PRICE_HISTORY_SCHEDULE_ENABLED ->
// PRICE_HISTORY_COLLECT_ENABLED -> min-spacing guard (DB read only) ->
// CoinGecko fetch -> PRICE_HISTORY_WRITE_ENABLED -> DB write. The first two
// disabled-flag checks touch neither the DB nor the network.
//
// OBSERVABILITY: unlike the interactive admin collector (which returns 200
// even when a write was attempted and failed, because a human is reading
// the JSON), THIS endpoint returns a non-2xx status whenever a write was
// attempted and did not succeed — an unattended GitHub Actions job must go
// red on a dead DB, never stay green forever. See AGENTS.md /
// docs/price-history-scheduler.md.
//
// No RADAR/ENTRY_READY/trading/alert/Telegram side effects of any kind.
import { timingSafeEqual } from 'node:crypto';
import {
  costGuardHeaders,
  noteCostBreakerBlock,
  priceHistoryCollectAllowed,
  priceHistoryScheduleAllowed,
  priceHistoryWritesAllowed,
  REASON_PRICE_HISTORY_DISABLED,
} from './_cost-breaker.mjs';

async function loadPriceHistory() {
  return await import('./_price-history.mjs');
}

async function loadCoingeckoSource() {
  return await import('./_coingecko-markets-source.mjs');
}

export const PRICE_HISTORY_SCHEDULER_HEADER = 'x-price-history-scheduler-secret';
export const PRICE_HISTORY_SCHEDULE_ENV_FLAG = 'PRICE_HISTORY_SCHEDULE_ENABLED';
export const PRICE_HISTORY_COLLECT_ENV_FLAG = 'PRICE_HISTORY_COLLECT_ENABLED';
export const PRICE_HISTORY_WRITE_ENV_FLAG = 'PRICE_HISTORY_WRITE_ENABLED';
export const PRICE_HISTORY_SOURCE = 'scheduled_price_history';
export const PRICE_HISTORY_ENDPOINT = 'price_history_collect_scheduled';

const DEFAULT_MIN_SPACING_SEC = 540; // 9 minutes — safely under a 15-minute cadence
const MAX_MIN_SPACING_SEC = 86400; // 1 day sanity ceiling, defensive only
const DEFAULT_MAX_COINS = 1000;

function headers(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, ' + PRICE_HISTORY_SCHEDULER_HEADER,
  };
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(req) });
}

// A breaker-disabled answer: normal 200 so the unattended GitHub Actions job
// stays green and does not retry-storm, plus the X-Cost-Guard / X-DB-Read-Guard
// headers so the reason is visible from curl without parsing the body.
function disabled(req, body) {
  noteCostBreakerBlock('price_history_collect_scheduled', REASON_PRICE_HISTORY_DISABLED);
  return new Response(JSON.stringify({ ...body, costGuard: REASON_PRICE_HISTORY_DISABLED }), {
    status: 200,
    headers: costGuardHeaders(REASON_PRICE_HISTORY_DISABLED, headers(req)),
  });
}

/**
 * Timing-safe comparison of the caller's scheduler-secret header against
 * PRICE_HISTORY_SCHEDULER_SECRET. Missing/empty on either side fails closed.
 * Mirrors personal-alerts.mjs's isSchedulerAuthenticated but with this
 * function's own header/env var — the two secrets are never interchangeable.
 */
export function isSchedulerAuthenticated(req, env = process.env) {
  const expected = String(env.PRICE_HISTORY_SCHEDULER_SECRET || '').trim();
  const provided = req && req.headers && typeof req.headers.get === 'function'
    ? String(req.headers.get(PRICE_HISTORY_SCHEDULER_HEADER) || '').trim()
    : '';
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  return expectedBytes.length === providedBytes.length
    && timingSafeEqual(expectedBytes, providedBytes);
}

function parseMinSpacingSec(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MIN_SPACING_SEC;
  return Math.min(Math.trunc(n), MAX_MIN_SPACING_SEC);
}

function parseMaxCoins(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_COINS;
  return Math.trunc(n); // fetchCoinGeckoMarketRows itself clamps to ABSOLUTE_MAX_COINS
}

function toEpochMs(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export async function runPriceHistoryCollectScheduled(req, deps = {}) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });

  // Reject non-POST before auth or any other work — the external scheduler
  // always POSTs, so a GET/PUT/etc. never reaches the secret comparison.
  if (req.method !== 'POST') {
    return json(req, { ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405);
  }

  const env = deps.env || process.env;
  const isAuthed = deps.isSchedulerAuthenticated || isSchedulerAuthenticated;
  if (!isAuthed(req, env)) {
    return json(req, { ok: false, reason: 'SCHEDULER_UNAUTHENTICATED' }, 401);
  }

  // Cost breaker. Both gates return BEFORE the price-history module is even
  // imported, so a disabled run opens no Postgres connection and makes no
  // CoinGecko call. Routed through the breaker so DB_READS_ENABLED=false
  // switches them off as well.
  if (!priceHistoryScheduleAllowed(env)) {
    return disabled(req, { ok: true, skipped: true, collected: false, reason: 'SCHEDULE_DISABLED' });
  }
  if (!priceHistoryCollectAllowed(env)) {
    return disabled(req, { ok: true, skipped: true, collected: false, reason: 'COLLECT_DISABLED' });
  }

  let getLatestSnapshotAt = deps.getLatestSnapshotAt;
  let writeMarketPriceSnapshot = deps.writeMarketPriceSnapshot;
  if (!getLatestSnapshotAt || !writeMarketPriceSnapshot) {
    try {
      const mod = await (deps.loadPriceHistory || loadPriceHistory)();
      getLatestSnapshotAt ||= mod.getLatestSnapshotAt;
      writeMarketPriceSnapshot ||= mod.writeMarketPriceSnapshot;
    } catch {
      return json(req, { ok: false, collected: false, reason: 'DB_UNAVAILABLE' }, 503);
    }
  }

  const now = typeof deps.now === 'function' ? deps.now() : Date.now();

  let latest;
  try {
    latest = await getLatestSnapshotAt({ source: PRICE_HISTORY_SOURCE });
  } catch {
    return json(req, { ok: false, collected: false, reason: 'DB_UNAVAILABLE' }, 503);
  }
  if (!latest || latest.ok !== true) {
    return json(req, { ok: false, collected: false, reason: 'DB_UNAVAILABLE' }, 503);
  }

  const minSpacingSec = parseMinSpacingSec(env.PRICE_HISTORY_MIN_SPACING_SEC);
  const lastSampledMs = toEpochMs(latest.sampledAt);
  if (lastSampledMs !== null) {
    const ageSec = (now - lastSampledMs) / 1000;
    if (ageSec < minSpacingSec) {
      return json(req, { ok: true, skipped: true, collected: false, reason: 'MIN_SPACING' });
    }
  }

  let fetchCoinGeckoMarketRows = deps.fetchCoinGeckoMarketRows;
  if (!fetchCoinGeckoMarketRows) {
    try {
      const mod = await (deps.loadCoingeckoSource || loadCoingeckoSource)();
      fetchCoinGeckoMarketRows = mod.fetchCoinGeckoMarketRows;
    } catch {
      return json(req, { ok: false, collected: false, reason: 'MARKET_FETCH_FAILED' }, 502);
    }
  }

  const maxCoins = parseMaxCoins(env.PRICE_HISTORY_MAX_COINS);
  let marketResult;
  try {
    marketResult = await fetchCoinGeckoMarketRows({ maxCoins, fetchImpl: deps.marketFetchImpl });
  } catch {
    marketResult = { ok: false, reason: 'MARKET_FETCH_FAILED' };
  }

  if (!marketResult || marketResult.ok !== true) {
    const reason = (marketResult && marketResult.reason) || 'MARKET_FETCH_FAILED';
    const status = reason === 'UPSTREAM_RATE_LIMITED' ? 429 : 502;
    return json(req, { ok: false, collected: false, reason }, status);
  }

  const rows = Array.isArray(marketResult.rows) ? marketResult.rows : [];
  const pagesOk = marketResult.pagesOk ?? null;
  const pagesAttempted = marketResult.pagesAttempted ?? null;
  const dataStatus = marketResult.status === 'partial' ? 'partial' : 'ok';

  // Defense in depth: refuse to write an empty snapshot even if
  // fetchCoinGeckoMarketRows ever mis-reports ok:true with zero rows. A
  // zero-row snapshot would satisfy the min-spacing guard on the next run
  // and silently suppress the next real collection — mirrors the manual
  // admin collector's NO_MARKET_ROWS guard. Non-2xx (not the admin
  // collector's 200) so the scheduler job goes red instead of staying
  // green on a collection that produced nothing.
  if (rows.length === 0) {
    return json(req, { ok: false, collected: false, reason: 'NO_MARKET_ROWS' }, 502);
  }

  const writeEnabled = priceHistoryWritesAllowed(env);
  if (!writeEnabled) {
    return json(req, {
      ok: true,
      collected: true,
      rowsFetched: rows.length,
      pagesOk,
      pagesAttempted,
      dataStatus,
      write: { skipped: true, written: false, reason: 'DISABLED' },
    });
  }

  const storeRawMeta = env.PRICE_HISTORY_STORE_RAW_META === 'true';

  let writeResult;
  try {
    writeResult = await writeMarketPriceSnapshot({
      source: PRICE_HISTORY_SOURCE,
      sampledAt: new Date(now),
      rows,
      status: dataStatus,
      storeRawMeta,
      metadata: {
        rowCount: rows.length,
        endpoint: PRICE_HISTORY_ENDPOINT,
        dataStatus,
        pagesOk,
        pagesAttempted,
      },
    });
  } catch (err) {
    console.warn('[PRICE_HISTORY_COLLECT_SCHEDULED] write_threw', { name: err?.name || 'Error' });
    writeResult = { ok: false, reason: 'WRITE_ERROR' };
  }

  if (!writeResult || writeResult.ok !== true) {
    const reason = (writeResult && writeResult.reason) || 'WRITE_FAILED';
    const status = reason === 'DB_UNAVAILABLE' ? 503 : 502;
    console.warn('[PRICE_HISTORY_COLLECT_SCHEDULED] write_failed', { reason });
    return json(req, {
      ok: false,
      collected: true,
      rowsFetched: rows.length,
      pagesOk,
      pagesAttempted,
      dataStatus,
      write: { skipped: false, written: false, reason },
    }, status);
  }

  return json(req, {
    ok: true,
    collected: true,
    rowsFetched: rows.length,
    pagesOk,
    pagesAttempted,
    dataStatus,
    write: {
      skipped: false,
      written: true,
      reason: null,
      snapshotId: writeResult.snapshotId,
      inserted: writeResult.inserted,
      dropped: writeResult.dropped,
      duplicates: writeResult.duplicates,
    },
  });
}

export default async function handler(req) {
  return await runPriceHistoryCollectScheduled(req);
}

export const config = {
  path: '/api/price-history-collect-scheduled',
};
