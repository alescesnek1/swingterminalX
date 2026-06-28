// ─────────────────────────────────────────────────────────────
// Swing Terminal — URL safety (pure, no DOM)
//
// Canonical implementation of the `_safeUrl` sink that terminal.js uses
// for every upstream-scraped href (GECKO highlight links, LiveFeed news
// article links). Extracted so the allow/deny behaviour is importable
// and unit-testable in isolation (terminal.js is a classic <script> that
// touches document/window at load and can't be imported under node:test).
//
// SECURITY: hrefs are scraped upstream (CoinGecko / Telegram), so they are
// attacker-influenced. Only `http(s)://…` and explicit relative paths
// (`/…`) are allowed through; `javascript:`, `data:`, `vbscript:`, `file:`,
// `ftp:`, `mailto:`, etc. are dropped to ''. The survivor is HTML-escaped
// so it can't break out of the `href="…"` attribute it is interpolated
// into. Same allowlist + five-char escape as terminal.js `_safeUrl`/`_esc`
// — this module is the canonical, unit-tested copy of that exact behaviour.
// ─────────────────────────────────────────────────────────────

// Exactly mirrors terminal.js `_safeUrl`. The leading-`/` branch uses a
// negative lookahead `(?!\/)` so a single-slash relative path (`/api/test`,
// `/coins/bitcoin`) is allowed but a PROTOCOL-RELATIVE URL (`//evil.com`,
// `///evil.com`) is rejected — those resolve to a foreign origin and must
// not become a clickable href. Bare relative refs like `./x` / `../x` never
// matched this allowlist and remain dropped (unchanged).
const URL_ALLOW = /^(https?:\/\/|\/(?!\/))/i;

export function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function safeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  // Allow only http(s) and explicit relative paths. Block javascript:,
  // data:, vbscript:, file:, ftp:, etc.
  if (URL_ALLOW.test(s)) return escHtml(s);
  return '';
}

if (typeof window !== 'undefined') window.__urlSafety = { safeUrl, escHtml };
