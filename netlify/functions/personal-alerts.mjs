// Scheduled per-user Personal Watch Telegram fan-out.
//
// This function never creates a signal. It reuses cron-alerts.mjs selection for
// fully confirmed, fresh RADAR ENTRY_READY candidates, then delivers only to
// users with a matching selected-symbol watch and a saved personal chat id.
// Delivery is disabled unless PERSONAL_ALERTS_ENABLED is exactly "true".

import { timingSafeEqual } from 'node:crypto';
import { loadFleet } from './_fleet-store.mjs';
import {
  RADAR_TELEGRAM_COOLDOWN_MS,
  normalizeRadarTelegramAlertState,
  selectRadarEntryAlerts,
  setupHash,
} from './cron-alerts.mjs';
import {
  getPersonalAlertState,
  listPersonalWatchRecipients,
  markPersonalAlertSent,
  normalizePersonalAlertState,
  recordPersonalAlertError,
  reservePersonalAlert,
} from './_personal-watch-store.mjs';

export const PERSONAL_ALERTS_PER_USER_CAP = 5;
export const PERSONAL_ALERTS_GLOBAL_CAP = 100;
export const PERSONAL_ALERT_RESERVATION_MS = RADAR_TELEGRAM_COOLDOWN_MS;
export const PERSONAL_ALERTS_SCHEDULER_HEADER = 'x-terminal-scheduler-secret';

const DEFAULT_STORE = {
  getPersonalAlertState,
  listPersonalWatchRecipients,
  markPersonalAlertSent,
  recordPersonalAlertError,
  reservePersonalAlert,
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function shortReason(candidate) {
  const reasons = Array.isArray(candidate.REASON) ? candidate.REASON
    : (Array.isArray(candidate.reasons) ? candidate.reasons : []);
  return String(reasons[0] || candidate.reason || 'Confirmed RADAR setup').slice(0, 180);
}

export function buildPersonalAlertMessage(candidate, nowIso = new Date().toISOString()) {
  const symbol = String(candidate && candidate.symbol || '').toUpperCase();
  const price = candidate && (candidate.price ?? candidate.currentPrice ?? candidate.lastPrice);
  const lines = [
    `[Personal Watch] <b>${escapeHtml(symbol)}</b> is RADAR ENTRY_READY.`,
    `Why: ${escapeHtml(shortReason(candidate || {}))}`,
  ];
  if (price != null && Number.isFinite(Number(price))) lines.push(`Price: ${escapeHtml(price)}`);
  lines.push(`Time: ${escapeHtml(nowIso)}`);
  lines.push('Open Swing Terminal X for details.');
  return lines.join('\n');
}

export function personalAlertDecision(candidate, stateInput, nowMs = Date.now()) {
  const symbol = String(candidate && candidate.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) return { ok: false, reason: 'invalidSymbol' };
  const state = normalizePersonalAlertState(stateInput);
  const previous = state.sent[symbol];
  if (!previous) return { ok: true, symbol, hash: setupHash(candidate) };

  const hash = setupHash(candidate);
  if (previous.hash && previous.hash === hash) return { ok: false, reason: 'duplicate' };
  const lastSentMs = previous.lastSentAt ? Date.parse(previous.lastSentAt) : NaN;
  if (Number.isFinite(lastSentMs) && nowMs - lastSentMs < RADAR_TELEGRAM_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown' };
  }
  return { ok: true, symbol, hash };
}

export async function sendPersonalTelegram(token, chatId, text, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: response.ok === true, code: response.ok === true ? 'SENT' : 'TELEGRAM_API_ERROR' };
  } catch {
    return { ok: false, code: 'TELEGRAM_API_ERROR' };
  }
}

function baseSummary(extra = {}) {
  return {
    ok: true,
    enabled: false,
    sent: 0,
    alertsChecked: 0,
    recipientsChecked: 0,
    skipped: {
      noWatch: 0,
      noChat: 0,
      cooldown: 0,
      duplicate: 0,
      cap: 0,
      inFlight: 0,
      failed: 0,
    },
    ...extra,
  };
}

export async function runPersonalAlerts(deps = {}) {
  const env = deps.env || process.env;
  if (env.PERSONAL_ALERTS_ENABLED !== 'true') {
    return baseSummary({ disabled: true, reason: 'PERSONAL_ALERTS_DISABLED' });
  }

  const token = String(env.TG_BOT_TOKEN || '').trim();
  if (!token) {
    return baseSummary({ ok: false, enabled: true, error: 'PERSONAL_ALERTS_TELEGRAM_TOKEN_MISSING' });
  }

  const nowMs = Number.isFinite(Number(deps.nowMs)) ? Number(deps.nowMs) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const loadRadarFleet = deps.loadFleet || loadFleet;
  const store = deps.store || DEFAULT_STORE;
  const sendMessage = deps.sendMessage
    || ((sendToken, chatId, message) => sendPersonalTelegram(sendToken, chatId, message, deps.fetchImpl));

  let fleet;
  try {
    fleet = await loadRadarFleet();
  } catch {
    return baseSummary({ ok: false, enabled: true, error: 'RADAR_SOURCE_UNAVAILABLE' });
  }

  const radar = fleet && fleet.tradingRadar ? fleet.tradingRadar : {};
  const alerts = selectRadarEntryAlerts(radar, normalizeRadarTelegramAlertState(), nowMs);
  if (!alerts.length) {
    return baseSummary({ enabled: true, reason: 'NO_CONFIRMED_ENTRY_READY' });
  }

  let recipientResult;
  try {
    recipientResult = await store.listPersonalWatchRecipients();
    if (!recipientResult || recipientResult.durable !== true || !Array.isArray(recipientResult.recipients)) {
      throw new Error('durable recipient enumeration required');
    }
  } catch {
    return baseSummary({
      ok: false,
      enabled: true,
      alertsChecked: alerts.length,
      error: 'PERSONAL_WATCH_STORE_UNAVAILABLE',
    });
  }

  const recipients = recipientResult.recipients;
  const summary = baseSummary({
    enabled: true,
    alertsChecked: alerts.length,
    recipientsChecked: recipients.length,
  });
  const sentByUser = new Map();
  const stateByUser = new Map();

  const perUserCap = Number.isInteger(deps.perUserCap) && deps.perUserCap > 0 ? deps.perUserCap : PERSONAL_ALERTS_PER_USER_CAP;
  const globalCap = Number.isInteger(deps.globalCap) && deps.globalCap > 0 ? deps.globalCap : PERSONAL_ALERTS_GLOBAL_CAP;
  for (const candidate of alerts) {
    const symbol = String(candidate.symbol || '').trim().toUpperCase();
    for (const recipient of recipients) {
      if (summary.sent >= globalCap) {
        summary.skipped.cap += 1;
        continue;
      }

      const watches = Array.isArray(recipient.watches) ? recipient.watches : [];
      if (!watches.some((watch) => String(watch && watch.symbol || '').toUpperCase() === symbol)) {
        summary.skipped.noWatch += 1;
        continue;
      }

      const chatId = String(recipient.telegramChatId || '').trim();
      if (!/^\d{5,20}$/.test(chatId)) {
        summary.skipped.noChat += 1;
        continue;
      }

      const userId = String(recipient.userId || '');
      if (!userId) {
        summary.skipped.failed += 1;
        summary.ok = false;
        continue;
      }
      if ((sentByUser.get(userId) || 0) >= perUserCap) {
        summary.skipped.cap += 1;
        continue;
      }

      let state = stateByUser.get(userId);
      if (!state) {
        try {
          state = await store.getPersonalAlertState(userId);
          stateByUser.set(userId, state);
        } catch {
          summary.skipped.failed += 1;
          summary.ok = false;
          continue;
        }
      }

      const decision = personalAlertDecision(candidate, state, nowMs);
      if (!decision.ok) {
        if (decision.reason === 'duplicate') summary.skipped.duplicate += 1;
        else if (decision.reason === 'cooldown') summary.skipped.cooldown += 1;
        else summary.skipped.failed += 1;
        continue;
      }

      let reservation;
      try {
        reservation = await store.reservePersonalAlert(userId, decision.symbol, {
          hash: decision.hash,
          nowIso,
          cooldownMs: RADAR_TELEGRAM_COOLDOWN_MS,
          reservationMs: PERSONAL_ALERT_RESERVATION_MS,
        });
      } catch {
        summary.skipped.failed += 1;
        summary.ok = false;
        continue;
      }
      if (!reservation || reservation.acquired !== true) {
        const reason = reservation && reservation.reason;
        if (reason === 'duplicate') summary.skipped.duplicate += 1;
        else if (reason === 'cooldown') summary.skipped.cooldown += 1;
        else if (reason === 'inFlight') summary.skipped.inFlight += 1;
        else {
          summary.skipped.failed += 1;
          summary.ok = false;
        }
        if (reservation && reservation.state) stateByUser.set(userId, reservation.state);
        continue;
      }
      stateByUser.set(userId, reservation.state);

      const sent = await sendMessage(token, chatId, buildPersonalAlertMessage(candidate, nowIso));
      if (!sent || sent.ok !== true) {
        summary.skipped.failed += 1;
        summary.ok = false;
        try {
          await store.recordPersonalAlertError(userId, 'TELEGRAM_API_ERROR', nowIso, decision.symbol, decision.hash);
        } catch {
          // The send already failed. A state-write failure remains fail-closed
          // and is represented by the aggregate failed count.
        }
        continue;
      }

      try {
        state = await store.markPersonalAlertSent(userId, decision.symbol, {
          lastSentAt: nowIso,
          hash: decision.hash,
        });
        stateByUser.set(userId, state);
        summary.sent += 1;
        sentByUser.set(userId, (sentByUser.get(userId) || 0) + 1);
      } catch {
        // Telegram succeeded but durable state did not. The reservation remains
        // fail-closed against overlap until it expires; sent is never marked
        // before Telegram succeeds.
        summary.sent += 1;
        summary.skipped.failed += 1;
        summary.ok = false;
      }
    }
  }

  return summary;
}

export function isSchedulerAuthenticated(req, env = process.env) {
  const expected = String(env.PERSONAL_ALERTS_SCHEDULER_SECRET || '').trim();
  const provided = req && req.headers && typeof req.headers.get === 'function'
    ? String(req.headers.get(PERSONAL_ALERTS_SCHEDULER_HEADER) || '').trim()
    : '';
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  return expectedBytes.length === providedBytes.length
    && timingSafeEqual(expectedBytes, providedBytes);
}

export default async function handler(req) {
  if (process.env.PERSONAL_ALERTS_ENABLED === 'true' && !isSchedulerAuthenticated(req)) {
    return new Response(JSON.stringify({ ok: false, sent: 0, error: 'SCHEDULED_INVOCATION_REQUIRED' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  const result = await runPersonalAlerts();
  console.log(`[personal-alerts] enabled=${result.enabled === true} ok=${result.ok === true} alerts=${result.alertsChecked} recipients=${result.recipientsChecked} sent=${result.sent} failed=${result.skipped.failed}`);
  return result;
}

export const config = {
  schedule: '*/5 * * * *',
};
