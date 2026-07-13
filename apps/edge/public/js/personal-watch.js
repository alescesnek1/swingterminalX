// ─────────────────────────────────────────────────────────────
// Swing Terminal — Cockpit Personal Alerts settings (pure, no DOM, no fetch)
//
// UI-ONLY settings wiring for the already-live Phase 1 backend
// (/api/cockpit-personal-watch-settings). This module never sends Telegram,
// never touches trading, execution, or Binance order paths, and never returns a raw chat
// id: it only validates client-side input and shapes the server's
// already-masked response into a render model. Personal, direct Telegram
// chat IDs only — group/channel IDs are not supported here. Connecting a
// chat id here does NOT enable alerts yet; sending is a separate, later,
// reviewed phase. See docs/personal-watch-design.md.
// ─────────────────────────────────────────────────────────────

// Mirrors the backend's validateTelegramChatId
// (netlify/functions/_personal-watch-store.mjs): trimmed, digits-only,
// length 5-20. Client-side validation is a UX convenience only — the
// backend remains the source of truth and re-validates every request.
export function validatePersonalWatchChatId(value) {
  const chatId = String(value ?? '').trim();
  if (!chatId) return { ok: false, error: 'Enter a Telegram chat ID.' };
  if (!/^\d+$/.test(chatId)) return { ok: false, error: 'Chat ID must contain digits only.' };
  if (chatId.length < 5) return { ok: false, error: 'Chat ID is too short.' };
  if (chatId.length > 20) return { ok: false, error: 'Chat ID is too long.' };
  return { ok: true, chatId };
}

// Shapes the server's publicPersonalWatchSettings() response into a render
// model. Only reads the known-safe masked fields — it never reads or
// forwards a raw `telegramChatId`, even if one were ever accidentally
// present in the payload, so a raw id can never reach the DOM through here.
export function personalWatchRenderModel(apiResponse) {
  const r = apiResponse && typeof apiResponse === 'object' ? apiResponse : {};
  const connected = !!r.telegramConnected;
  const maskedChatId = connected && typeof r.telegramChatIdMasked === 'string' ? r.telegramChatIdMasked : null;
  const updatedAt = connected && typeof r.telegramChatIdUpdatedAt === 'string' ? r.telegramChatIdUpdatedAt : null;
  return {
    connected,
    maskedChatId,
    updatedAt,
    statusText: connected ? `Connected · ${maskedChatId || '••••'}` : 'Not connected',
    signedOut: false,
    error: false,
  };
}

export function personalWatchSignedOutModel() {
  return {
    connected: false,
    maskedChatId: null,
    updatedAt: null,
    statusText: 'Sign in to manage personal alerts.',
    signedOut: true,
    error: false,
  };
}

export function personalWatchErrorModel(message) {
  return {
    connected: false,
    maskedChatId: null,
    updatedAt: null,
    statusText: message || 'Could not load personal alert settings.',
    signedOut: false,
    error: true,
  };
}

if (typeof window !== 'undefined') {
  window.__personalWatch = {
    validateChatId: validatePersonalWatchChatId,
    toRenderModel: personalWatchRenderModel,
    signedOutModel: personalWatchSignedOutModel,
    errorModel: personalWatchErrorModel,
  };
}
