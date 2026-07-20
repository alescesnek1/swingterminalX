// Best-effort, feature-flagged wrapper around writeMarketPriceSnapshot
// (see _price-history.mjs). Disabled by default — writes only happen when
// PRICE_HISTORY_WRITE_ENABLED=true is set in the function's environment.
//
// NOT WIRED YET: no market-data endpoint calls this in this phase. The
// only endpoint that already assembles the full market-row universe
// (/api/markets, apps/edge/netlify/edge-functions/markets.js) runs in the
// Deno edge runtime, which is a different runtime than the Node-based
// Netlify Functions this repo's Postgres client (_db.mjs, @netlify/
// database) targets — wiring a DB write into that file is a separate,
// larger change (either a Deno-compatible Postgres path, or a new Node
// function that receives forwarded rows) and is intentionally out of
// scope here. This file exists so that future wiring point is a one-line
// call, already tested, already safe-by-default.
//
// SAFETY MODEL
//   - Never throws. Every path resolves to a stable object; a caller never
//     needs try/catch around this function.
//   - Disabled (default, no env flag or flag != 'true'):
//     { ok:true, skipped:true, reason:'DISABLED' } — the DB is never
//     touched, writeMarketPriceSnapshot is never even loaded.
//   - Enabled but the underlying write fails (DB unavailable, thrown
//     error, or writeMarketPriceSnapshot returning ok:false):
//     { ok:true, skipped:false, written:false, reason } — still never
//     throws. `ok:true` here means "the wrapper itself ran fine," not
//     "data was persisted" — callers check `written` for that, so a
//     caller can safely ignore the return value entirely and still be
//     correct.
//   - metadata sent to writeMarketPriceSnapshot is a tiny, fixed shape
//     (row count, endpoint, data status) — never the raw market rows,
//     never auth headers, cookies, tokens, or user/chat IDs.
//   - No query at import time. No env var is read until the function is
//     actually called.
//   - No trading, RADAR, reclaim/absorption, alert, or Telegram side
//     effects of any kind live in this file.

export const PRICE_HISTORY_WRITE_ENV_FLAG = 'PRICE_HISTORY_WRITE_ENABLED';
export const DEFAULT_PRICE_HISTORY_SOURCE = 'cockpit_market_universe';

async function loadPriceHistory() {
  return await import('./_price-history.mjs');
}

function isWriteEnabled(deps) {
  const env = deps.env || (typeof process !== 'undefined' ? process.env : null);
  return !!env && env[PRICE_HISTORY_WRITE_ENV_FLAG] === 'true';
}

function logFailure(err) {
  // Never log err.message — see _price-history.mjs's identical rule; pg
  // connection errors can embed host/port details.
  console.warn('[PRICE_HISTORY_WRITER] write failed', { name: err?.name || 'Error', code: err?.code || null });
}

/**
 * Best-effort, feature-flagged write of one market-data batch to Postgres.
 * See the module header for the full safety/return-shape contract. Accepts
 * { rows, source, sampledAt, status, endpoint } — `rows` should be the
 * already-assembled market rows a caller is about to (or just did) return
 * to its own client, `source` defaults to DEFAULT_PRICE_HISTORY_SOURCE,
 * `endpoint`/`status` are folded into a small metadata object only.
 */
export async function writeMarketSnapshotIfEnabled(input, deps = {}) {
  if (!isWriteEnabled(deps)) {
    return { ok: true, skipped: true, reason: 'DISABLED' };
  }

  const { rows, source, sampledAt, status, endpoint } = input && typeof input === 'object' ? input : {};
  const sourceTag = typeof source === 'string' && source.trim() ? source.trim() : DEFAULT_PRICE_HISTORY_SOURCE;
  const safeRows = Array.isArray(rows) ? rows : [];
  const metadata = {
    rowCount: safeRows.length,
    endpoint: typeof endpoint === 'string' ? endpoint.slice(0, 100) : null,
    dataStatus: typeof status === 'string' ? status.slice(0, 50) : 'ok',
  };

  let writeImpl = deps.writeMarketPriceSnapshot;
  if (!writeImpl) {
    try {
      const mod = await (deps.loadPriceHistory || loadPriceHistory)();
      writeImpl = mod.writeMarketPriceSnapshot;
    } catch (err) {
      logFailure(err);
      return { ok: true, skipped: false, written: false, reason: 'MODULE_LOAD_FAILED' };
    }
  }

  try {
    const res = await writeImpl({ source: sourceTag, sampledAt, rows: safeRows, metadata });
    if (!res || res.ok !== true) {
      const reason = (res && res.reason) || 'WRITE_FAILED';
      // Observability rule (AGENTS.md): an enabled-but-failed write must be
      // visible in logs, never silent. Stable codes + counts only — no raw
      // error message, no rows, no caller-provided values.
      console.warn('[PRICE_HISTORY_WRITER] price_history_write_failed', {
        reason,
        source: sourceTag,
        rows: safeRows.length,
      });
      return { ok: true, skipped: false, written: false, reason };
    }
    return {
      ok: true,
      skipped: false,
      written: true,
      snapshotId: res.snapshotId,
      inserted: res.inserted,
      dropped: res.dropped,
      duplicates: res.duplicates,
    };
  } catch (err) {
    logFailure(err);
    return { ok: true, skipped: false, written: false, reason: 'WRITE_ERROR' };
  }
}
