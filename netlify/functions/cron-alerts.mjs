// Scheduled Telegram alerts for Trading RADAR only.
//
// Safety contract:
//   - no scanner/live-feed/generic flush alerts
//   - no WATCH/STABILIZING/SQUEEZE_CONFIRMED alerts
//   - only confirmed RADAR ENTRY_READY candidates

import { loadFleet, mutateFleet } from './_fleet-store.mjs';

export const RADAR_TELEGRAM_COOLDOWN_MS = 60 * 60 * 1000;

function escHtml(v) {
  return String(v == null ? '--' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtZone(zone) {
  if (!zone || typeof zone !== 'object') return '--';
  const low = zone.low != null ? zone.low : '--';
  const high = zone.high != null ? zone.high : '--';
  return `${low} - ${high}`;
}

export function normalizeRadarTelegramAlertState(input = {}) {
  const state = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sent = state.sent && typeof state.sent === 'object' && !Array.isArray(state.sent) ? state.sent : {};
  return {
    mode: 'ENTRY_READY_ONLY',
    cooldownMs: Number.isFinite(Number(state.cooldownMs)) ? Number(state.cooldownMs) : RADAR_TELEGRAM_COOLDOWN_MS,
    sent,
    lastSentAt: state.lastSentAt || null,
    lastError: state.lastError || null,
    sentCount: Number.isFinite(Number(state.sentCount)) ? Number(state.sentCount) : 0,
  };
}

export function shouldSendRadarTelegramAlert(candidate, state = {}, nowMs = Date.now()) {
  if (!candidate || String(candidate.stage || '') !== 'ENTRY_READY') return false;
  const symbol = String(candidate.symbol || '').toUpperCase();
  if (!symbol) return false;
  const normalized = normalizeRadarTelegramAlertState(state);
  const lastSentAt = normalized.sent[symbol] && normalized.sent[symbol].lastSentAt
    ? new Date(normalized.sent[symbol].lastSentAt).getTime()
    : 0;
  return !Number.isFinite(lastSentAt) || lastSentAt <= 0 || nowMs - lastSentAt >= normalized.cooldownMs;
}

export function selectRadarEntryAlerts(radar = {}, state = {}, nowMs = Date.now()) {
  const entryReady = Array.isArray(radar.entryReady) ? radar.entryReady : [];
  return entryReady
    .filter((c) => c && String(c.stage || '') === 'ENTRY_READY')
    .filter((c) => shouldSendRadarTelegramAlert(c, state, nowMs))
    .slice(0, 5);
}

export function buildRadarTelegramMessage(candidate) {
  const reasons = Array.isArray(candidate.reasons) ? candidate.reasons.slice(0, 3) : [];
  const riskFlags = Array.isArray(candidate.riskFlags) && candidate.riskFlags.length
    ? candidate.riskFlags.slice(0, 5).join(', ')
    : 'none';
  const timeValidity = candidate.timeValidity || candidate.TIME_VALIDITY || '15-30 minutes or until next public snapshot';
  return [
    `<b>TRADING RADAR ENTRY_READY</b>`,
    `symbol: <b>${escHtml(candidate.symbol)}</b>`,
    `stage: <b>ENTRY_READY</b>`,
    `entryType: ${escHtml(candidate.entryType || '--')}`,
    `entryZone: ${escHtml(fmtZone(candidate.entryZone))}`,
    `invalidationLevel: ${escHtml(candidate.invalidationLevel)}`,
    `suggestedStop: ${escHtml(candidate.suggestedStop)}`,
    `setupQualityScore: ${escHtml(candidate.setupQualityScore)}`,
    `confidence: ${escHtml(candidate.confidence)}`,
    `top 3 reasons: ${escHtml(reasons.join(' | ') || '--')}`,
    `risk flags: ${escHtml(riskFlags)}`,
    `time validity: ${escHtml(timeValidity)}`,
  ].join('\n');
}

async function sendTelegram(token, chatId, text) {
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
    return { ok: false, description: detail || `${res.status} ${res.statusText}`, error_code: res.status };
  }
  return res.json();
}

function markSent(state, candidate, nowIso) {
  const symbol = String(candidate.symbol || '').toUpperCase();
  if (!symbol) return state;
  state.sent[symbol] = {
    lastSentAt: nowIso,
    stage: 'ENTRY_READY',
    entryType: candidate.entryType || null,
    setupQualityScore: candidate.setupQualityScore ?? null,
  };
  state.lastSentAt = nowIso;
  state.lastError = null;
  state.sentCount = (Number(state.sentCount) || 0) + 1;
  return state;
}

export default async () => {
  const token = process.env.TG_BOT_TOKEN ? process.env.TG_BOT_TOKEN.trim() : '';
  const chatId = process.env.TG_CHAT_ID ? process.env.TG_CHAT_ID.trim() : '';
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const fleet = await loadFleet();
  const radar = fleet && fleet.tradingRadar ? fleet.tradingRadar : {};
  const state = normalizeRadarTelegramAlertState(radar.telegramAlertState);
  const due = selectRadarEntryAlerts(radar, state, nowMs);

  if (!token || !chatId) {
    await mutateFleet((f) => {
      const current = f.tradingRadar || {};
      const nextState = normalizeRadarTelegramAlertState(current.telegramAlertState);
      nextState.lastError = 'Telegram credentials missing';
      f.tradingRadar = { ...current, telegramAlertState: nextState };
      return { ok: false, sent: 0, reason: 'missing_credentials' };
    });
    console.warn('[cron-alerts] Telegram credentials missing; RADAR alerts not sent.');
    return;
  }

  if (!due.length) {
    await mutateFleet((f) => {
      const current = f.tradingRadar || {};
      f.tradingRadar = { ...current, telegramAlertState: normalizeRadarTelegramAlertState(current.telegramAlertState) };
      return { ok: true, sent: 0, reason: 'no_entry_ready_due' };
    });
    console.log('[cron-alerts] No RADAR ENTRY_READY alerts due.');
    return;
  }

  let sent = 0;
  let lastError = null;
  for (const candidate of due) {
    const result = await sendTelegram(token, chatId, buildRadarTelegramMessage(candidate));
    if (result && result.ok) {
      sent += 1;
      markSent(state, candidate, nowIso);
    } else {
      lastError = result && result.description ? result.description : 'Telegram send failed';
      break;
    }
  }

  await mutateFleet((f) => {
    const current = f.tradingRadar || {};
    const nextState = normalizeRadarTelegramAlertState(current.telegramAlertState);
    for (const candidate of due.slice(0, sent)) {
      if (shouldSendRadarTelegramAlert(candidate, nextState, nowMs)) markSent(nextState, candidate, nowIso);
    }
    if (lastError) nextState.lastError = String(lastError).slice(0, 200);
    f.tradingRadar = { ...current, telegramAlertState: nextState };
    return { ok: !lastError, sent, lastError };
  });

  console.log(`[cron-alerts] RADAR ENTRY_READY alerts sent: ${sent}`);
};

export const config = {
  schedule: '*/5 * * * *',
};
