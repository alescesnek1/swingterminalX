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
    legacyBlockedCount: Number.isFinite(Number(state.legacyBlockedCount)) ? Number(state.legacyBlockedCount) : 0,
    lastLegacyBlockedAt: state.lastLegacyBlockedAt || null,
    lastRadarSentAt: state.lastRadarSentAt || null,
    lastRadarSkippedReason: state.lastRadarSkippedReason || null,
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
  // Use radar.entryReady directly for iteration, assuming trading-radar places true candidates there
  // Fall back to candidates array if entryReady isn't pre-populated
  const candidates = (Array.isArray(radar.entryReady) && radar.entryReady.length > 0) ? radar.entryReady : (Array.isArray(radar.candidates) ? radar.candidates : []);
  
  return candidates
    .filter((c) => c && String(c.stage || '') === 'ENTRY_READY')
    .slice(0, 5); // Take top 5 potentials, filter strictly later during send
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

// PRIVATE: No other module may use this directly
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

export async function sendRadarEntryReadyTelegram(candidate, state, token, chatId) {
  const nowIso = new Date().toISOString();
  
  // Hard gates
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, reason: 'invalid_candidate', code: 'TELEGRAM_LEGACY_BLOCKED' };
  }
  
  const stage = String(candidate.stage || '');
  if (['BUY', 'FLUSH+BUY', 'STRONG BUY', 'RECLAIM', 'WATCH', 'LONG_FLUSH_CONFIRMED', 'STABILIZING', 'SQUEEZE_CONFIRMED', 'NEAR_ENTRY'].includes(stage)) {
    return { ok: false, reason: `legacy_blocked_${stage}`, code: 'TELEGRAM_LEGACY_BLOCKED' };
  }

  if (stage !== 'ENTRY_READY') {
    return { ok: false, reason: 'stage_not_entry_ready', code: 'TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY' };
  }
  
  if (String(candidate.actionability || '') !== 'ENTRY_READY') {
    return { ok: false, reason: 'actionability_not_entry_ready', code: 'TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY' };
  }

  if (candidate.telegramEligible !== true) {
     return { ok: false, reason: 'not_telegram_eligible', code: 'TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY' };
  }
  
  if (Number(candidate.confidence) < 75 || !Number.isFinite(Number(candidate.confidence))) {
    return { ok: false, reason: 'confidence_below_75', code: 'TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY' };
  }
  
  if (!candidate.entryZone || typeof candidate.entryZone !== 'object' || candidate.entryZone.low == null || candidate.entryZone.high == null) {
    return { ok: false, reason: 'missing_entry_zone', code: 'TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY' };
  }
  
  if (candidate.invalidationLevel == null && candidate.suggestedStop == null) {
    return { ok: false, reason: 'missing_stop_invalidation', code: 'TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY' };
  }
  
  if (!shouldSendRadarTelegramAlert(candidate, state, Date.now())) {
    return { ok: false, reason: 'cooldown_active', code: 'TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY' };
  }

  // All gates passed, send
  const msg = buildRadarTelegramMessage(candidate);
  const result = await sendTelegram(token, chatId, msg);
  
  if (result && result.ok) {
     return { ok: true, code: 'TELEGRAM_RADAR_SENT' };
  } else {
     const errorMsg = result && result.description ? result.description : 'Telegram send failed';
     return { ok: false, reason: errorMsg, code: 'TELEGRAM_API_ERROR' };
  }
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
  state.lastRadarSentAt = nowIso;
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
  let state = normalizeRadarTelegramAlertState(radar.telegramAlertState);
  const potentials = selectRadarEntryAlerts(radar, state, nowMs);

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

  if (!potentials.length) {
    await mutateFleet((f) => {
      const current = f.tradingRadar || {};
      f.tradingRadar = { ...current, telegramAlertState: normalizeRadarTelegramAlertState(current.telegramAlertState) };
      return { ok: true, sent: 0, reason: 'no_entry_ready_due' };
    });
    console.log('[cron-alerts] No RADAR ENTRY_READY alerts due.');
    return;
  }

  let sentCount = 0;
  let lastError = null;
  let legacyBlockedCountInc = 0;
  let lastSkippedReason = null;
  
  for (const candidate of potentials) {
    const res = await sendRadarEntryReadyTelegram(candidate, state, token, chatId);
    
    if (res.ok) {
      sentCount += 1;
      markSent(state, candidate, nowIso);
    } else {
      if (res.code === 'TELEGRAM_LEGACY_BLOCKED') {
         legacyBlockedCountInc += 1;
         state.lastLegacyBlockedAt = nowIso;
         console.warn(`[cron-alerts] TELEGRAM_LEGACY_BLOCKED: ${candidate.symbol} - ${res.reason}`);
      } else if (res.code === 'TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY') {
         lastSkippedReason = res.reason;
         console.log(`[cron-alerts] TELEGRAM_RADAR_SKIPPED_NOT_ENTRY_READY: ${candidate.symbol} - ${res.reason}`);
      } else {
         lastError = res.reason;
         console.error(`[cron-alerts] TELEGRAM_API_ERROR: ${candidate.symbol} - ${res.reason}`);
      }
    }
  }

  await mutateFleet((f) => {
    const current = f.tradingRadar || {};
    const nextState = normalizeRadarTelegramAlertState(current.telegramAlertState);
    
    // apply sent items
    for (const [sym, info] of Object.entries(state.sent)) {
      if (!nextState.sent[sym] || new Date(info.lastSentAt) > new Date(nextState.sent[sym].lastSentAt)) {
         nextState.sent[sym] = info;
      }
    }
    
    if (sentCount > 0) {
      nextState.lastSentAt = nowIso;
      nextState.lastRadarSentAt = nowIso;
      nextState.sentCount += sentCount;
    }
    
    if (legacyBlockedCountInc > 0) {
       nextState.legacyBlockedCount += legacyBlockedCountInc;
       nextState.lastLegacyBlockedAt = nowIso;
    }
    
    if (lastSkippedReason) nextState.lastRadarSkippedReason = lastSkippedReason;
    if (lastError) nextState.lastError = String(lastError).slice(0, 200);
    else if (sentCount > 0) nextState.lastError = null;
    
    f.tradingRadar = { ...current, telegramAlertState: nextState };
    return { ok: !lastError, sent: sentCount, lastError };
  });

  console.log(`[cron-alerts] RADAR ENTRY_READY alerts sent: ${sentCount}`);
};

export const config = {
  schedule: '*/5 * * * *',
};
