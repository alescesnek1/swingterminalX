// Scheduled (external-caller) price-history retention pruner. POST only,
// guarded by the same scheduler secret/header as
// price-history-collect-scheduled.mjs (own secret — never
// personal-alerts.mjs's). Ships alongside the collector so unbounded growth
// is never possible even if the owner enables collection first: this
// endpoint exists and is safely disabled by default from the same commit.
//
// Deletes only from market_price_snapshots (see
// _price-history.mjs's pruneSnapshotsOlderThan) in bounded batches — points
// cascade via the existing ON DELETE CASCADE foreign key. Never an
// unbounded DELETE, never touches any other table, never RADAR/trading/
// alert/Telegram.
import { isSchedulerAuthenticated, PRICE_HISTORY_SCHEDULER_HEADER } from './price-history-collect-scheduled.mjs';

async function loadPriceHistory() {
  return await import('./_price-history.mjs');
}

export const PRICE_HISTORY_PRUNE_ENV_FLAG = 'PRICE_HISTORY_PRUNE_ENABLED';
export const PRICE_HISTORY_RETENTION_DAYS_ENV_FLAG = 'PRICE_HISTORY_RETENTION_DAYS';

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

export async function runPriceHistoryPruneScheduled(req, deps = {}) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });

  if (req.method !== 'POST') {
    return json(req, { ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405);
  }

  const env = deps.env || process.env;
  const isAuthed = deps.isSchedulerAuthenticated || isSchedulerAuthenticated;
  if (!isAuthed(req, env)) {
    return json(req, { ok: false, reason: 'SCHEDULER_UNAUTHENTICATED' }, 401);
  }

  if (env[PRICE_HISTORY_PRUNE_ENV_FLAG] !== 'true') {
    return json(req, { ok: true, skipped: true, pruned: false, prunedSnapshots: 0, reason: 'PRUNE_DISABLED' });
  }

  // C3 fix: prune is enabled but retention is unusable. This must be a
  // non-2xx status — returning 200 here let a misconfigured
  // PRICE_HISTORY_RETENTION_DAYS leave the scheduler's GitHub Actions job
  // green while pruning silently never ran, so storage could grow
  // unbounded with no visible failure signal. Deletes nothing either way.
  const daysRaw = env[PRICE_HISTORY_RETENTION_DAYS_ENV_FLAG];
  const days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) {
    return json(req, { ok: false, pruned: false, prunedSnapshots: 0, reason: 'PRUNE_INVALID_RETENTION' }, 400);
  }

  let pruneSnapshotsOlderThan = deps.pruneSnapshotsOlderThan;
  if (!pruneSnapshotsOlderThan) {
    try {
      const mod = await (deps.loadPriceHistory || loadPriceHistory)();
      pruneSnapshotsOlderThan = mod.pruneSnapshotsOlderThan;
    } catch {
      return json(req, { ok: false, pruned: false, prunedSnapshots: 0, reason: 'DB_UNAVAILABLE' }, 503);
    }
  }

  let result;
  try {
    result = await pruneSnapshotsOlderThan({ days });
  } catch (err) {
    console.warn('[PRICE_HISTORY_PRUNE_SCHEDULED] prune_threw', { name: err?.name || 'Error' });
    result = { ok: false, reason: 'PRUNE_FAILED', prunedSnapshots: 0 };
  }

  if (!result || result.ok !== true) {
    const reason = (result && result.reason) || 'PRUNE_FAILED';
    const status = reason === 'DB_UNAVAILABLE' ? 503 : 502;
    console.warn('[PRICE_HISTORY_PRUNE_SCHEDULED] prune_failed', { reason });
    return json(req, {
      ok: false,
      pruned: false,
      prunedSnapshots: (result && result.prunedSnapshots) || 0,
      reason,
    }, status);
  }

  return json(req, {
    ok: true,
    pruned: true,
    prunedSnapshots: result.prunedSnapshots,
    reason: null,
  });
}

export default async function handler(req) {
  return await runPriceHistoryPruneScheduled(req);
}

export const config = {
  path: '/api/price-history-prune-scheduled',
};
