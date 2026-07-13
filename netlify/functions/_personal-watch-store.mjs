const PERSONAL_WATCH_STORE_NAME = 'cockpit-personal-watch';

let _blobStore = null;
let _backendName = 'memory';
let _storeError = null;
const _mem = new Map();

function blobCredsFromEnv() {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.BLOBS_SITE_ID || process.env.SITE_ID || null;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN || null;
  return siteID && token ? { siteID, token } : null;
}

function downgradeToMemory(reason) {
  _blobStore = null;
  _backendName = 'memory';
  _storeError = reason ? String(reason).slice(0, 200) : 'unknown blob error';
}

async function resolveBackend() {
  if (_blobStore) return;
  try {
    const mod = await import('@netlify/blobs');
    if (!mod || typeof mod.getStore !== 'function') {
      return downgradeToMemory('@netlify/blobs has no getStore export');
    }
    const opts = { name: PERSONAL_WATCH_STORE_NAME, consistency: 'strong' };
    try {
      _blobStore = mod.getStore(opts);
    } catch (e1) {
      const creds = blobCredsFromEnv();
      if (!creds) throw e1;
      _blobStore = mod.getStore({ ...opts, ...creds });
    }
    _backendName = 'blobs';
    _storeError = null;
  } catch (err) {
    downgradeToMemory(err && err.message ? err.message : 'blob init failed');
    console.warn('[personalWatchStore] Netlify Blobs unavailable, using in-memory fallback:', _storeError);
  }
}

function userKey(userId) {
  return `user-${Buffer.from(String(userId), 'utf8').toString('base64url')}`;
}

function normalizeRecord(data, identity) {
  const userId = String(identity && identity.userId ? identity.userId : '');
  const email = String(identity && identity.email ? identity.email : '').toLowerCase();
  const base = { userId, email, telegramChatId: null, telegramChatIdUpdatedAt: null, watches: [] };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return base;
  const own = data.userId === userId ? data : { ...data, userId };
  return {
    userId,
    email: email || String(own.email || '').toLowerCase(),
    telegramChatId: typeof own.telegramChatId === 'string' && own.telegramChatId ? own.telegramChatId : null,
    telegramChatIdUpdatedAt: typeof own.telegramChatIdUpdatedAt === 'string' && own.telegramChatIdUpdatedAt ? own.telegramChatIdUpdatedAt : null,
    watches: Array.isArray(own.watches) ? own.watches : [],
  };
}

export function validateTelegramChatId(value) {
  const telegramChatId = String(value ?? '').trim();
  if (!telegramChatId) return { ok: false, error: 'Telegram chat ID is required.' };
  if (!/^\d+$/.test(telegramChatId)) return { ok: false, error: 'Telegram chat ID must contain digits only.' };
  if (telegramChatId.length < 5) return { ok: false, error: 'Telegram chat ID is too short.' };
  if (telegramChatId.length > 20) return { ok: false, error: 'Telegram chat ID is too long.' };
  return { ok: true, telegramChatId };
}

export function maskChatId(value) {
  const id = String(value ?? '').trim();
  if (!id) return null;
  if (id.length <= 6) return `${id.slice(0, 2)}••${id.slice(-2)}`;
  return `${id.slice(0, 4)}••••${id.slice(-2)}`;
}

export function publicPersonalWatchSettings(record) {
  const connected = !!(record && record.telegramChatId);
  return {
    ok: true,
    email: record && record.email ? record.email : '',
    telegramConnected: connected,
    telegramChatIdMasked: connected ? maskChatId(record.telegramChatId) : null,
    telegramChatIdUpdatedAt: connected ? record.telegramChatIdUpdatedAt || null : null,
  };
}

export async function loadPersonalWatchSettings(identity) {
  await resolveBackend();
  const key = userKey(identity.userId);
  if (_blobStore) {
    try {
      const data = await _blobStore.get(key, { type: 'json' });
      return normalizeRecord(data, identity);
    } catch (err) {
      downgradeToMemory(err && err.message ? err.message : 'blob read failed');
      console.warn('[personalWatchStore] blob read failed, downgrading to memory:', _storeError);
    }
  }
  const raw = _mem.get(key);
  return normalizeRecord(raw ? JSON.parse(raw) : null, identity);
}

async function savePersonalWatchSettings(identity, record) {
  await resolveBackend();
  const normalized = normalizeRecord(record, identity);
  const key = userKey(identity.userId);
  if (_blobStore) {
    try {
      await _blobStore.setJSON(key, normalized);
      _mem.set(key, JSON.stringify(normalized));
      return normalized;
    } catch (err) {
      downgradeToMemory(err && err.message ? err.message : 'blob write failed');
      console.error('[personalWatchStore] blob write failed, downgrading to memory:', _storeError);
    }
  }
  _mem.set(key, JSON.stringify(normalized));
  return normalized;
}

export async function saveTelegramChatId(identity, telegramChatId, nowIso = new Date().toISOString()) {
  const current = await loadPersonalWatchSettings(identity);
  return await savePersonalWatchSettings(identity, {
    ...current,
    userId: identity.userId,
    email: String(identity.email || '').toLowerCase(),
    telegramChatId,
    telegramChatIdUpdatedAt: nowIso,
    watches: Array.isArray(current.watches) ? current.watches : [],
  });
}

export async function removeTelegramChatId(identity) {
  const current = await loadPersonalWatchSettings(identity);
  return await savePersonalWatchSettings(identity, {
    ...current,
    userId: identity.userId,
    email: String(identity.email || '').toLowerCase(),
    telegramChatId: null,
    telegramChatIdUpdatedAt: null,
    watches: Array.isArray(current.watches) ? current.watches : [],
  });
}

// ─────────────────────────────────────────────────────────────
// Symbol watch-list (Phase 3) — selected-symbols only.
//
// A "watch" is a user's per-symbol subscription (notify me when this symbol
// reaches a confirmed RADAR entry setup) — delivery is a FUTURE phase; nothing
// here sends. Stored on the SAME per-user record as the Telegram chat id, so
// adding/removing a watch never touches telegramChatId. Watch responses carry
// symbols only — never the raw chat id. See docs/personal-watch-design.md.
// ─────────────────────────────────────────────────────────────

export const MAX_WATCHES_PER_USER = 25;

// Strict: 2-20 chars, uppercase letters/digits only. Trims + uppercases first.
// Rejects empty, spaces, punctuation, slashes, and injection-like strings.
export function validateWatchSymbol(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!symbol) return { ok: false, error: 'Symbol is required.' };
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
    return { ok: false, error: 'Symbol must be 2-20 letters/digits only (no spaces or punctuation).' };
  }
  return { ok: true, symbol };
}

// Coerce a stored watches array into clean, deduped { symbol, addedAt } records,
// dropping anything malformed. Read-side normalization keeps legacy/partial data
// honest without a migration.
function normalizeWatches(watches) {
  if (!Array.isArray(watches)) return [];
  const seen = new Set();
  const out = [];
  for (const w of watches) {
    if (!w || typeof w !== 'object') continue;
    const symbol = String(w.symbol ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,20}$/.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, addedAt: typeof w.addedAt === 'string' && w.addedAt ? w.addedAt : null });
  }
  return out;
}

// Persist watches on the user's record while preserving the chat id verbatim.
async function saveWatches(identity, current, watches) {
  return await savePersonalWatchSettings(identity, {
    ...current,
    userId: identity.userId,
    email: String(identity.email || current.email || '').toLowerCase(),
    telegramChatId: current.telegramChatId,
    telegramChatIdUpdatedAt: current.telegramChatIdUpdatedAt,
    watches,
  });
}

export async function listPersonalWatches(identity) {
  const current = await loadPersonalWatchSettings(identity);
  return normalizeWatches(current.watches);
}

export async function addPersonalWatch(identity, symbol, nowIso = new Date().toISOString()) {
  const valid = validateWatchSymbol(symbol);
  if (!valid.ok) return { ok: false, error: valid.error };
  const current = await loadPersonalWatchSettings(identity);
  const watches = normalizeWatches(current.watches);
  // Idempotent: re-adding an existing symbol is a no-op success (never a dup).
  if (watches.some((w) => w.symbol === valid.symbol)) {
    return { ok: true, watches };
  }
  if (watches.length >= MAX_WATCHES_PER_USER) {
    return { ok: false, error: `Watch list is full (max ${MAX_WATCHES_PER_USER}).` };
  }
  const next = [...watches, { symbol: valid.symbol, addedAt: nowIso }];
  const record = await saveWatches(identity, current, next);
  return { ok: true, watches: normalizeWatches(record.watches) };
}

export async function removePersonalWatch(identity, symbol) {
  const valid = validateWatchSymbol(symbol);
  if (!valid.ok) return { ok: false, error: valid.error };
  const current = await loadPersonalWatchSettings(identity);
  // Idempotent: removing a symbol that isn't present just returns the list.
  const next = normalizeWatches(current.watches).filter((w) => w.symbol !== valid.symbol);
  const record = await saveWatches(identity, current, next);
  return { ok: true, watches: normalizeWatches(record.watches) };
}

// Public shape for watch-list responses — symbols only, never the chat id.
export function publicPersonalWatchList(watches) {
  const list = normalizeWatches(watches);
  return { ok: true, watches: list, count: list.length, max: MAX_WATCHES_PER_USER };
}

export function personalWatchStoreInfo() {
  const durable = _backendName === 'blobs';
  return { storeMode: durable ? 'durable_blobs' : 'memory_fallback', durable, storeError: durable ? null : _storeError };
}

export function __setPersonalWatchBlobStoreForTest(store) {
  _blobStore = store;
  _backendName = store ? 'blobs' : 'memory';
  _storeError = null;
  _mem.clear();
}

export function __resetPersonalWatchStoreForTest() {
  _blobStore = null;
  _backendName = 'memory';
  _storeError = null;
  _mem.clear();
}

export { PERSONAL_WATCH_STORE_NAME };
