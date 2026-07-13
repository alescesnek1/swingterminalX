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

// ── Symbol watch-list (Phase 3) — selected symbols only, no sending ──

// Trim + uppercase, mirroring the backend normalizeWatches step.
export function normalizeWatchSymbol(value) {
  return String(value ?? '').trim().toUpperCase();
}

// Mirrors the backend validateWatchSymbol (netlify/functions/
// _personal-watch-store.mjs): 2-20 uppercase letters/digits, no spaces or
// punctuation. Client-side only for UX; the backend re-validates every request.
export function validateWatchSymbolClient(value) {
  const symbol = normalizeWatchSymbol(value);
  if (!symbol) return { ok: false, error: 'Enter a symbol.' };
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
    return { ok: false, error: 'Symbol must be 2-20 letters/digits (no spaces or punctuation).' };
  }
  return { ok: true, symbol };
}

// Shapes the watch-list endpoint response into a render model. Reads only the
// symbol/addedAt/count/max fields — it never reads or forwards a chat id, so no
// chat id can reach the DOM through here.
export function personalWatchListRenderModel(apiResponse) {
  const r = apiResponse && typeof apiResponse === 'object' ? apiResponse : {};
  const rawList = Array.isArray(r.watches) ? r.watches : [];
  const watches = rawList
    .filter((w) => w && typeof w === 'object' && typeof w.symbol === 'string')
    .map((w) => ({
      symbol: normalizeWatchSymbol(w.symbol),
      addedAt: typeof w.addedAt === 'string' ? w.addedAt : null,
    }))
    .filter((w) => /^[A-Z0-9]{2,20}$/.test(w.symbol));
  const max = Number.isFinite(r.max) ? r.max : null;
  return {
    watches,
    count: watches.length,
    max,
    full: max != null ? watches.length >= max : false,
    error: false,
  };
}

if (typeof window !== 'undefined') {
  window.__personalWatch = {
    validateChatId: validatePersonalWatchChatId,
    toRenderModel: personalWatchRenderModel,
    signedOutModel: personalWatchSignedOutModel,
    errorModel: personalWatchErrorModel,
    validateWatchSymbol: validateWatchSymbolClient,
    normalizeWatchSymbol,
    toWatchListModel: personalWatchListRenderModel,
  };
}
