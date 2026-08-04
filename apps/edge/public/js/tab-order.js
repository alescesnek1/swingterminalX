// ─────────────────────────────────────────────────────────────
// Swing Terminal — customizable top tab order (pure, no DOM, no fetch)
//
// PERSONALIZATION ONLY. This module decides the ORDER of the main
// navigation buttons and nothing else. It does not create views, mount
// panels, duplicate tabs, or switch views — `sv(view, el)` remains the
// only view switcher, and every view id is untouched.
//
// It never reaches RADAR, ENTRY_READY, Strict Absorb, Reclaim, Telegram,
// alerts, or any order path: it reorders DOM nodes in the tab bar and
// writes one array of view ids to localStorage.
//
// Resolution rules (see resolveTabOrder):
//   • saved ids that are not real tabs are DROPPED (stale build, renamed
//     view, hand-edited storage);
//   • duplicates in the saved array collapse to their first occurrence,
//     so a corrupt value can never render a tab twice;
//   • tabs the saved order has never seen (a NEW tab shipped in a later
//     release) are APPENDED in canonical order, so a customized user
//     still gets it instead of silently losing it.
// The canonical order is whatever the markup ships, so the default is
// always "the DOM order in index.html" with no second list to drift.
//
// Pure + importable so the resolution logic is unit-tested without a DOM;
// terminal.js (a classic <script>) consumes it via window.__tabOrder.
// ─────────────────────────────────────────────────────────────

export const TAB_ORDER_STORAGE_KEY = 'terminalX.tabOrder.v1';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate a saved order against the tabs that actually exist.
 *
 * @param {unknown} saved      whatever came out of storage
 * @param {string[]} canonical the shipped DOM order (source of truth)
 * @returns {string[]} every canonical id exactly once, saved order first
 */
export function resolveTabOrder(saved, canonical) {
  const known = [];
  const seenCanonical = new Set();
  for (const id of Array.isArray(canonical) ? canonical : []) {
    if (!isNonEmptyString(id) || seenCanonical.has(id)) continue;
    seenCanonical.add(id);
    known.push(id);
  }
  if (!Array.isArray(saved)) return known;

  const out = [];
  const placed = new Set();
  for (const id of saved) {
    // Unknown / stale / non-string ids are ignored rather than rendered.
    if (!isNonEmptyString(id) || !seenCanonical.has(id) || placed.has(id)) continue;
    placed.add(id);
    out.push(id);
  }
  // Anything the saved order never mentioned is appended in canonical order.
  for (const id of known) if (!placed.has(id)) out.push(id);
  return out;
}

/**
 * Move one tab left (delta < 0) or right (delta > 0).
 * Out-of-range moves clamp to the ends; an unknown id is a no-op.
 * Always returns a NEW array — callers may hold the previous one.
 */
export function moveTab(order, viewId, delta) {
  const list = Array.isArray(order) ? order.slice() : [];
  const from = list.indexOf(viewId);
  const step = Number(delta);
  if (from === -1 || !Number.isFinite(step) || step === 0) return list;
  const to = Math.max(0, Math.min(list.length - 1, from + Math.trunc(step)));
  if (to === from) return list;
  list.splice(from, 1);
  list.splice(to, 0, viewId);
  return list;
}

/** Can this tab still move in that direction? Drives the arrow disabled state. */
export function canMove(order, viewId, delta) {
  const list = Array.isArray(order) ? order : [];
  const from = list.indexOf(viewId);
  if (from === -1) return false;
  return delta < 0 ? from > 0 : from < list.length - 1;
}

// ── storage (never throws) ───────────────────────────────────
// localStorage can be unavailable (private mode, disabled cookies, quota).
// A failure must cost the user their CUSTOM order, never the tab bar.
function safeStorage(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (err) {
    console.warn('[TAB-ORDER] localStorage unavailable:', (err && err.message) || err);
    return null;
  }
}

/** Read + validate in one step. Always returns a usable order. */
export function readTabOrder(canonical, storage) {
  const store = safeStorage(storage);
  if (!store) return resolveTabOrder(null, canonical);
  let parsed = null;
  try {
    const raw = store.getItem(TAB_ORDER_STORAGE_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch (err) {
    // Corrupt JSON or a blocked read — fall back to the shipped order and say so.
    console.warn('[TAB-ORDER] saved order unreadable, using default:', (err && err.message) || err);
    parsed = null;
  }
  return resolveTabOrder(parsed, canonical);
}

/** Persist an order. Returns true when it was actually stored. */
export function writeTabOrder(order, storage) {
  const store = safeStorage(storage);
  if (!store) return false;
  try {
    store.setItem(TAB_ORDER_STORAGE_KEY, JSON.stringify(Array.isArray(order) ? order : []));
    return true;
  } catch (err) {
    console.warn('[TAB-ORDER] could not save tab order:', (err && err.message) || err);
    return false;
  }
}

/** Forget the customization; the canonical DOM order takes over again. */
export function clearTabOrder(storage) {
  const store = safeStorage(storage);
  if (!store) return false;
  try {
    store.removeItem(TAB_ORDER_STORAGE_KEY);
    return true;
  } catch (err) {
    console.warn('[TAB-ORDER] could not reset tab order:', (err && err.message) || err);
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.__tabOrder = {
    TAB_ORDER_STORAGE_KEY,
    resolveTabOrder,
    moveTab,
    canMove,
    readTabOrder,
    writeTabOrder,
    clearTabOrder,
  };
}
