// morning-briefing.mjs — daily Telegram Morning Market Briefing (scheduled).
//
// This is an INFORMATIONAL once-per-day briefing, NOT a trade signal and NOT a
// RADAR ENTRY_READY alert. It runs on its own env gate
// (MORNING_BRIEFING_TELEGRAM_ENABLED) and its own Telegram sender, fully
// independent of cron-alerts.mjs / the RADAR alert path.
//
// SCHEDULING / DST:
//   Netlify scheduled functions use a STATIC UTC cron and cannot follow
//   Europe/Prague DST on their own. So the cron runs HOURLY across the morning
//   window (05:00-09:00 UTC, which brackets 08:00 Prague in both CET=UTC+1 and
//   CEST=UTC+2) and the function itself fires only when the *local* hour in
//   MORNING_BRIEFING_TIMEZONE equals MORNING_BRIEFING_HOUR_LOCAL. Combined with
//   once-per-local-day dedup, this delivers exactly one briefing at the
//   configured local hour regardless of DST.
//
// MANUAL TESTING:
//   GET /.netlify/functions/morning-briefing?dryRun=1  -> JSON preview, no send.
//   GET ...?force=1  -> bypass window+dedup and send, ONLY when
//     MORNING_BRIEFING_ALLOW_FORCE=true AND the caller is an authenticated
//     admin. Manual invocations require an admin bearer token.

import { loadFleet, mutateFleet } from './_fleet-store.mjs';
import { getIdentity, isAdmin } from './_auth.mjs';
import { runMorningBriefing, escapeHtml } from '../../scripts/briefing/morning-briefing.mjs';
import { summarizeBriefing } from '../../scripts/briefing/gemini-node.mjs';

// PRIVATE: the only Telegram HTTP call in this file. Separate from the RADAR
// sender in cron-alerts.mjs by design — this path has its own env gate.
async function sendTelegram(token, chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Never surface a raw token/url; Telegram errors don't carry our token but
      // we still cap length defensively.
      return { ok: false, error: (detail || `${res.status} ${res.statusText}`).slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err).slice(0, 200) };
  }
}

function summarize(context) {
  return summarizeBriefing(context, { env: process.env, fetchImpl: globalThis.fetch });
}

// Canonical market context read — the SAME source of truth the RADAR alert path
// reads (see cron-alerts.mjs / RADAR_ALERTS_CANONICAL_SOURCE), produced by the
// server-side collector every ~3 minutes.
//
// WHY: the briefing used to describe `fleet.autoMarketSnapshot` /
// `fleet.tradingRadar`, which are written by a LOCAL worker and an open browser
// tab. At 08:00 neither is normally running, so the briefing rendered whatever
// was frozen in the blob — on 2026-08-01 it reported BTC +0.6% from a
// 2026-07-30 13:40 state while BTC was actually -1.8% on the day. Reading the
// collector's own database makes the numbers current; the freshness stamp that
// travels with it makes any remaining gap visible instead of silent.
//
// READ-ONLY: no write, no gate, no order path. Never throws — a failure returns
// { ok:false, reason } and the briefing degrades to a labelled fallback.
async function loadMarketContext() {
  let store; let database;
  try {
    store = await import('./_market-context-store.mjs');
    database = (await import('./_db.mjs')).getDb().pool;
  } catch (err) {
    console.warn('[morning-briefing] canonical_context_unavailable', { reason: 'DB_INIT_FAILED', name: err?.name || 'Error' });
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
  try {
    // microLimit is deliberately minimal: the briefing needs tickers + RADAR
    // verdicts, never the raw microstructure measurement rows.
    const context = await store.getAtomizedMarketContext(database, { tickerLimit: 1000, microLimit: 1 });
    if (!context || context.ok !== true) {
      console.warn('[morning-briefing] canonical_context_read_failed', { reason: context?.reason || 'UNKNOWN' });
      return { ok: false, reason: context?.reason || 'DB_UNAVAILABLE' };
    }
    return context;
  } catch (err) {
    console.warn('[morning-briefing] canonical_context_read_threw', { name: err?.name || 'Error' });
    return { ok: false, reason: 'DB_UNAVAILABLE' };
  }
}

// Public diagnostics — strips the message preview unless explicitly requested,
// and never includes secrets.
function publicDiag(diag, { includePreview = false } = {}) {
  const { preview, ...rest } = diag;
  return includePreview ? { ...rest, preview } : rest;
}

export default async (req) => {
  // Parse manual-test query params if this is an HTTP invocation.
  let query = null;
  try {
    if (req && typeof req.url === 'string') query = new URL(req.url).searchParams;
  } catch { /* scheduled trigger without a parseable url */ }

  const wantsDryRun = !!(query && (query.get('dryRun') === '1' || query.get('dryRun') === 'true'));
  const wantsForce = !!(query && (query.get('force') === '1' || query.get('force') === 'true'));
  const isManual = !!(query && (query.has('dryRun') || query.has('force')));

  const jsonHeaders = { 'Content-Type': 'application/json' };

  // Manual HTTP invocations require an authenticated admin. Scheduled runs
  // (no manual query params) proceed without an identity.
  if (isManual) {
    let identity = { ok: false };
    try { identity = await getIdentity(req); } catch { identity = { ok: false }; }
    if (!identity.ok || !isAdmin(identity)) {
      return new Response(JSON.stringify({ ok: false, error: 'admin authentication required for manual invocation' }), { status: 401, headers: jsonHeaders });
    }
  }

  // Force is only honored for an authenticated admin AND when explicitly allowed.
  const force = isManual && wantsForce && process.env.MORNING_BRIEFING_ALLOW_FORCE === 'true';
  if (isManual && wantsForce && !force) {
    return new Response(JSON.stringify({ ok: false, error: 'force not allowed: set MORNING_BRIEFING_ALLOW_FORCE=true to enable' }), { status: 403, headers: jsonHeaders });
  }

  const diag = await runMorningBriefing({
    env: process.env,
    now: new Date(),
    dryRun: wantsDryRun,
    force,
    loadFleet,
    mutateFleet,
    sendMessage: sendTelegram,
    summarize,
    loadMarketContext,
  });

  console.log(`[morning-briefing] code=${diag.code} sent=${diag.sent} aiUsed=${diag.aiUsed} aiFallback=${diag.aiFallbackUsed} rows=${diag.marketRowsUsed} radar=${diag.radarCandidatesUsed} len=${diag.messageLength} skip=${diag.skippedReason || '-'}`);
  // Data provenance is logged on every run, not only on failure: a briefing that
  // went out on withheld data must be findable in the function logs afterwards.
  const ageMin = (ms) => (ms == null ? 'n/a' : Math.round(ms / 60000));
  const logDataState = (diag.marketDataUsable && diag.radarDataUsable) ? console.log : console.warn;
  logDataState(`[morning-briefing] data source=${diag.dataSource} marketUsable=${diag.marketDataUsable} marketAgeMin=${ageMin(diag.marketDataAgeMs)} marketReason=${diag.marketDataReason || '-'} radarUsable=${diag.radarDataUsable} radarAgeMin=${ageMin(diag.radarDataAgeMs)} radarReason=${diag.radarDataReason || '-'}`);

  // Manual invocation returns JSON (preview included for dry runs).
  if (isManual) {
    return new Response(JSON.stringify({ ok: true, ...publicDiag(diag, { includePreview: wantsDryRun }) }, null, 2), { status: 200, headers: jsonHeaders });
  }

  // Scheduled invocation returns the diagnostics object (no preview body).
  return publicDiag(diag);
};

// Hourly across the morning window (UTC). The function's own local-hour gate +
// once-per-day dedup pick the single correct firing for MORNING_BRIEFING_HOUR_LOCAL
// in MORNING_BRIEFING_TIMEZONE, surviving CET<->CEST DST shifts. See header note.
export const config = {
  schedule: '0 5-9 * * *',
};

export { sendTelegram, escapeHtml };
