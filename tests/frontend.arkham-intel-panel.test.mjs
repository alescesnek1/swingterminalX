// The Arkham Intel placeholder panel in the Cockpit RADAR focus card.
//
// Source-level assertions in the style of the neighbouring frontend tests
// (frontend.cockpit-radar-state.test.mjs), plus one real render: the panel HTML
// builder is extracted and executed against stubs, so "the placeholder renders
// without breaking coin detail" is actually exercised rather than asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');

test('the panel is mounted in the RADAR focus card, after the server verdict', () => {
  // `\s*` rather than `\n\s*`: the checked-out working copy has CRLF line endings
  // on Windows (repo autocrlf), and only whitespace can match between the two
  // slots, so this still asserts the mount is immediately after the server verdict.
  assert.match(terminalJs, /\$\{_cpRadarStateSlotHtml\(f\.symbol\)\}\s*\$\{_arkhamIntelSlotHtml\(f\.symbol\)\}/);
  assert.match(terminalJs, /function _arkhamIntelSlotHtml\(symbol\)/);
  assert.match(terminalJs, /id="cockpit-arkham-intel-slot"/);
});

test('the disabled copy is exactly what the owner asked to see', () => {
  assert.match(terminalJs, /Arkham Intel disabled — on-chain entity intelligence can be enabled after API access and cost caps are configured\./);
});

test('the panel declares itself advisory and denies every gate on screen', () => {
  assert.match(terminalJs, /Advisory only — does not affect ENTRY_READY, RADAR, strict Absorb, Reclaim, Telegram, alerts, Scanner ranking, or any order path\. Not investment advice\./);
});

test('the only network call is the explicit manual button — never a render or a timer', () => {
  assert.match(terminalJs, /id="cockpit-arkham-check"/);
  assert.match(terminalJs, /async function _checkArkhamIntel\(symbol\)/);
  assert.match(terminalJs, /\/api\/arkham-token-intel\?symbol=\$\{encodeURIComponent\(sym\)\}/);
  // The cockpit render path must not call the check.
  const renderStart = terminalJs.indexOf('function renderCockpit()');
  const renderBlock = terminalJs.slice(renderStart, renderStart + 4000);
  assert.equal(/_checkArkhamIntel/.test(renderBlock), false, 'renderCockpit must not trigger an Arkham request');
  // Exactly one call site, inside the click delegation.
  assert.equal((terminalJs.match(/_checkArkhamIntel\(/g) || []).length, 2, 'one definition + one click-triggered call');
});

test('the read is bounded, deduped, and every failure is both rendered and logged', () => {
  assert.match(terminalJs, /ARKHAM_INTEL_TIMEOUT_MS = 6000/);
  assert.match(terminalJs, /_arkhamIntelInFlight\.has\(sym\)/);
  assert.match(terminalJs, /_arkhamIntelInFlight\.delete\(sym\)/);
  assert.match(terminalJs, /new AbortController\(\)/);
  assert.match(terminalJs, /console\.warn\('\[ARKHAM-INTEL\] status read failed:'/);
  assert.match(terminalJs, /console\.warn\('\[ARKHAM-INTEL\] status read rejected:'/);
  assert.match(terminalJs, /window\.ErrorLog\?\.record\(\{[\s\S]{0,200}Arkham Intel status read/);
  // A failed read must never read as an absence of on-chain activity.
  assert.match(terminalJs, /failed read, not an absence of on-chain activity/);
});

test('the asset cache-bust token was bumped so returning users get the new code', () => {
  assert.equal(indexHtml.includes('?v=6l2'), false, 'the old token must not survive a js/css change');
  // 6l4 -> 6l5: the 8h native auth device sessions bumped the token again (see
  // tests/frontend.canonical-context-cutover.test.mjs for the running log).
  assert.match(indexHtml, /js\/terminal\.js\?v=6l6/);
  assert.match(indexHtml, /css\/terminal\.css\?v=6l6/);
});

test('the panel styles exist and no unrelated CSS was disturbed', () => {
  assert.match(terminalCss, /\.arkham-intel__card\s*\{/);
  assert.match(terminalCss, /\.arkham-intel__btn\s*\{/);
  // It reuses the existing insight card rather than inventing a parallel system.
  assert.match(terminalJs, /class="cp-radar-insight arkham-intel__card"/);
});

// ── Real render ────────────────────────────────────────────────────────────────
// Extract the three pure HTML builders and run them with the same helper stubs
// terminal.js provides, so a broken template string fails here instead of in the
// browser (where it would take the whole coin-detail card down with it).
function loadRenderers() {
  const start = terminalJs.indexOf('function _arkhamIntelFieldsHtml(intel)');
  const end = terminalJs.indexOf('function _arkhamIntelPaint(symbol, model)');
  assert.ok(start > 0 && end > start, 'the render functions are locatable');
  const source = terminalJs.slice(start, end);
  const factory = new Function('_esc', '_cpRadarStateRow', 'ARKHAM_INTEL_DISABLED_MSG', `
    ${source}
    return { _arkhamIntelFieldsHtml, _arkhamIntelInnerHtml };
  `);
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Must mirror the REAL _cpRadarStateRow (terminal.js), which escapes label,
  // value AND extra — a lenient stub here would hide a genuine injection.
  const row = (label, value, extra) => `<div class="cp-radar-insight__row"><span>${esc(label)}</span><b>${esc(value)}</b>${extra ? ` <span>${esc(extra)}</span>` : ''}</div>`;
  return factory(
    esc,
    row,
    'Arkham Intel disabled — on-chain entity intelligence can be enabled after API access and cost caps are configured.',
  );
}

test('the default placeholder renders, and renders as disabled', () => {
  const { _arkhamIntelInnerHtml } = loadRenderers();
  const html = _arkhamIntelInnerHtml({ state: 'placeholder' }, 'SOL');
  assert.match(html, /Arkham Intel/);
  assert.match(html, /Arkham Intel disabled/);
  assert.match(html, /No request has been made/);
  assert.match(html, /Not investment advice/);
  assert.match(html, /id="cockpit-arkham-check"/);
  // Every field is UNKNOWN, never 0 and never a directional word.
  assert.equal((html.match(/UNKNOWN/g) || []).length >= 8, true);
  assert.equal(/\b(BUY|SELL|BEARISH|BULLISH)\b/.test(html), false);
});

test('every backend status renders without throwing, and each names what is off', () => {
  const { _arkhamIntelInnerHtml } = loadRenderers();
  const cases = {
    DISABLED: /Arkham Intel disabled/,
    NOT_CONFIGURED: /no API key is configured/,
    COST_CAPPED: /daily credit cap is 0/,
    IDENTITY_UNRESOLVED: /CoinGecko pricing ID/,
    UPSTREAM_ERROR: /failed read, not an absence of on-chain activity/,
  };
  for (const [status, expected] of Object.entries(cases)) {
    const html = _arkhamIntelInnerHtml({ state: 'answered', body: { status, symbol: 'SOL', reason: 'ARKHAM_RATE_LIMITED', intel: null, missing: ['entity'] } }, 'SOL');
    assert.match(html, expected, `${status} must explain itself`);
    assert.match(html, /Not investment advice/);
  }
});

test('an OK response renders the intel it has and names what is missing', () => {
  const { _arkhamIntelInnerHtml } = loadRenderers();
  const html = _arkhamIntelInnerHtml({
    state: 'answered',
    body: {
      status: 'OK', symbol: 'SOL',
      intel: { entity: { name: 'Solana Foundation', type: 'fund' }, holderConcentration: null, exchangeNetflow: { inflowUsd: 2, outflowUsd: 1, netUsd: 1, windowHours: 24 }, whaleTransfers: null, counterparties: null, riskFlags: null, tokenFlowSummary: null, lastUpdated: '2026-08-18T00:00:00.000Z' },
      missing: ['holderConcentration', 'riskFlags'],
    },
  }, 'SOL');
  assert.match(html, /Solana Foundation/);
  assert.match(html, /Missing data: holderConcentration, riskFlags/);
  // The absent sections stay UNKNOWN rather than rendering as zero.
  assert.match(html, /Holder concentration<\/span><b>UNKNOWN/);
  assert.match(html, /Risk flags<\/span><b>UNKNOWN/);
});

test('the loading, auth and error states each render as their own distinct fact', () => {
  const { _arkhamIntelInnerHtml } = loadRenderers();
  assert.match(_arkhamIntelInnerHtml({ state: 'checking' }, 'SOL'), /Checking the Arkham Intel backend status/);
  assert.match(_arkhamIntelInnerHtml({ state: 'auth' }, 'SOL'), /Sign in to read/);
  const err = _arkhamIntelInnerHtml({ state: 'error', message: 'timed out after 6000ms' }, 'SOL');
  assert.match(err, /Arkham status read failed/);
  assert.match(err, /timed out after 6000ms/);
  assert.match(err, /failed read, not an absence of on-chain activity/);
});

test('rendering with no symbol and with hostile input neither throws nor injects', () => {
  const { _arkhamIntelInnerHtml } = loadRenderers();
  // No coin selected: the panel still paints and the button is disabled.
  const empty = _arkhamIntelInnerHtml({ state: 'placeholder' }, '');
  assert.match(empty, /id="cockpit-arkham-check" class="arkham-intel__btn" disabled/);

  // Hostile values from a backend response must be escaped, never executed.
  const hostile = _arkhamIntelInnerHtml({
    state: 'answered',
    body: { status: '<img src=x onerror=alert(1)>', symbol: '<script>bad()</script>', intel: { entity: { name: '<script>x</script>', type: 'fund' } }, missing: ['<b>x</b>'] },
  }, 'SOL');
  assert.equal(hostile.includes('<script>'), false);
  assert.equal(hostile.includes('onerror=alert'), false);
  assert.match(hostile, /&lt;script&gt;/);

  // A malformed model must not take the card down.
  for (const model of [null, undefined, {}, { state: 'nonsense' }, { state: 'answered' }, { state: 'answered', body: null }]) {
    assert.doesNotThrow(() => _arkhamIntelInnerHtml(model, 'SOL'));
  }
});
