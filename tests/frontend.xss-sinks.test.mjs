// Phase 1 — XSS sink guards for terminal.js render paths.
//
// terminal.js ships as a classic <script> (no exports, touches the DOM at
// load), so it can't be imported under node:test. These are deliberately
// scoped REGRESSION GUARDS that pin the specific upstream-data sinks to
// their escaping/URL-sanitizing helper, so a future edit can't silently
// drop the escape. (Behavioural escaping is proven in
// frontend.ai-format-xss.test.mjs against the pure module.)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const js = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

test('_esc escapes the five HTML-significant characters', () => {
  // Pin the escaper definition so its character set can't regress.
  assert.match(js, /function _esc\(s\)\s*\{[\s\S]*&amp;[\s\S]*&lt;[\s\S]*&gt;[\s\S]*&quot;[\s\S]*&#39;/);
});

test('_safeUrl only allows http(s) / relative and escapes the result', () => {
  assert.match(js, /function _safeUrl\(u\)/);
  assert.match(js, /\^\(https\?:\\\/\\\/\|\\\/\)/); // the /^(https?:\/\/|\/)/ allowlist
});

test('GECKO external link href is sanitized with _safeUrl, not raw _esc', () => {
  // The hardened sink: href routed through _safeUrl with a text fallback.
  assert.match(js, /const geckoHref = scannerId \? '' : _safeUrl\(item\.href\)/);
  assert.match(js, /else if \(geckoHref\) nameHtml = `<a href="\$\{geckoHref\}"/);
  // The old unsafe pattern (javascript: would survive _esc) must be gone.
  assert.doesNotMatch(js, /<a href="\$\{_esc\(item\.href\)\}"/);
});

test('GECKO coin name + symbol stay escaped', () => {
  assert.match(js, /<span class="gecko-name-text">\$\{_esc\(item\.name\)\}<\/span>/);
  assert.match(js, /<span class="gecko-sym">\$\{_esc\(item\.symbol\)\}<\/span>/);
});

test('LiveFeed news message is escaped before coin-linkifying', () => {
  // _linkifyCoins escapes the whole message first, then wraps known symbols.
  assert.match(js, /_linkifyCoins\(msg\)\s*\{\s*const escaped = _esc\(msg\)/);
});

test('LiveFeed news article href is sanitized with _safeUrl', () => {
  assert.match(js, /const safeUrl = _safeUrl\(e\.url\)/);
});

test('Scanner row coin name/symbol use pre-escaped values', () => {
  assert.match(js, /const escSym = _esc\(sym\)/);
  assert.match(js, /const escName = _esc\(name\)/);
  assert.match(js, /<span class="csym">\$\{escSym\}/);
  assert.match(js, /<span class="cnm">\$\{escName\}<\/span>/);
});
