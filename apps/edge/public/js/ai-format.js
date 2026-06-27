// ─────────────────────────────────────────────────────────────
// Swing Terminal — AI text formatting (pure, no DOM)
//
// Extracted from ai-analysis.js so the escaping + markdown logic is
// importable and unit-testable in isolation (the parent module touches
// document/window at load time and can't be imported under node:test).
//
// SECURITY: formatAnalysis() renders model/briefing output into the DOM
// via innerHTML. The text is upstream-controlled (Gemini can echo
// scraped coin names / prompt-injected content), so it MUST be HTML-
// escaped BEFORE any markdown is applied. escapeText handles that; the
// markdown regexes below only use '#', '*', '-' and newlines — none of
// which escapeText rewrites — so legitimate **bold** still renders while
// '<img src=x onerror=...>' becomes inert text.
// ─────────────────────────────────────────────────────────────

export function escapeText(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function formatAnalysis(text) {
  if (!text) return '';
  return escapeText(text)
    .replace(/^### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^## (.+)$/gm, '<h4>$1</h4>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>');
}
