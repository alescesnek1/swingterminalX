// Phase 2 — REAL behavior test for the upstream-href URL sanitizer.
//
// url-safety.js is pure (no DOM at import), so we import the actual shipped
// safeUrl()/escHtml() the app uses (window.__urlSafety, with a terminal.js
// inline fallback) and assert the allow/deny behaviour directly — instead of
// only grepping the regex out of terminal.js. This is the sink behind the
// GECKO external link href and the LiveFeed news article href.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { safeUrl, escHtml } from '../apps/edge/public/js/url-safety.js';

test('dangerous schemes are dropped to empty string (not clickable)', () => {
  for (const evil of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)  ',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://host/x',
    'mailto:a@b.c',
    'tel:+123',
    'about:blank',
  ]) {
    assert.equal(safeUrl(evil), '', `expected blocked: ${evil}`);
  }
});

test('http(s) and single-slash relative URLs are allowed through, HTML-escaped', () => {
  assert.equal(safeUrl('https://coingecko.com/en/coins/bitcoin'), 'https://coingecko.com/en/coins/bitcoin');
  assert.equal(safeUrl('http://t.me/excavonews/42'), 'http://t.me/excavonews/42');
  assert.equal(safeUrl('/scanner'), '/scanner');
  assert.equal(safeUrl('/api/test'), '/api/test');
  assert.equal(safeUrl('/coins/bitcoin'), '/coins/bitcoin');
});

test('protocol-relative URLs are blocked (resolve to a foreign origin)', () => {
  // //host and ///host would point at another origin entirely — drop them.
  assert.equal(safeUrl('//evil.com'), '');
  assert.equal(safeUrl('///evil.com'), '');
  assert.equal(safeUrl('  //evil.com/path  '), '');
  assert.equal(safeUrl('//evil.com/coins/bitcoin'), '');
});

test('bare relative refs (./ ../) remain dropped — allowlist unchanged', () => {
  // These never matched the http(s)/leading-slash allowlist; behaviour is
  // unchanged by the protocol-relative fix (documented, not newly allowed).
  assert.equal(safeUrl('./local'), '');
  assert.equal(safeUrl('../local'), '');
});

test('an allowed URL cannot break out of the href="…" attribute', () => {
  // A quote / angle bracket smuggled into an otherwise-allowed URL must be
  // escaped so it cannot close the attribute and inject markup.
  const out = safeUrl('https://x.com/"><img src=x onerror=alert(1)>');
  assert.doesNotMatch(out, /"><img/);
  assert.match(out, /&quot;&gt;&lt;img/);
});

test('empty / nullish / garbage inputs yield empty string', () => {
  assert.equal(safeUrl(''), '');
  assert.equal(safeUrl(null), '');
  assert.equal(safeUrl(undefined), '');
  assert.equal(safeUrl('not a url'), '');
  assert.equal(safeUrl('coingecko.com/bitcoin'), ''); // bare host, no scheme/slash → dropped
});

test('escHtml neutralizes the five HTML-significant characters', () => {
  assert.equal(escHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escHtml(null), '');
});

test('terminal.js keeps an identical inline fallback (sink cannot silently open up)', () => {
  // Defense-in-depth: if the module fails to load, the inline _safeUrl in
  // terminal.js must still enforce the same allowlist. Pin both together.
  const js = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
  assert.match(js, /window\.__urlSafety[\s\S]*?safeUrl\(u\)/);
  // inline /^(https?:\/\/|\/(?!\/))/i fallback — including the protocol-relative guard.
  assert.match(js, /\/\^\(https\?:\\\/\\\/\|\\\/\(\?!\\\/\)\)\/i\.test\(s\)/);
});
