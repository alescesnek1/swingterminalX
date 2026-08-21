// STALE_EXPIRED front-end UX.
//
// /api/context now answers `503 STALE_EXPIRED` when the newest published
// canonical run is past its hard freshness budget. That is the DESIGNED answer
// while the publishing collector is disabled, and the terminal handles it by
// reading live /api/markets instead. Production still made it look like a fault:
//
//   Canonical context unavailable
//   Falling back to /api/markets — HTTP 503 — {"ok":false,"reason":"STALE_EXPIRED",…}
//
// Two separate defects behind that one card:
//   1. the raw JSON body was pasted into the toast detail;
//   2. the GLOBAL fetch interceptor in js/error-log.js records every non-2xx,
//      so a 503 became a red errors() entry once per 60s tick — regardless of
//      which toast fired — burying the failures that log exists to surface.
//
// Layer 1: REAL behaviour — the error-log IIFE is executed against a mock
//          window, so the actual interceptor decides.
// Layer 2: source-level wiring for terminal.js, a classic <script>.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const errorLogSource = read('apps/edge/public/js/error-log.js');
const js = read('apps/edge/public/js/terminal.js');
const html = read('apps/edge/public/index.html');

const AGE_28H = 28 * 60 * 60 * 1000;
const STALE_BODY = JSON.stringify({
  ok: false, reason: 'STALE_EXPIRED', stale_expired: true,
  age_ms: AGE_28H, max_age_ms: 30 * 60 * 1000,
  observedAt: '2026-08-20T04:00:00.000Z',
  detail: 'the newest published canonical run is older than the hard freshness budget; use the live market read',
});

// ── the real error-log IIFE, against a mock window ───────────────────────────
function makeErrorLog({ response }) {
  const consoleCalls = [];
  const win = {
    location: { href: 'https://terminal.example/app', origin: 'https://terminal.example' },
    performance: { now: () => 1000 },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {},
    fetch: async () => response,
  };
  const fakeConsole = {
    log: (...a) => consoleCalls.push(['log', ...a]),
    warn: (...a) => consoleCalls.push(['warn', ...a]),
    error: (...a) => consoleCalls.push(['error', ...a]),
    table: () => {}, groupCollapsed: () => {}, groupEnd: () => {},
  };
  new Function('window', 'console', errorLogSource)(win, fakeConsole);
  return { win, consoleCalls };
}

const headers = (map) => ({ get: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null) });

const expiredContextResponse = () => ({
  ok: false, status: 503, statusText: 'Service Unavailable',
  url: 'https://terminal.example/api/context',
  headers: headers({ 'X-Context-Stale': 'expired', 'X-Context-Age-Ms': String(AGE_28H) }),
});

// ─────────────────────────────────────────────────────────────
// 1. errors() — the expected 503 is not a red failure
// ─────────────────────────────────────────────────────────────

test('a server-declared expired context 503 is NOT recorded as a failure', async () => {
  const { win } = makeErrorLog({ response: expiredContextResponse() });
  const res = await win.fetch('/api/context');
  assert.equal(res.status, 503, 'the response still reaches the caller untouched');
  assert.deepEqual(win.ErrorLog.entries(), [], 'no errors() entry for an expected degradation');
});

test('an ORDINARY 503 on the same endpoint is still recorded, red', async () => {
  // No X-Context-Stale header ⇒ a genuine outage ⇒ must still be a red entry.
  const { win } = makeErrorLog({
    response: {
      ok: false, status: 503, statusText: 'Service Unavailable',
      url: 'https://terminal.example/api/context',
      headers: headers({}),
    },
  });
  await win.fetch('/api/context');
  const entries = win.ErrorLog.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'error');
  assert.match(entries[0].title, /HTTP 503/);
});

test('the exemption is narrow: only that exact header value opts out', async () => {
  for (const value of ['', 'yes', 'true', 'stale', 'EXPIRED', 'expired ']) {
    const { win } = makeErrorLog({
      response: {
        ok: false, status: 503, url: 'https://terminal.example/api/context',
        headers: headers({ 'X-Context-Stale': value }),
      },
    });
    await win.fetch('/api/context');
    assert.equal(win.ErrorLog.entries().length, 1, `header "${value}" must NOT opt out of recording`);
  }
});

test('a response with unreadable headers fails towards visibility', async () => {
  const { win } = makeErrorLog({
    response: {
      ok: false, status: 503, url: 'https://terminal.example/api/context',
      headers: { get() { throw new Error('opaque'); } },
    },
  });
  await win.fetch('/api/context');
  assert.equal(win.ErrorLog.entries().length, 1, 'if we cannot tell, we record');
});

test('a response with no headers object at all is still recorded', async () => {
  const { win } = makeErrorLog({ response: { ok: false, status: 500, url: 'https://terminal.example/api/x' } });
  await win.fetch('/api/x');
  assert.equal(win.ErrorLog.entries().length, 1);
});

test('other endpoints cannot borrow the exemption for a different failure', async () => {
  // Same header, but a 4xx that is not the designed answer — still recorded.
  const { win } = makeErrorLog({
    response: { ok: false, status: 401, url: 'https://terminal.example/api/markets', headers: headers({}) },
  });
  await win.fetch('/api/markets');
  assert.equal(win.ErrorLog.entries().length, 1);
});

test('the interceptor still passes the response through unchanged', async () => {
  const response = expiredContextResponse();
  const { win } = makeErrorLog({ response });
  assert.equal(await win.fetch('/api/context'), response, 'identity, not a copy');
});

// ─────────────────────────────────────────────────────────────
// 2. no raw JSON in a toast — the sanitizer, run for real
// ─────────────────────────────────────────────────────────────

function loadSafeReason() {
  const start = js.indexOf('function _safeHttpReason(body)');
  assert.notEqual(start, -1, '_safeHttpReason must exist');
  let depth = 0;
  for (let i = js.indexOf('{', start); i < js.length; i += 1) {
    if (js[i] === '{') depth += 1;
    else if (js[i] === '}') { depth -= 1; if (depth === 0) return new Function(`${js.slice(start, i + 1)}\nreturn _safeHttpReason;`)(); }
  }
  throw new Error('unbalanced _safeHttpReason');
}

test('the sanitizer emits ONE short named field, never the raw JSON', () => {
  const safe = loadSafeReason();
  assert.equal(safe(STALE_BODY), 'STALE_EXPIRED');
  assert.equal(safe(JSON.stringify({ ok: false, reason: 'DB_UNAVAILABLE' })), 'DB_UNAVAILABLE');
  assert.equal(safe(JSON.stringify({ error: 'Unauthorized', detail: 'Malformed JWT' })), 'Unauthorized');
  // Nothing usable → nothing at all, rather than a blob.
  assert.equal(safe(JSON.stringify({ ok: false, age_ms: 1, nested: { a: 1 } })), null);
  assert.equal(safe('<html><body>502 Bad Gateway</body></html>'), null);
  assert.equal(safe(''), null);
  assert.equal(safe(undefined), null);
  // A short plain-text status line is still useful.
  assert.equal(safe('Bad Gateway'), 'Bad Gateway');
  // Never longer than 120 chars.
  assert.ok((safe(JSON.stringify({ reason: 'x'.repeat(500) })) || '').length <= 120);
  // And no JSON punctuation can survive into a message.
  for (const out of [safe(STALE_BODY), safe('Bad Gateway')]) {
    assert.doesNotMatch(String(out), /[{}"]/);
  }
});

test('the canonical read never throws the raw body', () => {
  const canonical = js.slice(js.indexOf('async function _fetchCanonicalMarkets'), js.indexOf('async function fetchData(opts)'));
  assert.match(canonical, /const safe = _safeHttpReason\(body\);/);
  assert.match(canonical, /throw new Error\('HTTP ' \+ r\.status \+ \(safe \? ' — ' \+ safe : ''\)\);/);
  // The old raw-body throw is gone.
  assert.doesNotMatch(canonical, /body\.slice\(0, 120\)/);
});

test('the market-failure toast carries a short reason, not the raw body', () => {
  const fd = js.slice(js.indexOf('async function fetchData(opts)'), js.indexOf('// ========== RENDER FUNCTIONS =========='));
  assert.match(fd, /const _safe = _safeHttpReason\(body\);/);
  assert.match(fd, /`HTTP \$\{r\.status\}\$\{_safe \? ' — ' \+ _safe : ''\}\.\$\{both\}`/);
  assert.doesNotMatch(fd, /body\.slice\(0,140\)/);
});

// ─────────────────────────────────────────────────────────────
// 3. classification and the two outcomes
// ─────────────────────────────────────────────────────────────

test('classification prefers the response HEADER, so a bad body still classifies', () => {
  const canonical = js.slice(js.indexOf('async function _fetchCanonicalMarkets'), js.indexOf('async function fetchData(opts)'));
  assert.match(canonical, /headerExpired = r\.headers\.get\('X-Context-Stale'\) === 'expired';/);
  assert.match(canonical, /if \(r\.status === 503 && \(headerExpired \|\| \(parsed && parsed\.reason === 'STALE_EXPIRED'\)\)\)/);
  // Age falls back to the header when the body has none.
  assert.match(canonical, /const ageMs = Number\.isFinite\(parsed\?\.age_ms\) \? parsed\.age_ms : headerAgeMs;/);
  assert.match(canonical, /err\.canonicalDegraded = true;/);
});

test('fallback SUCCEEDS ⇒ NO toast at all, just the tagged refusal', () => {
  // SUPERSEDED by fix/suppress-canonical-expired-toast. The INFO card this used
  // to require came back on every 60s tick and on every REFRESH, because the
  // published run only ages while the collector is off. An expected expiry with
  // a working live fallback is now silent in the UI; the circuit breaker logs it
  // once and records window.__canonicalStatus.
  assert.match(js, /err\.canonicalReason = 'published run expired'/);
  assert.doesNotMatch(js, /Canonical context stale/, 'the retired card must be gone from the bundle');
  // The degraded branch cannot reach ANY toast level.
  const degraded = js.slice(js.indexOf('if (_canonicalDegraded) {'), js.indexOf('} else {', js.indexOf('if (_canonicalDegraded) {')));
  assert.doesNotMatch(degraded.replace(/^\s*\/\/.*$/gm, ''), /Toast/);
  assert.doesNotMatch(degraded, /unavailable/i);
  assert.match(degraded, /_canonicalBreakerTrip\(/);
});

test('fallback FAILS ⇒ a real red outage naming both sources', () => {
  const fd = js.slice(js.indexOf('async function fetchData(opts)'), js.indexOf('// ========== RENDER FUNCTIONS =========='));
  assert.match(fd, /window\.Toast\?\.error\('Market data fetch failed'/);
  assert.match(fd, /Canonical context is also unusable \(\$\{_canonicalDegraded\.reason\}/);
  assert.match(fd, /no usable market source right now\./);
  assert.match(fd, /console\.error\('\[MARKET\] no usable source — canonical is stale AND \/api\/markets failed:'/);
});

test('a GENUINE canonical failure still gets the red unavailable toast', () => {
  assert.match(js, /window\.Toast\?\.error\?\.\('Canonical context unavailable'/);
  assert.match(js, /console\.warn\('\[CANONICAL\] \/api\/context read failed; falling back to \/api\/markets:'/);
});

test('the live /api/markets fallback itself is unchanged', () => {
  assert.match(js, /const _mktUrl = force \? '\/api\/markets\?force=1' : '\/api\/markets';/);
  // The canonical read gained a third skip condition — the circuit breaker —
  // which only ever REMOVES a probe. force still bypasses the store outright.
  assert.match(js, /const _canonical = _canonicalContextEnabled\(\) && !force && !_breakerOpen;/);
  assert.match(js, /if \(!live\) \{/);
});

// ─────────────────────────────────────────────────────────────
// 4. cache token + nothing else moved
// ─────────────────────────────────────────────────────────────

test('the cache token was bumped because frontend assets changed', () => {
  const tokens = [...new Set((html.match(/\?v=([0-9a-z]+)/g) || []).map((m) => m.slice(3)))];
  assert.equal(tokens.length, 1, 'one token for every asset, got ' + tokens.join(','));
  assert.equal(tokens[0], '6m6');
  assert.doesNotMatch(html, /\?v=6m4/);
  assert.doesNotMatch(html, /\?v=6m5/);
  for (const asset of ['js/terminal.js', 'js/error-log.js']) {
    assert.ok(html.includes(asset + '?v=6m6'), asset + ' must carry the bumped token');
  }
});

test('the personal-watch stale guard from the previous commit is intact', () => {
  const src = read('netlify/functions/_personal-watch-notifier.mjs');
  assert.match(src, /maxAgeMs: PERSONAL_WATCH_MAX_CONTEXT_AGE_MS, now: nowMs,/);
  assert.match(src, /export const PERSONAL_WATCH_MAX_CONTEXT_AGE_MS = 30 \* 60 \* 1000;/);
  assert.match(src, /return summary\(\{ ok: false, enabled: true, reason: REASON_CONTEXT_STALE_EXPIRED \}\);/);
});

test('no server behaviour, gate, trading or Telegram path is touched by this UX fix', () => {
  // /api/context still expires exactly as deployed.
  const ctx = read('netlify/functions/context.mjs');
  assert.match(ctx, /maxAgeMs: CONTEXT_HARD_MAX_AGE_MS, now,/);
  assert.match(ctx, /'X-Context-Stale': 'expired',/);
  // The two frontend files this fix touches contain no gate/trade/telegram code.
  for (const p of ['apps/edge/public/js/error-log.js']) {
    const src = read(p).replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['ENTRY_READY', 'telegram', 'newOrder', 'placeOrder']) {
      assert.ok(!src.toLowerCase().includes(forbidden.toLowerCase()), p + ' must not mention ' + forbidden);
    }
  }
});
