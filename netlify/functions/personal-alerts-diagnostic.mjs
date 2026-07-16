// Manual, owner-triggered diagnostic Telegram delivery test for Personal
// Watch — a completely separate path from the real alert sender
// (personal-alerts.mjs). This function never reads or scores RADAR, never
// enumerates recipients, and can send to exactly ONE server-configured
// target user, only on an explicit manual POST guarded by its own
// dedicated enable flag and its own dedicated secret/header. It shares
// nothing with the real sender's enable flag, scheduler secret/header, or
// dedup/cooldown/sent state.
//
// Why this exists: to let the owner confirm Telegram delivery works for a
// connected test account without waiting for (or forcing) a real RADAR
// confirmed-entry alert. It must never be usable to deliver a market alert
// and must never affect the real sender's behavior or state in any way.

import { timingSafeEqual } from 'node:crypto';
import { getPersonalWatchRecordForDiagnostic } from './_personal-watch-store.mjs';

export const PERSONAL_ALERTS_DIAGNOSTIC_HEADER = 'x-terminal-diagnostic-secret';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildDiagnosticMessage(watchSymbol) {
  const lines = [
    'Terminal-X Personal Alerts diagnostic test.',
    '',
    'This is only a delivery test.',
    'No market signal.',
    'No trading action.',
  ];
  if (watchSymbol) {
    lines.push(`Watched symbol on file: ${escapeHtml(watchSymbol)}`);
  }
  lines.push('If you received this, your Personal Watch Telegram delivery is connected.');
  return lines.join('\n');
}

// Maps an HTTP status + Telegram's own error_code/description to an
// allowlisted failure kind + description code. The raw `description` is
// only ever inspected here for keyword matching and is never forwarded —
// callers only ever see the fixed codes returned below.
function classifyTelegramHttpFailure(status, description) {
  const desc = String(description || '').toLowerCase();
  if (status === 401) {
    return { telegramFailureKind: 'TELEGRAM_UNAUTHORIZED', telegramApiDescriptionCode: 'BOT_TOKEN_INVALID_OR_REVOKED' };
  }
  if (status === 403) {
    return { telegramFailureKind: 'TELEGRAM_FORBIDDEN', telegramApiDescriptionCode: 'BOT_BLOCKED_OR_CHAT_NOT_STARTED' };
  }
  if (status === 400) {
    let descriptionCode = 'BAD_REQUEST';
    if (desc.includes('chat not found') || desc.includes('chat_id is empty') || desc.includes('invalid chat')) {
      descriptionCode = 'CHAT_NOT_FOUND_OR_INVALID';
    } else if (desc.includes('message text') || desc.includes('text is empty') || desc.includes('parse entities') || desc.includes('entity')) {
      descriptionCode = 'MESSAGE_TEXT_INVALID';
    }
    return { telegramFailureKind: 'TELEGRAM_BAD_REQUEST', telegramApiDescriptionCode: descriptionCode };
  }
  if (status === 429) {
    return { telegramFailureKind: 'TELEGRAM_RATE_LIMITED', telegramApiDescriptionCode: 'RATE_LIMITED' };
  }
  if (status >= 500 && status <= 599) {
    return { telegramFailureKind: 'TELEGRAM_SERVER_ERROR', telegramApiDescriptionCode: 'TELEGRAM_SERVER_ERROR' };
  }
  return { telegramFailureKind: 'TELEGRAM_API_ERROR', telegramApiDescriptionCode: 'UNKNOWN_TELEGRAM_API_ERROR' };
}

export async function sendDiagnosticTelegram(token, chatId, text, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return isTimeout
      ? { ok: false, code: 'TELEGRAM_API_ERROR', telegramFailureKind: 'TELEGRAM_TIMEOUT', telegramApiDescriptionCode: 'NETWORK_TIMEOUT' }
      : { ok: false, code: 'TELEGRAM_API_ERROR', telegramFailureKind: 'TELEGRAM_NETWORK_ERROR', telegramApiDescriptionCode: 'NETWORK_ERROR' };
  }

  if (response.ok === true) {
    return { ok: true, code: 'SENT' };
  }

  let apiErrorCode = response.status;
  let description = '';
  try {
    const body = await response.json();
    if (body && typeof body.error_code === 'number') apiErrorCode = body.error_code;
    if (body && typeof body.description === 'string') description = body.description;
  } catch {
    // Non-JSON or unreadable body — classify on HTTP status alone.
  }

  return {
    ok: false,
    code: 'TELEGRAM_API_ERROR',
    telegramHttpStatus: response.status,
    telegramApiErrorCode: apiErrorCode,
    ...classifyTelegramHttpFailure(response.status, description),
  };
}

function baseSummary(extra = {}) {
  return {
    ok: true,
    enabled: false,
    sent: 0,
    targetConfigured: false,
    targetFound: false,
    targetHasChat: false,
    targetWatchCount: 0,
    ...extra,
  };
}

export function isDiagnosticAuthenticated(req, env = process.env) {
  const expected = String(env.PERSONAL_ALERTS_DIAGNOSTIC_SECRET || '').trim();
  const provided = req && req.headers && typeof req.headers.get === 'function'
    ? String(req.headers.get(PERSONAL_ALERTS_DIAGNOSTIC_HEADER) || '').trim()
    : '';
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  return expectedBytes.length === providedBytes.length
    && timingSafeEqual(expectedBytes, providedBytes);
}

// Never reads a request body and never accepts any caller-supplied target —
// the target user id comes only from server-side env, set by the owner.
export async function runDiagnosticSend(deps = {}) {
  const env = deps.env || process.env;
  if (env.PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED !== 'true') {
    return baseSummary({ disabled: true, reason: 'DIAGNOSTIC_DISABLED' });
  }

  const secret = String(env.PERSONAL_ALERTS_DIAGNOSTIC_SECRET || '').trim();
  if (!secret) {
    return baseSummary({ ok: false, error: 'DIAGNOSTIC_SECRET_NOT_CONFIGURED' });
  }

  const targetUserId = String(env.PERSONAL_ALERTS_DIAGNOSTIC_TARGET_USER_ID || '').trim();
  if (!targetUserId) {
    return baseSummary({ ok: false, error: 'DIAGNOSTIC_TARGET_NOT_CONFIGURED' });
  }

  const token = String(env.TG_BOT_TOKEN || '').trim();
  if (!token) {
    return baseSummary({ ok: false, targetConfigured: true, error: 'DIAGNOSTIC_TOKEN_MISSING' });
  }

  const getRecord = deps.getRecord || getPersonalWatchRecordForDiagnostic;
  const sendMessage = deps.sendMessage
    || ((sendToken, chatId, message) => sendDiagnosticTelegram(sendToken, chatId, message, deps.fetchImpl));

  let result;
  try {
    result = await getRecord(targetUserId);
  } catch {
    return baseSummary({ ok: false, targetConfigured: true, error: 'DIAGNOSTIC_STORE_UNAVAILABLE' });
  }

  if (!result || result.found !== true) {
    return baseSummary({ ok: false, targetConfigured: true, error: 'DIAGNOSTIC_TARGET_NOT_FOUND' });
  }

  const record = result.record || {};
  const chatId = String(record.telegramChatId || '').trim();
  if (!/^\d{5,20}$/.test(chatId)) {
    return baseSummary({
      ok: false,
      targetConfigured: true,
      targetFound: true,
      error: 'DIAGNOSTIC_TARGET_NO_CHAT',
    });
  }

  const watches = Array.isArray(record.watches) ? record.watches : [];
  if (watches.length !== 1) {
    return baseSummary({
      ok: false,
      targetConfigured: true,
      targetFound: true,
      targetHasChat: true,
      targetWatchCount: watches.length,
      error: 'DIAGNOSTIC_TARGET_WATCH_COUNT_NOT_ONE',
    });
  }

  const watchSymbol = String(watches[0] && watches[0].symbol || '').toUpperCase();
  const sent = await sendMessage(token, chatId, buildDiagnosticMessage(watchSymbol));
  if (!sent || sent.ok !== true) {
    const failureFields = {};
    if (sent && sent.telegramFailureKind) failureFields.telegramFailureKind = sent.telegramFailureKind;
    if (sent && typeof sent.telegramHttpStatus === 'number') failureFields.telegramHttpStatus = sent.telegramHttpStatus;
    if (sent && typeof sent.telegramApiErrorCode === 'number') failureFields.telegramApiErrorCode = sent.telegramApiErrorCode;
    if (sent && sent.telegramApiDescriptionCode) failureFields.telegramApiDescriptionCode = sent.telegramApiDescriptionCode;
    return baseSummary({
      ok: false,
      targetConfigured: true,
      targetFound: true,
      targetHasChat: true,
      targetWatchCount: 1,
      error: 'DIAGNOSTIC_TELEGRAM_FAILED',
      ...failureFields,
    });
  }

  return baseSummary({
    enabled: true,
    sent: 1,
    targetConfigured: true,
    targetFound: true,
    targetHasChat: true,
    targetWatchCount: 1,
    reason: 'DIAGNOSTIC_SENT',
  });
}

export default async function handler(req) {
  const enabled = process.env.PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED === 'true';
  if (enabled) {
    // Only a POST carrying the valid diagnostic secret may reach the send
    // pipeline. A GET (or any other method) is rejected even with a correct
    // header. The request body is never read for auth or for target
    // selection — the target user id comes only from server-side env.
    const method = req && typeof req.method === 'string' ? req.method.toUpperCase() : '';
    if (method !== 'POST' || !isDiagnosticAuthenticated(req)) {
      return new Response(JSON.stringify({ ok: false, sent: 0, error: 'DIAGNOSTIC_AUTH_REQUIRED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  }
  const result = await runDiagnosticSend();
  console.log(`[personal-alerts-diagnostic] enabled=${result.enabled === true} ok=${result.ok === true} sent=${result.sent} reason=${result.reason || result.error || ''}`);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
