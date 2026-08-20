// Production reliability P0-P2 hotfix.
//
// P0  manual REFRESH could not produce fresh market data (force_outcome:null,
//     age_ms ~25.9h) because the click never reached /api/markets at all.
// P1  Supabase background token refresh spamming while native auth is active.
// P1  the foreground RADAR scanner-context POST feeding a stale book to the
//     server every 45s, with a throttle any UI action could reset.
// P1  the terminal booting before its deferred ES modules had run.
// P2  an automatic /api/analyze POST that could only ever return 400.
// P2  document type / quirks mode.
//
// Layer 1: REAL behaviour of the pure modules that make each decision.
// Layer 2: source-level wiring assertions on the shipped bundles, matching how
//          the repo's other frontend.* tests guard files that cannot be
//          imported (terminal.js is a classic <script>, markets.js is Deno).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  marketDataUnusable,
  marketFreshnessState,
  pct24hDisplay,
  ageAgoLabel,
  MARKET_MAX_AGE_MS,
  HARD_MAX_MARKET_AGE_MS,
} from '../apps/edge/public/js/freshness-badge.js';
import {
  marketDataUnusable as edgeMarketDataUnusable,
  HARD_MAX_MARKET_AGE_MS as EDGE_HARD_MAX_MARKET_AGE_MS,
  STALE_REASON_HARD_AGE,
  STALE_REASON_NO_TIMESTAMP,
} from '../apps/edge/netlify/edge-functions/lib/freshness.js';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const js = read('apps/edge/public/js/terminal.js');
const html = read('apps/edge/public/index.html');
const css = read('apps/edge/public/css/terminal.css');
const badgeSrc = read('apps/edge/public/js/freshness-badge.js');
const marketsSrc = read('apps/edge/netlify/edge-functions/markets.js');
const aiSrc = read('apps/edge/public/js/ai-analysis.js');
const authClientSrc = read('apps/edge/public/js/auth-client.js');

// Strip line comments, so an assertion about what the CODE does cannot be
// tripped by a comment that names the very thing the code must not do.
function code(src) {
  return src.replace(/^\s*\/\/.*$/gm, '');
}

const NOW = 1_700_000_000_000;
// The exact age the browser reported in production.
const PROD_STALE_AGE_MS = 93_382_647;

// Slice helpers so an assertion about one function cannot accidentally be
// satisfied by an unrelated part of an 800KB file.
function region(src, startNeedle, endNeedle) {
  const a = src.indexOf(startNeedle);
  assert.notEqual(a, -1, 'region start not found: ' + startNeedle);
  const b = src.indexOf(endNeedle, a + startNeedle.length);
  assert.notEqual(b, -1, 'region end not found: ' + endNeedle);
  return src.slice(a, b);
}

// ─────────────────────────────────────────────────────────────
// P0 · 1 — /api/markets exposes the freshness/force diagnostics
// ─────────────────────────────────────────────────────────────

test('P0: /api/markets exposes every freshness + force header to the browser', () => {
  // Without this, a cross-origin read can only see the six CORS-safelisted
  // headers, so `X-Force-Refresh` came back null in JS no matter what the edge
  // set — which is exactly how a forced click reported force_outcome: null.
  assert.match(marketsSrc, /'Access-Control-Expose-Headers': EXPOSED_DIAGNOSTIC_HEADERS/);
  const list = region(marketsSrc, 'const EXPOSED_DIAGNOSTIC_HEADERS = [', "].join(', ')");
  for (const h of [
    'X-Served-From', 'X-Stale', 'X-Stale-Reason', 'X-Generated-At', 'X-Age-Ms',
    'X-Force-Refresh', 'X-Force-Refresh-Retry-After-Ms', 'X-Upstream-Status',
  ]) {
    assert.ok(list.includes(`'${h}'`), 'must expose ' + h);
  }
});

test('P0: exposing headers does not weaken the origin or auth gate', () => {
  // Order is load-bearing: origin, then auth, then — and only then — force.
  const handler = region(marketsSrc, 'export default async function handler(request)', 'const tier = getTier(auth.user);');
  assert.ok(handler.indexOf('checkOrigin(request)') < handler.indexOf('await verifyAuth(request)'));
  assert.ok(marketsSrc.indexOf('const auth = await verifyAuth(request);') < marketsSrc.indexOf('const force = isForceRefreshRequest(request);'));
  // The expose list is diagnostics only — no credential is ever exposed.
  const list = region(marketsSrc, 'const EXPOSED_DIAGNOSTIC_HEADERS = [', "].join(', ')");
  assert.doesNotMatch(list, /Authorization|Cookie|Set-Cookie|Token|Key/i);
});

test('P0: a forced read reports an outcome on EVERY path, including failure', () => {
  // Success / throttled.
  assert.match(marketsSrc, /headers\['X-Force-Refresh'\] = forcedRebuild \? FORCE_OUTCOME_REBUILT : FORCE_OUTCOME_THROTTLED;/);
  // Upstream rebuild failed but a last-good body exists.
  assert.match(marketsSrc, /staleHeaders\['X-Force-Refresh'\] = FORCE_OUTCOME_UPSTREAM_FAILED;/);
  // Nothing to serve at all — the 502 still says what the force did.
  assert.match(marketsSrc, /if \(force\) failHeaders\['X-Force-Refresh'\] = FORCE_OUTCOME_UPSTREAM_FAILED;/);
  // ...and repeats it in the BODY, so a caller that cannot read headers still
  // learns the outcome.
  assert.match(marketsSrc, /forceOutcome: force \? FORCE_OUTCOME_UPSTREAM_FAILED : null/);
});

test('P0: the upstream diagnostic is a stable non-secret code', () => {
  assert.match(marketsSrc, /const UPSTREAM_STATUS_OK = 'ok';/);
  assert.match(marketsSrc, /const UPSTREAM_STATUS_REBUILD_FAILED = 'rebuild-failed-serving-last-good';/);
  assert.match(marketsSrc, /const UPSTREAM_STATUS_NO_SNAPSHOT = 'rebuild-failed-no-snapshot';/);
  // No URL, key or upstream body is ever put in a header.
  const codes = region(marketsSrc, 'const UPSTREAM_STATUS_OK', 'async function getQuoteIndex');
  assert.doesNotMatch(codes, /https?:\/\//);
});

// ─────────────────────────────────────────────────────────────
// P0 · 2 — a forced refresh can never report a null outcome
// ─────────────────────────────────────────────────────────────

test('P0: a forced refresh never yields force_outcome null', () => {
  const fd = region(js, 'async function fetchData(opts)', '// ========== RENDER FUNCTIONS ==========');
  // The header when we can read it; an explicit "we could not read it" code
  // when we cannot. Never null while `force` is true.
  assert.match(fd, /const _forceOutcome = force\s*\r?\n\s*\? \(_forceHdr \|\| \(_genAtRaw \? 'unknown-force-header-unreadable' : 'unknown-diagnostics-unavailable'\)\)\s*\r?\n\s*: \(_forceHdr \|\| null\);/);
  assert.match(fd, /forceOutcome: _forceOutcome,/);
  // ...and the missing-header case is called out where the operator looks.
  assert.match(fd, /X-Force-Refresh was not readable on the response — check Access-Control-Expose-Headers/);
});

test('P0: the canonical read states forced:false rather than leaving it absent', () => {
  const canonical = region(js, 'async function _fetchCanonicalMarkets(authHeaders)', 'async function fetchData(opts)');
  assert.match(canonical, /forced: false, forceOutcome: null/);
});

// ─────────────────────────────────────────────────────────────
// P0 · 3 — a forced refresh reaches /api/markets, not /api/context
// ─────────────────────────────────────────────────────────────

test('P0: a forced refresh bypasses the canonical /api/context store entirely', () => {
  // THE root cause. /api/context answered instantly and successfully with a
  // 25.9-hour-old published run, so the click never reached the only endpoint
  // that can rebuild from upstream.
  assert.match(js, /const _canonical = _canonicalContextEnabled\(\) && !force;/);
  assert.match(js, /forced read bypasses the canonical \/api\/context store/);
});

test('P0: force still wakes no database — /api/context is never given the flag', () => {
  const fd = region(js, 'async function fetchData(opts)', '// ========== RENDER FUNCTIONS ==========');
  assert.doesNotMatch(fd, /\/api\/context\?force/);
  assert.doesNotMatch(js, /\/api\/context[^\n]*X-Force-Refresh/);
  // Exactly one endpoint in the whole bundle is ever forced.
  const forcedUrls = js.match(/'\/api\/[a-z-]+\?force=1'/g) || [];
  assert.deepEqual(forcedUrls, ["'/api/markets?force=1'"]);
});

test('P0: no DB-heavy collector or price-history writer sits on the refresh path', () => {
  const core = region(js, 'async function _doRefreshCore(opts)', 'function _refreshSelectedDetail()');
  for (const forbidden of ['price-history-collect', 'market-context-collect', 'price-history-prune', 'admin-price-history']) {
    assert.ok(!core.includes(forbidden), 'refresh path must not touch ' + forbidden);
  }
  assert.doesNotMatch(js, /price-history[^\n]*force=1/);
});

test('P0: force is confined to the public market read — no DB module reads it', () => {
  for (const p of [
    'netlify/functions/_market-context-collector.mjs',
    'netlify/functions/_price-history-writer.mjs',
    'netlify/functions/_price-history.mjs',
    'netlify/functions/context.mjs',
  ]) {
    const src = read(p);
    assert.doesNotMatch(src, /isForceRefreshRequest|X-Force-Refresh/, p + ' must not honour a browser force flag');
  }
});

// ─────────────────────────────────────────────────────────────
// P0 · 4 — the HARD age gate (real behaviour)
// ─────────────────────────────────────────────────────────────

test('P0: the production 25.9h snapshot is UNUSABLE, not merely stale', () => {
  const fresh = { ok: true, servedFrom: 'canonical', stale: true, generatedAt: NOW - PROD_STALE_AGE_MS };
  assert.equal(marketFreshnessState(fresh, { now: NOW }).stale, true);
  const u = marketDataUnusable(fresh, { now: NOW });
  assert.equal(u.unusable, true);
  assert.match(u.reason, /26h old/);
  assert.match(u.reason, /hard limit/);
});

test('P0: the hard gate is a real ceiling, not a rename of the stale budget', () => {
  assert.ok(HARD_MAX_MARKET_AGE_MS > MARKET_MAX_AGE_MS);
  // Between the two budgets: stale (say so) but still usable (keep rendering).
  const between = { ok: true, generatedAt: NOW - (MARKET_MAX_AGE_MS + 60_000) };
  assert.equal(marketFreshnessState(between, { now: NOW }).stale, true);
  assert.equal(marketDataUnusable(between, { now: NOW }).unusable, false);
  // Just past the hard ceiling: unusable.
  assert.equal(marketDataUnusable({ ok: true, generatedAt: NOW - (HARD_MAX_MARKET_AGE_MS + 1) }, { now: NOW }).unusable, true);
  // Just inside it: usable.
  assert.equal(marketDataUnusable({ ok: true, generatedAt: NOW - (HARD_MAX_MARKET_AGE_MS - 1) }, { now: NOW }).unusable, false);
});

test('P0: the hard gate fails closed on every unknown', () => {
  assert.equal(marketDataUnusable({ ok: false, generatedAt: NOW }, { now: NOW }).unusable, true);
  assert.equal(marketDataUnusable({ ok: true, generatedAt: null }, { now: NOW }).unusable, true);
  assert.equal(marketDataUnusable({ ok: true }, { now: NOW }).unusable, true);
  assert.equal(marketDataUnusable(undefined, { now: NOW }).unusable, true);
  assert.equal(marketDataUnusable({ ok: true, generatedAt: 'yesterday' }, { now: NOW }).unusable, true);
});

test('P0: the browser and the edge agree on the hard ceiling', () => {
  assert.equal(HARD_MAX_MARKET_AGE_MS, EDGE_HARD_MAX_MARKET_AGE_MS);
  // ...and the edge helper reaches the same verdict on the same fixture.
  const e = edgeMarketDataUnusable({ generatedAt: NOW - PROD_STALE_AGE_MS, now: NOW });
  assert.equal(e.unusable, true);
  assert.equal(e.reason, STALE_REASON_HARD_AGE);
  assert.equal(edgeMarketDataUnusable({ generatedAt: null, now: NOW }).reason, STALE_REASON_NO_TIMESTAMP);
  assert.equal(edgeMarketDataUnusable({ generatedAt: NOW - 1_000, now: NOW }).unusable, false);
});

test('P0: a hard-stale snapshot renders MARKET DATA UNAVAILABLE, not a normal table', () => {
  assert.match(js, /function _applyMarketUnavailable\(state\)/);
  assert.match(js, /MARKET DATA UNAVAILABLE — /);
  assert.match(js, /are NOT tradeable\. Press REFRESH\./);
  // Badge is demoted from amber STALE to a red UNAVAILABLE.
  assert.match(js, /badge\.label = 'UNAVAILABLE';/);
  assert.match(js, /_applyMarketUnavailable\(uState\);/);
  // The banner exists in the shipped markup and ships hidden + empty.
  assert.match(html, /<div id="market-unavailable" class="market-unavailable-banner" role="alert" aria-live="assertive" hidden><\/div>/);
  // The table and the detail panel are visibly degraded, not left normal.
  assert.match(css, /\.market-unavailable-banner\{/);
  assert.match(css, /\.scanner-center\.market-unavailable #clist,/);
  assert.match(css, /#dcon\.data-unavailable/);
  // Crossing the line is logged once, at error level.
  assert.match(js, /console\.error\('\[MARKET\] data unavailable —'/);
});

test('P0: a dead canonical store is treated as a FAILED read, not as market truth', () => {
  const canonical = region(js, 'async function _fetchCanonicalMarkets(authHeaders)', 'async function fetchData(opts)');
  assert.match(canonical, /const _unusable = _marketDataUnusableFor\(/);
  assert.match(canonical, /throw new Error\('canonical snapshot unusable — ' \+ _unusable\.reason\)/);
  // The existing honest fallback then runs: visible failure + /api/markets.
  assert.match(js, /\[CANONICAL\] \/api\/context read failed; falling back to \/api\/markets:/);
  assert.match(js, /failed: true, failureReason: \(ce && ce\.message\) \|\| 'error'/);
});

test('P0: the inline hard gate fails closed if freshness-badge.js never loads', () => {
  const fallback = region(js, 'function _marketDataUnusableFor(generatedAtMs)', 'function _marketDataUnusableState()');
  assert.match(fallback, /if \(gen == null\) return \{ unusable: true/);
  assert.match(fallback, /if \(ageMs > HARD_MAX_MARKET_AGE_MS\) return \{ unusable: true/);
  // Same constant on both sides of the fallback.
  assert.match(js, /const HARD_MAX_MARKET_AGE_MS = 30 \* 60 \* 1000;/);
  assert.match(badgeSrc, /export const HARD_MAX_MARKET_AGE_MS = 30 \* 60_000;/);
});

// ─────────────────────────────────────────────────────────────
// P0 · 5 — number honesty is preserved (the VELVET case)
// ─────────────────────────────────────────────────────────────

test('P0: a stale VELVET-like +35.20% cannot render as a confident gain', () => {
  const velvet = { symbol: 'VELVET', _c24: 35.2, _c24Known: true };
  const state = marketFreshnessState({ ok: true, servedFrom: 'canonical', stale: true, generatedAt: NOW - PROD_STALE_AGE_MS }, { now: NOW });
  const shown = pct24hDisplay(velvet._c24, state);
  assert.equal(shown.text, 'STALE');
  assert.equal(shown.known, false);
  assert.notEqual(shown.cls, 'pos');
  assert.ok(!shown.text.includes('35'));
});

test('P0: unreported 24h is UNKNOWN and a genuine zero is still +0.00%', () => {
  const fresh = marketFreshnessState({ ok: true, servedFrom: 'live', stale: false, generatedAt: NOW - 5_000 }, { now: NOW });
  for (const v of [null, undefined, '', NaN, 'abc']) {
    assert.equal(pct24hDisplay(v, fresh).text, 'UNKNOWN', 'value ' + String(v));
    assert.equal(pct24hDisplay(v, fresh).known, false);
  }
  assert.equal(pct24hDisplay(0, fresh).text, '+0.00%');
  assert.equal(pct24hDisplay(0, fresh).known, true);
});

test('P0: 24h is never synthesized from the range or the current price', () => {
  const keys = region(js, '  c24: [', '  c7d: [');
  for (const forbidden of ['high_24h', 'low_24h', 'current_price', 'range']) {
    assert.ok(!keys.includes(forbidden), 'c24 must not read ' + forbidden);
  }
});

// ─────────────────────────────────────────────────────────────
// P1 · Supabase background refresh
// ─────────────────────────────────────────────────────────────

test('P1: Supabase auto-refresh is OFF when native auth is the active source', () => {
  assert.match(js, /\{ auth: \{ autoRefreshToken: false, persistSession: false, detectSessionInUrl: false \} \}/);
  assert.match(js, /const nativeActive = _nativeAuthActive\(\);/);
  assert.match(js, /background refresh DISABLED \(native auth is active\)/);
});

test('P1: a legacy Supabase-only user keeps the SDK defaults', () => {
  const init = region(js, '(async function _initSupabase()', 'window.__supabase = supabaseCl;');
  // The options object is applied ONLY on the native branch; the other branch
  // is the untouched two-argument call.
  assert.match(init, /const sbOptions = nativeActive\s*\r?\n\s*\? \{ auth:/);
  assert.match(init, /: undefined;/);
  assert.match(init, /: window\.supabase\.createClient\(cfg\.url, cfg\.key\);/);
  assert.match(js, /SDK defaults \(no native session found\)/);
});

test('P1: Supabase is not removed and legacy sign-in still works', () => {
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2/);
  assert.match(js, /window\.supabase\.createClient\(/);
  assert.match(js, /supabaseCl\.auth\.onAuthStateChange\(/);
  // The transparent Supabase fallback inside AuthClient is intact.
  assert.match(authClientSrc, /sb\.auth\.signInWithPassword\(\{ email, password \}\)/);
  assert.match(authClientSrc, /res\.status === 503 && body\.reason === 'NATIVE_AUTH_DISABLED'/);
});

test('P1: the stale-storage cleanup is narrow and only runs once native is confirmed', () => {
  assert.match(js, /const _SUPABASE_AUTH_KEY_RE = \/\^sb-\[A-Za-z0-9_-\]\+-auth-token\(\\\.\\d\+\)\?\$\//);
  // It is called only where native auth is established.
  const purgeCalls = js.match(/_purgeStaleSupabaseAuthStorage\(\)/g) || [];
  assert.equal(purgeCalls.length, 3, 'definition + native-boot call + native-onChange call');
  assert.match(js, /if \(nativeActive\) _purgeStaleSupabaseAuthStorage\(\);/);
  // Nothing else in localStorage is touched by it.
  const purge = region(js, 'function _purgeStaleSupabaseAuthStorage()', '(async function _initSupabase()');
  assert.match(purge, /if \(key && _SUPABASE_AUTH_KEY_RE\.test\(key\)\) doomed\.push\(key\);/);
  assert.doesNotMatch(purge, /localStorage\.clear\(\)/);
  assert.doesNotMatch(purge, /swing\.nativeAuth/);
  assert.doesNotMatch(purge, /terminalX\./);
});

test('P1: the native-auth probe reads storage and never writes it', () => {
  const probe = region(js, 'function _nativeAuthActive()', 'function _purgeStaleSupabaseAuthStorage()');
  assert.match(probe, /window\.AuthClient\.mode\(\) === 'native'/);
  assert.match(probe, /getItem\(_NATIVE_AUTH_STORAGE_KEY\)/);
  assert.doesNotMatch(probe, /setItem|removeItem/);
  // A stored session past its 8h device deadline is not "active": it is about
  // to be dropped, and this browser may legitimately fall back to Supabase.
  assert.match(probe, /if \(Number\.isFinite\(deadline\) && deadline <= Date\.now\(\)\) return false;/);
  // A legacy token with no deadline still counts as native (AuthClient's own
  // semantics) — missing must not read as expired.
  assert.match(probe, /parsed\.session\.sessionExpiresAt \? Date\.parse\(parsed\.session\.sessionExpiresAt\) : NaN/);
  // The mirrored key must match the auth module's real one.
  assert.match(js, /const _NATIVE_AUTH_STORAGE_KEY = 'swing\.nativeAuth\.v1';/);
  assert.match(authClientSrc, /const STORAGE_KEY = 'swing\.nativeAuth\.v1';/);
});

test('P1: native session restore is unchanged apart from WHEN it starts', () => {
  assert.match(js, /async function _restoreNativeSession\(\) \{/);
  assert.match(js, /await window\.AuthClient\.init\(\);/);
  assert.match(js, /title: 'Native session restore failed'/);
  // The native onChange handler still drives the authenticated UI.
  assert.match(js, /_applyAuthenticatedState\(\{ email: session\.email, tierHint: null \}\)/);
  // No auth decision moved into terminal.js.
  const probe = region(js, 'const _NATIVE_AUTH_STORAGE_KEY', '(async function _initSupabase()');
  assert.doesNotMatch(probe, /Bearer|Authorization|password/i);
});

// ─────────────────────────────────────────────────────────────
// P1 · RADAR foreground scanner-context post
// ─────────────────────────────────────────────────────────────

test('P1: the RADAR context post is blocked when market data is unavailable', () => {
  const push = region(js, 'function pushScannerContextToRadar(opts)', 'const fieldMappingDetected');
  assert.match(push, /const _unusable = _marketDataUnusableState\(\);/);
  assert.match(push, /if \(_unusable\.unusable\) \{\s*\r?\n\s*_noteRadarContextSkip\('market data unavailable/);
  // ...and when it is merely STALE, which is the state production was in.
  assert.match(push, /if \(_fresh\.stale\) \{/);
  assert.match(push, /market snapshot is STALE/);
  // The freshness gate runs BEFORE the throttle, so the reason is the real one.
  assert.ok(push.indexOf('_marketDataUnusableState()') < push.indexOf('RADAR_CONTEXT_MIN_INTERVAL_MS'));
});

test('P1: the skip reason is visible in the console and in diagnostics', () => {
  assert.match(js, /function _noteRadarContextSkip\(reason\)/);
  assert.match(js, /window\.__lastRadarContextPostStatus = 'skipped: ' \+ reason;/);
  assert.match(js, /console\.warn\('\[RADAR\] scanner context post skipped —', reason\)/);
});

test('P1: the throttle lives inside the post and no caller can reset it', () => {
  const push = region(js, 'function pushScannerContextToRadar(opts)', 'const fieldMappingDetected');
  assert.match(js, /const RADAR_CONTEXT_MIN_INTERVAL_MS = 45 \* 1000;/);
  assert.match(push, /if \(_lastRadarContextPostAt && \(now - _lastRadarContextPostAt\) < RADAR_CONTEXT_MIN_INTERVAL_MS\)/);
  // The old bypass — nulling the window timestamp on a view switch, which is
  // how entering RADAR forced an extra post — is gone. The one remaining
  // assignment is the module-level initializer, not a reset.
  const resets = js.match(/window\.__lastRadarContextPush = null/g) || [];
  assert.equal(resets.length, 1, 'only the top-level initializer may set it to null');
  assert.match(js, /^window\.__lastRadarContextPush = null;\r?$/m);
  assert.doesNotMatch(js, /window\.__lastRadarContextPush = null; pushScannerContextToRadar/);
  // ...and the caller no longer owns the timing decision at all.
  assert.doesNotMatch(js, /Date\.now\(\) - window\.__lastRadarContextPush > 45000/);
  assert.match(js, /pushScannerContextToRadar\(\{ trigger: 'refresh-tick' \}\)/);
  assert.match(js, /pushScannerContextToRadar\(\{ trigger: 'radar-view-entry' \}\)/);
});

test('P1: a manual REFRESH cannot spam the endpoint', () => {
  // manualRefresh → doRefresh → _doRefreshCore, and the only post call on that
  // path is the throttled+gated one.
  const core = code(region(js, 'async function _doRefreshCore(opts)', 'function _refreshSelectedDetail()'));
  const calls = core.match(/pushScannerContextToRadar\(/g) || [];
  assert.equal(calls.length, 1, 'exactly one post call on the refresh path');
  const mr = region(js, 'async function manualRefresh(opts)', 'async function _doRefreshCore(opts)');
  assert.doesNotMatch(mr, /pushScannerContextToRadar/);
  assert.doesNotMatch(mr, /_lastRadarContextPostAt/);
});

test('P1: the payload stays capped at the server limit', () => {
  assert.match(js, /const RADAR_CONTEXT_MAX_ROWS = 500;/);
  assert.match(js, /const rows = DATA\.slice\(0, RADAR_CONTEXT_MAX_ROWS\);/);
  // The server still enforces its own ceiling independently.
  assert.match(read('netlify/functions/bot.mjs'), /if \(rawCandidates\.length > 500\)/);
});

test('P1: no RADAR gate, ENTRY_READY rule or Telegram field is touched', () => {
  // Executable body only: the doc comment above it names the things it must
  // not touch, and naming them there is the whole point of that comment.
  const push = code(region(js, 'function pushScannerContextToRadar(opts)', 'const fieldMappingDetected'));
  for (const forbidden of ['ENTRY_READY', 'telegramEligible', 'entryReady', 'absorb', 'Absorb', 'sendTelegram']) {
    assert.ok(!push.includes(forbidden), 'the cost guard must not mention ' + forbidden);
  }
  // The server-side RADAR evaluation is untouched by this hotfix: it still
  // preserves first-pass Telegram eligibility and still reports the same
  // price-history contract.
  const bot = read('netlify/functions/bot.mjs');
  assert.match(bot, /candidate\.telegramEligible = baselineTelegramEligibility\.get\(candidate\.symbol\);/);
  assert.match(bot, /affectsTelegram: false,/);
  assert.match(bot, /telegramEligibilityPreservedFromBaseline: true,/);
  // ...and nothing in this hotfix leaked a browser-side flag into it.
  assert.doesNotMatch(bot, /RADAR_CONTEXT_MIN_INTERVAL_MS|_marketDataUnusableState|market-unavailable/);
});

test('P1: no DB-heavy collector is re-enabled by this hotfix', () => {
  const breaker = read('netlify/functions/_cost-breaker.mjs');
  // The gates still require the exact string 'true' and the master switch can
  // still only ever subtract work.
  assert.match(breaker, /return env\[flag\] === 'true';/);
  assert.match(breaker, /if \(masterKillSwitchEngaged\(env\)\) return false;/);
  // Price-history reads are still refused by default, so the RADAR refresh
  // this post triggers cannot open a Postgres round trip.
  assert.match(read('netlify/functions/_price-history.mjs'), /if \(!priceHistoryReadsAllowed\(deps\.env \|\| process\.env\)\) \{/);
});

// ─────────────────────────────────────────────────────────────
// P1 · boot order (tab-order module vs a fast native restore)
// ─────────────────────────────────────────────────────────────

test('P1: the native session restore waits for DOMContentLoaded while parsing', () => {
  assert.match(js, /if \(document\.readyState === 'loading'\) \{\s*\r?\n\s*document\.addEventListener\('DOMContentLoaded', _restoreNativeSession, \{ once: true \}\);\s*\r?\n\s*\} else \{\s*\r?\n\s*queueMicrotask\(_restoreNativeSession\);\s*\r?\n\s*\}/);
  // The bare IIFE that booted the app mid-parse is gone.
  assert.doesNotMatch(js, /\(async function _restoreNativeSession\(\) \{/);
  // The reason is written down so it is not undone by the next refactor.
  assert.match(js, /do not turn this back into a bare IIFE/);
  assert.match(js, /DEFAULT_COLUMN_ORDER/);
});

test('P1: tab-order.js is loaded before terminal.js and its API is awaited', () => {
  const tabOrderTag = html.indexOf('js/tab-order.js');
  const terminalTag = html.indexOf('js/terminal.js?v=');
  assert.ok(tabOrderTag !== -1 && terminalTag !== -1);
  assert.ok(tabOrderTag < terminalTag, 'tab-order.js must be declared before terminal.js');
  // tab-order.js is a module (deferred), so a boot during parse must retry
  // rather than conclude the module is missing.
  assert.match(html, /<script type="module" src="\/js\/tab-order\.js\?v=/);
  assert.match(js, /if \(document\.readyState === 'loading' && !_tabOrderRetryQueued\) \{/);
  assert.match(js, /document\.addEventListener\('DOMContentLoaded', \(\) => \{ initTabOrder\(\); \}, \{ once: true \}\)/);
  // The saved order is applied — and the control un-hidden — once it arrives.
  assert.match(js, /_applyTabOrder\(_currentTabOrder\(\)\);/);
  assert.match(js, /if \(tools\) tools\.hidden = false;/);
});

test('P1: the tab-order warning is only reached when the module is genuinely absent', () => {
  const init = region(js, 'function initTabOrder()', 'One delegated listener');
  const retryAt = init.indexOf('_tabOrderRetryQueued');
  const warnAt = init.indexOf('[TAB-ORDER] tab-order.js not loaded');
  assert.ok(retryAt !== -1 && warnAt !== -1);
  assert.ok(retryAt < warnAt, 'the retry must be attempted before the warning');
});

test('P1: no auth or session module was modified for the boot-order fix', () => {
  // auth-client.js still owns the whole token lifecycle; terminal.js only
  // decides when to ask it to restore.
  assert.match(authClientSrc, /async function init\(\)/);
  assert.match(authClientSrc, /window\.AuthClient = \{/);
  assert.doesNotMatch(authClientSrc, /DOMContentLoaded|queueMicrotask|__tabOrder/);
});

// ─────────────────────────────────────────────────────────────
// P2 · /api/analyze 400
// ─────────────────────────────────────────────────────────────

test('P2: the automatic always-400 news-scoring POST is gone', () => {
  // '__NEWS_SCORING__' could never pass normalizeBinanceSymbol (underscores
  // fail /^[A-Z0-9]+$/), so this endpoint answered 400 every five minutes.
  // Only the explanation of the removal may still name the sentinel.
  assert.doesNotMatch(code(js), /__NEWS_SCORING__/);
  assert.doesNotMatch(code(js), /_newsScoring/);
  const score = region(js, 'async _aiScoreNews(articles)', '_pushRawHeadlines(articles) {');
  assert.doesNotMatch(score, /fetch\('\/api\/analyze'/);
  assert.doesNotMatch(score, /Authorization/);
  // The feed still renders — via the heuristic that was always doing the work.
  assert.match(score, /this\._pushRawHeadlines\(articles\);/);
});

test('P2: the unavailability is stated once, not swallowed and not repeated', () => {
  assert.match(js, /if \(!this\.__aiScoringUnavailableLogged\) \{/);
  assert.match(js, /headline impact scoring is unavailable — \/api\/analyze has no batch-headline route/);
});

test('P2: the reason the sentinel could never work is still provable', () => {
  const binance = read('apps/edge/netlify/edge-functions/lib/binance.js');
  assert.match(binance, /if \(!\/\^\[A-Z0-9\]\+\$\/\.test\(stripped\)\) return null;/);
  assert.match(marketsSrc.length ? read('apps/edge/netlify/edge-functions/analyze.js') : '', /if \(!norm\) return jsonResponse\(request, \{ error: 'Invalid symbol format' \}, 400\);/);
});

test('P2: a user-triggered 400 is shown calmly and leaks nothing', () => {
  assert.match(aiSrc, /\} else if \(status === 400\) \{/);
  assert.match(aiSrc, /title = 'Analýza nepodporuje tento vstup';/);
  assert.match(aiSrc, /Scanner, RADAR i alerty běží dál\./);
  // Warn, not error: a rejected input is not an outage.
  assert.match(aiSrc, /\(status === 429 \|\| status === 401 \|\| status === 400\) \? 'warn'/);
  // Only the endpoint's own short reason is echoed — never a prompt, model
  // internal, key or raw payload.
  const branch = code(region(aiSrc, "} else if (status === 400) {", '} else if (status === 503) {'));
  assert.doesNotMatch(branch, /prompt|apiKey|api_key|payload|GEMINI|tried_models/i);
});

// ─────────────────────────────────────────────────────────────
// P2 · document type / quirks mode
// ─────────────────────────────────────────────────────────────

test('P2: index.html opens with a standards-mode doctype', () => {
  const raw = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url));
  // Allow only a UTF-8 BOM before the doctype — anything else (a stray blank
  // line, a comment, a byte of markup) drops the page into quirks mode.
  const bytes = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;
  const head = bytes.toString('utf8').slice(0, 40);
  assert.match(head, /^<!DOCTYPE html>/i, 'the first bytes must be the doctype');
  // Exactly one, and no legacy/quirks variant.
  assert.equal((html.match(/<!DOCTYPE/gi) || []).length, 1);
  assert.doesNotMatch(html, /<!DOCTYPE html PUBLIC/i);
});

test('P2: no generated document is written without a doctype', () => {
  // A srcdoc/document.write page without a doctype is the other way to land a
  // browser in quirks mode.
  assert.doesNotMatch(js, /document\.write\(/);
  assert.doesNotMatch(js, /srcdoc=/);
});

// ─────────────────────────────────────────────────────────────
// Cache-bust discipline
// ─────────────────────────────────────────────────────────────

test('the cache-bust token was bumped once, consistently, for this JS/CSS change', () => {
  const tokens = Array.from(new Set((html.match(/\?v=([0-9a-z]+)/g) || []).map((m) => m.slice(3))));
  assert.equal(tokens.length, 1, 'every versioned asset must carry the SAME token, got ' + tokens.join(','));
  assert.equal(tokens[0], '6m2');
  assert.doesNotMatch(html, /\?v=6m1/);
  // The files this hotfix actually changed are all versioned.
  for (const asset of ['js/terminal.js', 'js/freshness-badge.js', 'js/ai-analysis.js', 'css/terminal.css']) {
    assert.ok(html.includes(asset + '?v=6m2'), asset + ' must carry the bumped token');
  }
});

test('the age label used in the unavailable reason stays human', () => {
  assert.equal(ageAgoLabel(HARD_MAX_MARKET_AGE_MS), '30m');
  assert.equal(ageAgoLabel(PROD_STALE_AGE_MS), '26h');
  assert.equal(ageAgoLabel(null), '—');
});
