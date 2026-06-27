// Phase 1 — XSS regression for AI/briefing rendering.
//
// REAL behavior tests: ai-format.js is pure (no DOM), so we import the
// actual functions the app ships and assert on their output. This is the
// code path behind `contentEl.innerHTML = formatAnalysis(text)` in
// ai-analysis.js for both the AI analysis modal and the market briefing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeText, formatAnalysis } from '../apps/edge/public/js/ai-format.js';

test('escapeText neutralizes all five HTML-significant characters', () => {
  assert.equal(escapeText(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escapeText(null), '');
  assert.equal(escapeText(undefined), '');
});

test('formatAnalysis escapes a malicious AI string into inert text', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const out = formatAnalysis(evil);
  // The dangerous tag must be escaped, not present as a live element.
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img/);
  // No executable onerror attribute survives as live HTML.
  assert.doesNotMatch(out, /onerror=alert\(1\)>/);
});

test('formatAnalysis escapes an injected <script> from briefing text', () => {
  const out = formatAnalysis('Outlook: <script>fetch("//evil")</script> bullish');
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
});

test('formatAnalysis escapes an LLM-echoed malicious coin name', () => {
  // Coin universe is CoinGecko-scraped, so a hostile name can reach the
  // model and be echoed back into the analysis.
  const out = formatAnalysis('Top pick: "<svg/onload=alert(document.cookie)>" looks strong');
  assert.doesNotMatch(out, /<svg/);
  assert.match(out, /&lt;svg/);
});

test('formatAnalysis still renders legitimate markdown', () => {
  const out = formatAnalysis('# Title\n**bold** and *italic*\n- item one');
  assert.match(out, /<h3>Title<\/h3>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>italic<\/em>/);
  assert.match(out, /<li>item one<\/li>/);
});

test('formatAnalysis returns empty string for empty input (no stray <p>)', () => {
  assert.equal(formatAnalysis(''), '');
  assert.equal(formatAnalysis(null), '');
});

test('ai-analysis.js consumes the hardened formatter (no local raw copy)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../apps/edge/public/js/ai-analysis.js', import.meta.url), 'utf8');
  // Imports the pure module …
  assert.match(src, /import \{[^}]*formatAnalysis[^}]*\} from '\.\/ai-format\.js'/);
  // … and no longer defines its own (previously unescaped) versions.
  assert.doesNotMatch(src, /function formatAnalysis/);
  assert.doesNotMatch(src, /function escapeText/);
});
