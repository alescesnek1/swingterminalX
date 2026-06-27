// ─────────────────────────────────────────────────────────────
// Swing Terminal — Freshness/source badge decision (pure, no DOM)
//
// Maps the markets freshness state to the top-bar source badge:
//   live           → green  LIVE
//   stale-memory   → amber  STALE   (last-good snapshot, upstream failed)
//   error / !ok    → red    OFFLINE (the fetch itself failed)
//   anything else  → muted  (initial LOADING, etc.)
//
// Extracted from terminal.js so the decision is importable and
// unit-testable (Phase 4). terminal.js (a classic <script>) calls this
// via window.freshnessBadge, and keeps a safe inline fallback so the
// badge still renders even if this module fails to load.
// ─────────────────────────────────────────────────────────────

export function freshnessBadge(fresh, src) {
  const f = fresh || {};
  const at = f.servedFrom ? ('source: ' + f.servedFrom) : null;
  if (src === 'ERROR' || f.ok === false) return { cls: 's-error', label: 'OFFLINE', title: at || 'fetch failed' };
  if (src === 'STALE' || f.stale === true) return { cls: 's-stale', label: 'STALE', title: at || 'stale snapshot' };
  if (src === 'LIVE') return { cls: 's-live', label: 'LIVE', title: at || 'live' };
  return { cls: 's-mock', label: src || '—', title: at || (src || '—') };
}

if (typeof window !== 'undefined') window.freshnessBadge = freshnessBadge;
