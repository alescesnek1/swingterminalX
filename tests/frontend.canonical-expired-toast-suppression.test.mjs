// Canonical STALE_EXPIRED: toast suppression + the /api/context circuit breaker.
//
// THE PRODUCTION SYMPTOM this closes: pressing REFRESH still produced an INFO
// card —
//
//   Canonical context stale
//   Using live /api/markets — published run expired (50h old).
//   /api/context
//
// The data path was already safe (the aged rows are refused and live
// /api/markets carries the read), but with MARKET_CONTEXT_COLLECT_ENABLED=false
// the published run only ever gets OLDER, so that card came back on every 60s
// tick forever. A toast that fires unconditionally is a toast the owner learns
// to dismiss — which is how a real outage gets missed. Two changes:
//
//   1. an EXPECTED expiry whose live fallback SUCCEEDS produces no toast at all
//      (not red, not info), no errors() entry and no raw JSON. It is recorded on
//      window.__canonicalStatus and logged once per trip.
//   2. a session circuit breaker: after an observed expiry /api/context is not
//      probed again for CANONICAL_EXPIRED_TTL_MS. A known-dead DB-backed source
//      is not worth a Postgres-backed request every minute.
//
// What must NOT get quieter: a genuine failure (401 / DB_UNAVAILABLE / network /
// parse), and an expiry whose live fallback ALSO fails.
//
// Layer 1: the breaker + diagnostics executed FOR REAL — the shipped source
//          region is evaluated against a mock window and driven by an injected
//          clock, so these are behaviour assertions, not string matches.
// Layer 2: source-level wiring for terminal.js, a classic <script> that cannot
//          be imported (the same approach as the repo's other frontend.* tests).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const js = read('apps/edge/public/js/terminal.js');
const html = read('apps/edge/public/index.html');
const toastSrc = read('apps/edge/public/js/toast.js');
const errorLogSrc = read('apps/edge/public/js/error-log.js');

// Strip line comments so an assertion about CODE cannot be satisfied by a
// comment that happens to name the same thing.
const code = (src) => src.replace(/^\s*\/\/.*$/gm, '');

function region(src, startNeedle, endNeedle) {
  const a = src.indexOf(startNeedle);
  assert.notEqual(a, -1, 'region start not found: ' + startNeedle);
  const b = src.indexOf(endNeedle, a + startNeedle.length);
  assert.notEqual(b, -1, 'region end not found: ' + endNeedle);
  return src.slice(a, b);
}

const fetchDataRegion = () => region(js, 'async function fetchData(opts)', '// ========== RENDER FUNCTIONS ==========');
const canonicalReadRegion = () => region(js, 'async function _fetchCanonicalMarkets(authHeaders)', 'async function fetchData(opts)');

// ─────────────────────────────────────────────────────────────
// Layer 1 — the REAL breaker, evaluated from the shipped source
// ─────────────────────────────────────────────────────────────

const BREAKER_SRC = region(
  js,
  'const CANONICAL_EXPIRED_TTL_MS =',
  '// ── end region: canonical-breaker',
);

// Runs the shipped breaker region against a mock window + console and hands back
// its functions. No network, no DOM, no timers — the clock is injected.
function loadBreaker() {
  const win = {};
  const logs = [];
  const fakeConsole = {
    log: (...a) => logs.push(['log', ...a]),
    warn: (...a) => logs.push(['warn', ...a]),
    error: (...a) => logs.push(['error', ...a]),
    debug: (...a) => logs.push(['debug', ...a]),
    info: (...a) => logs.push(['info', ...a]),
  };
  const tail = 'return { TTL: CANONICAL_EXPIRED_TTL_MS, open: _canonicalBreakerOpen,'
    + ' remaining: _canonicalBreakerRemainingMs, reason: _canonicalBreakerReason,'
    + ' trip: _canonicalBreakerTrip, reset: _canonicalBreakerReset, bump: _canonicalStatusBump };';
  const api = new Function('window', 'console', BREAKER_SRC + '\n' + tail)(win, fakeConsole);
  return { api, win, logs };
}

const NOW = 1_800_000_000_000;

test('the TTL is inside the required 10-30 minute window', () => {
  const { api } = loadBreaker();
  assert.ok(api.TTL >= 10 * 60 * 1000, 'TTL must be at least 10 min, got ' + api.TTL);
  assert.ok(api.TTL <= 30 * 60 * 1000, 'TTL must be at most 30 min, got ' + api.TTL);
  assert.equal(api.TTL, 15 * 60 * 1000);
});

test('the breaker starts CLOSED — a fresh session always probes once', () => {
  const { api } = loadBreaker();
  assert.equal(api.open(NOW), false);
  assert.equal(api.remaining(NOW), 0);
  assert.equal(api.reason(), null);
});

test('an observed expiry OPENS the breaker for exactly the TTL', () => {
  const { api } = loadBreaker();
  api.trip('published run expired (50h old)', 50 * 3600_000, NOW);
  assert.equal(api.open(NOW), true);
  assert.equal(api.open(NOW + api.TTL - 1), true, 'still open one ms before expiry');
  assert.equal(api.open(NOW + api.TTL), false, 'closed once the TTL elapses');
  assert.equal(api.remaining(NOW), api.TTL);
  assert.equal(api.reason(), 'published run expired (50h old)');
});

test('the trip logs ONCE per trip window, not once per tick', () => {
  const { api, logs } = loadBreaker();
  // Three observed expiries inside one window — e.g. the pathological case where
  // something probed anyway. Only the TRANSITION is logged, so a session left
  // open overnight cannot accumulate one line per minute.
  api.trip('published run expired (50h old)', null, NOW);
  api.trip('published run expired (50h old)', null, NOW + 60_000);
  api.trip('published run expired (50h old)', null, NOW + 120_000);
  const warns = logs.filter((l) => l[0] === 'warn');
  assert.equal(warns.length, 1, 'one transition line, got ' + warns.length);
  assert.match(String(warns[0][1]), /\[CANONICAL\] published run expired/);
  // ...and it names the active source and where the detail lives.
  assert.match(String(warns[0][1]), /live \/api\/markets is the active source/);
  assert.match(String(warns[0][1]), /__canonicalStatus/);
  // Each trip pushes the window out, so "no probe for a full TTL after the last
  // OBSERVED expiry" holds regardless of how the trips arrived.
  assert.equal(api.open(NOW + 120_000 + api.TTL - 1), true);
  assert.equal(api.open(NOW + 120_000 + api.TTL), false);
  // Once the window has actually elapsed the next expiry is a NEW transition and
  // is logged again — the real cadence is at most one line per TTL.
  api.trip('published run expired (51h old)', null, NOW + 120_000 + api.TTL);
  assert.equal(logs.filter((l) => l[0] === 'warn').length, 2);
});

test('the trip writes a small diagnostics record — no raw JSON, no payload', () => {
  const { api, win } = loadBreaker();
  api.trip('published run expired (50h old)', 180_000_000, NOW);
  const st = win.__canonicalStatus;
  assert.equal(st.state, 'STALE_EXPIRED');
  assert.equal(st.reason, 'published run expired (50h old)');
  assert.equal(st.activeSource, '/api/markets');
  assert.equal(st.breakerOpen, true);
  assert.equal(st.breakerTtlMs, api.TTL);
  assert.equal(st.breakerUntil, NOW + api.TTL);
  assert.equal(st.expiries, 1);
  // Every value stays a primitive, so nothing here can carry a response body,
  // a header bag or a credential into a log line.
  for (const [k, v] of Object.entries(st)) {
    assert.ok(v === null || ['string', 'number', 'boolean'].includes(typeof v), k + ' must stay primitive');
  }
  assert.doesNotMatch(JSON.stringify(st), /[Bb]earer|token|Authorization|\?force=/);
});

test('a HEALTHY read closes the breaker, so a re-enabled collector is picked up at once', () => {
  const { api } = loadBreaker();
  api.trip('published run expired (50h old)', null, NOW);
  assert.equal(api.open(NOW + 1000), true);
  api.reset();
  assert.equal(api.open(NOW + 1000), false, 'a good read must not be blocked by a stale trip');
  assert.equal(api.reason(), null);
});

test('the counters make the saved probes measurable, not merely claimed', () => {
  const { api, win } = loadBreaker();
  api.bump('probes');
  api.bump('skipped');
  api.bump('skipped');
  assert.equal(win.__canonicalStatus.probes, 1);
  assert.equal(win.__canonicalStatus.skipped, 2);
});

test('the breaker is memory-only — nothing is latched into web storage', () => {
  // A hard reload must always re-probe. sessionStorage/localStorage would
  // survive one, and would also outlive a re-enabled collector.
  assert.doesNotMatch(BREAKER_SRC, /sessionStorage|localStorage/);
  // And no timer keeps it alive: expiry is a clock comparison, not a callback.
  assert.doesNotMatch(BREAKER_SRC, /setTimeout|setInterval/);
});

// ─────────────────────────────────────────────────────────────
// Layer 2 — the wiring in fetchData
// ─────────────────────────────────────────────────────────────

test('STALE_EXPIRED + a working /api/markets fallback shows NO toast', () => {
  const degraded = code(region(js, 'if (_canonicalDegraded) {', '} else {'));
  assert.doesNotMatch(degraded, /Toast/, 'the degraded branch must not call Toast at all');
  assert.match(degraded, /_canonicalBreakerTrip\(_canonicalDegraded\.reason, _canonicalDegraded\.ageMs\);/);
  // The retired INFO card is gone from the whole bundle.
  assert.doesNotMatch(js, /Canonical context stale/);
  assert.doesNotMatch(js, /Toast\?\.info\?\.\('Canonical context/);
});

test('STALE_EXPIRED + a working fallback adds NO errors() entry', () => {
  const degraded = code(region(js, 'if (_canonicalDegraded) {', '} else {'));
  // Nothing on this path records one directly...
  assert.doesNotMatch(degraded, /ErrorLog/);
  // ...and there is no Toast call left that could forward one. (Mechanism, from
  // toast.js: only error/warn are forwarded to ErrorLog.)
  assert.match(toastSrc, /if \(\(level === 'error' \|\| level === 'warn'\) && !opts\.skipLog && window\.ErrorLog\)/);
  // The global fetch interceptor still exempts the server-declared expiry, so
  // the 503 itself cannot become a red entry once a minute either.
  assert.match(errorLogSrc, /headers\.get\('X-Context-Stale'\) === 'expired'/);
});

test('no toast anywhere in fetchData can carry raw JSON', () => {
  const fd = code(fetchDataRegion());
  // Every toast detail is built from a sanitized short reason or a status code.
  assert.match(fd, /const _safe = _safeHttpReason\(body\);/);
  assert.doesNotMatch(fd, /JSON\.stringify/);
  assert.doesNotMatch(fd, /body\.slice\(/);
  // The canonical read never throws the raw body either.
  assert.match(code(canonicalReadRegion()), /const safe = _safeHttpReason\(body\);/);
  assert.doesNotMatch(code(canonicalReadRegion()), /body\.slice\(0, 120\)/);
});

test('manual REFRESH cannot surface a canonical stale toast — it never probes /api/context', () => {
  const fd = code(fetchDataRegion());
  // force ⇒ the canonical read is skipped outright (unchanged P0 contract)...
  assert.match(fd, /const _canonical = _canonicalContextEnabled\(\) && !force && !_breakerOpen;/);
  // ...and the breaker-skip bookkeeping is also gated on !force, so a forced
  // refresh mutates no canonical state and reports nothing about it.
  assert.match(fd, /if \(_breakerOpen && !force && _canonicalContextEnabled\(\)\) \{/);
  // The only /api/context fetch in the bundle is inside _fetchCanonicalMarkets,
  // which a forced read cannot reach.
  const contextFetches = (code(js).match(/fetch\('\/api\/context'/g) || []).length;
  assert.equal(contextFetches, 1, 'exactly one /api/context call site');
  assert.ok(canonicalReadRegion().includes("fetch('/api/context'"), 'and it is the canonical read');
  // manualRefresh forces by default, so the click takes the force path.
  const mr = code(region(js, 'async function manualRefresh(opts)', 'async function _doRefreshCore(opts)'));
  assert.match(mr, /const force = !opts \|\| opts\.force !== false;/);
  assert.match(mr, /await doRefresh\(\{ force \}\);/);
});

test('the circuit breaker removes the repeat /api/context probes', () => {
  const fd = code(fetchDataRegion());
  assert.match(fd, /const _breakerOpen = _canonicalBreakerOpen\(\);/);
  // Skipping is counted, the time left on the breaker is recorded, and the last
  // observed verdict is carried forward so the RADAR panel keeps naming the real
  // active source.
  assert.match(fd, /_canonicalStatusBump\('skipped'\);/);
  assert.match(fd, /_canonicalStatusSet\(\{ breakerRemainingMs: _canonicalBreakerRemainingMs\(\) \}\);/);
  assert.match(fd, /_canonicalDegraded = \{ reason: _canonicalBreakerReason\(\) \|\| 'published run expired', ageMs: null, remembered: true \};/);
  assert.match(fd, /failed: true, degraded: true,/);
  // The probe itself is counted where it actually happens.
  assert.match(code(canonicalReadRegion()), /_canonicalStatusBump\('probes'\);/);
  // A healthy read closes the breaker inside the canonical read.
  assert.match(code(canonicalReadRegion()), /_canonicalBreakerReset\(\);/);
});

test('a breaker-skipped tick forces NO database read — it only removes one', () => {
  const skip = code(region(js, 'if (_breakerOpen && !force && _canonicalContextEnabled()) {', '  try {'));
  assert.doesNotMatch(skip, /fetch\(/, 'the skip path issues no request of its own');
  assert.doesNotMatch(skip, /\bforce\s*=/, 'and cannot escalate anything to a forced read');
  // /api/markets is what carries the tick, exactly as before.
  assert.match(code(fetchDataRegion()), /if \(!live\) \{/);
});

test('STALE_EXPIRED + a FAILED /api/markets still shows a red outage naming both', () => {
  const fd = code(fetchDataRegion());
  assert.match(fd, /window\.Toast\?\.error\('Market data fetch failed'/);
  assert.match(fd, /Canonical context is also unusable/);
  assert.match(fd, /no usable market source right now\./);
  assert.match(fd, /console\.error\('\[MARKET\] no usable source — canonical is stale AND \/api\/markets failed:'/);
  // On a breaker-skipped tick the verdict is REMEMBERED, not freshly probed —
  // and the message says so rather than implying a check that did not happen.
  assert.match(fd, /_canonicalDegraded\.remembered \? ', last observed this session' : ''/);
  // Short reason only: the raw upstream body never reaches the card.
  assert.match(fd, /HTTP \$\{r\.status\}\$\{_safe \? ' — ' \+ _safe : ''\}/);
});

test('a GENUINE /api/context failure keeps its visible red error and does NOT trip the breaker', () => {
  const genuineBranch = code(region(js, "console.warn('[CANONICAL] /api/context read failed", '// The canonical context is only ever assigned on success'));
  assert.match(genuineBranch, /window\.Toast\?\.error\?\.\('Canonical context unavailable'/);
  assert.doesNotMatch(genuineBranch, /_canonicalBreakerTrip/, 'a recoverable failure must keep probing');
  // Classification is unchanged: only a tagged degraded refusal takes the quiet
  // path, so 401 / DB_UNAVAILABLE / network / parse cannot borrow it.
  assert.match(code(fetchDataRegion()), /_canonicalDegraded = \(ce && ce\.canonicalDegraded === true\)/);
  assert.match(code(canonicalReadRegion()), /if \(r\.status === 503 && \(headerExpired \|\| \(parsed && parsed\.reason === 'STALE_EXPIRED'\)\)\)/);
});

test('/api/markets force refresh behaviour is unchanged', () => {
  const fd = code(fetchDataRegion());
  assert.match(fd, /const _mktUrl = force \? '\/api\/markets\?force=1' : '\/api\/markets';/);
  assert.match(fd, /_mktInit\.cache = 'reload';/);
  assert.match(fd, /_mktInit\.headers\['X-Force-Refresh'\] = '1';/);
  assert.match(fd, /const _forceOutcome = force/);
});

test('the cache token was bumped because frontend JS changed', () => {
  const tokens = [...new Set((html.match(/\?v=([0-9a-z]+)/g) || []).map((m) => m.slice(3)))];
  assert.equal(tokens.length, 1, 'one token for every asset, got ' + tokens.join(','));
  assert.equal(tokens[0], '6m6');
  assert.doesNotMatch(html, /\?v=6m5/);
  assert.ok(html.includes('js/terminal.js?v=6m6'));
});

// ─────────────────────────────────────────────────────────────
// Nothing outside the frontend UX moved
// ─────────────────────────────────────────────────────────────

test('no env, collector, gate, trading or Telegram path is touched', () => {
  // The server keeps expiring the context exactly as deployed.
  const ctx = read('netlify/functions/context.mjs');
  assert.match(ctx, /maxAgeMs: CONTEXT_HARD_MAX_AGE_MS, now,/);
  assert.match(ctx, /'X-Context-Stale': 'expired',/);
  assert.match(ctx, /export const REASON_STALE_EXPIRED = 'STALE_EXPIRED';/);
  // The Telegram watch guard is intact.
  const watch = read('netlify/functions/_personal-watch-notifier.mjs');
  assert.match(watch, /export const PERSONAL_WATCH_MAX_CONTEXT_AGE_MS = 30 \* 60 \* 1000;/);
  assert.match(watch, /return summary\(\{ ok: false, enabled: true, reason: REASON_CONTEXT_STALE_EXPIRED \}\);/);
  // The breaker's CODE reaches no gate, no order, no send and no env flag — it
  // reads a clock and writes a diagnostics object, nothing more.
  const breakerCode = code(BREAKER_SRC);
  for (const forbidden of ['ENTRY_READY', 'telegram', 'newOrder', 'placeOrder', 'arkham', 'MARKET_CONTEXT_COLLECT_ENABLED', 'fetch(']) {
    assert.ok(!breakerCode.toLowerCase().includes(forbidden.toLowerCase()), 'the breaker must not mention ' + forbidden);
  }
});
