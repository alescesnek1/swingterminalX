// Post-deploy freshness diagnostics cleanup.
//
// After the production reliability P0-P2 deploy the market force-refresh is
// confirmed fixed (rebuilt / ok / live). What was left was NOISE and a claim
// that had not been proved:
//
//   A) every boot logged AND red-toasted "[CANONICAL] /api/context read failed"
//      because the published run is ~27h old. That is the EXPECTED state of a
//      store whose publishing collector is deliberately off, and the terminal
//      has a working answer for it — so it must read as a degraded source, not
//      as a fault the owner has to triage. It must still be loud when there is
//      no working answer.
//   B) the RADAR scanner-context post needed to be PROVED to fire only on
//      fresh/live market data, with the freshness it fired on stated.
//   C) the browser's "quirks / backward compatibility" report needed to be
//      attributed: real document, or extension/iframe noise.
//
// Layer 1: REAL behaviour of the pure modules that make each decision.
// Layer 2: source-level wiring assertions on the shipped terminal.js bundle,
//          matching how the repo's other frontend.* tests guard a classic
//          <script> that cannot be imported.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  marketDataUnusable,
  marketFreshnessState,
  HARD_MAX_MARKET_AGE_MS,
  MARKET_MAX_AGE_MS,
} from '../apps/edge/public/js/freshness-badge.js';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const js = read('apps/edge/public/js/terminal.js');
const html = read('apps/edge/public/index.html');
const toastSrc = read('apps/edge/public/js/toast.js');
const errorLogSrc = read('apps/edge/public/js/error-log.js');

const NOW = 1_700_000_000_000;
const AGE_27H = 27 * 60 * 60 * 1000;

// Strip line comments so an assertion about CODE cannot be satisfied — or
// tripped — by a comment that happens to name the same thing.
function code(src) {
  return src.replace(/^\s*\/\/.*$/gm, '');
}

function region(src, startNeedle, endNeedle) {
  const a = src.indexOf(startNeedle);
  assert.notEqual(a, -1, 'region start not found: ' + startNeedle);
  const b = src.indexOf(endNeedle, a + startNeedle.length);
  assert.notEqual(b, -1, 'region end not found: ' + endNeedle);
  return src.slice(a, b);
}

const fetchDataRegion = () => region(js, 'async function fetchData(opts)', '// ========== RENDER FUNCTIONS ==========');
const pushRegion = () => region(js, 'function pushScannerContextToRadar(opts)', '} catch (err) {');

// ─────────────────────────────────────────────────────────────
// A · canonical hard-stale is an EXPECTED degraded source
// ─────────────────────────────────────────────────────────────

test('A: a 27h canonical run is refused — the aged rows are never used', () => {
  // The behaviour that must NOT change: it is still unusable, still refused.
  const u = marketDataUnusable({ ok: true, generatedAt: NOW - AGE_27H }, { now: NOW });
  assert.equal(u.unusable, true);
  assert.match(u.reason, /hard limit/);
  const canonical = region(js, 'async function _fetchCanonicalMarkets(authHeaders)', 'async function fetchData(opts)');
  assert.match(canonical, /if \(_unusable\.unusable\) \{/);
  assert.match(canonical, /throw err;/);
});

test('A: the refusal is TAGGED so the caller can tell expected from broken', () => {
  const canonical = region(js, 'async function _fetchCanonicalMarkets(authHeaders)', 'async function fetchData(opts)');
  assert.match(canonical, /err\.canonicalDegraded = true;/);
  assert.match(canonical, /err\.canonicalReason = _unusable\.reason;/);
  assert.match(canonical, /err\.canonicalAgeMs = _unusable\.ageMs;/);
});

test('A: an expected hard-stale canonical read produces NO error toast', () => {
  const fd = code(fetchDataRegion());
  // The branch exists and is chosen by the tag, not by string matching.
  assert.match(fd, /_canonicalDegraded = \(ce && ce\.canonicalDegraded === true\)/);
  // INFO, with the required wording.
  assert.match(fd, /window\.Toast\?\.info\?\.\('Canonical context stale', `Using live \/api\/markets — \$\{_canonicalDegraded\.reason\}\.`/);
  assert.match(fd, /\[CANONICAL\] context stale; using live \/api\/markets/);
  // ...and the error toast is now only reachable from the ELSE branch.
  const degradedBranch = region(js, 'if (_canonicalDegraded) {', '} else {');
  assert.doesNotMatch(degradedBranch, /Toast\?\.error/);
});

test('A: an expected hard-stale fallback creates NO ErrorLog failure entry', () => {
  // Mechanism, proved from toast.js: only error/warn are forwarded to ErrorLog,
  // so Toast.info cannot add a failure to errors().
  assert.match(toastSrc, /if \(\(level === 'error' \|\| level === 'warn'\) && !opts\.skipLog && window\.ErrorLog\)/);
  assert.match(toastSrc, /info:\s*\(title, detail, opts\) => push\('info',\s*title, detail, opts\)/);
  // And ErrorLog itself only knows error/warn, so there is no "info failure".
  assert.match(errorLogSrc, /level: input && input\.level === 'warn' \? 'warn' : 'error'/);
  // The degraded path must not call ErrorLog.record directly either.
  const degradedBranch = region(js, 'if (_canonicalDegraded) {', '} else {');
  assert.doesNotMatch(degradedBranch, /ErrorLog/);
});

test('A: a GENUINE canonical failure keeps its visible error', () => {
  const fd = code(fetchDataRegion());
  assert.match(fd, /console\.warn\('\[CANONICAL\] \/api\/context read failed; falling back to \/api\/markets:'/);
  assert.match(fd, /window\.Toast\?\.error\?\.\('Canonical context unavailable'/);
});

test('A: canonical stale AND a failed live read stays LOUD', () => {
  const fd = code(fetchDataRegion());
  // The live-read failure toast names the combination outright.
  assert.match(fd, /const both = _canonicalDegraded/);
  assert.match(fd, /Canonical context is also unusable \(\$\{_canonicalDegraded\.reason\}\) — no usable market source right now\./);
  assert.match(fd, /window\.Toast\?\.error\('Market data fetch failed'/);
  assert.match(fd, /console\.error\('\[MARKET\] no usable source — canonical is stale AND \/api\/markets failed:'/);
});

test('A: the RADAR panel words a stale run differently from a broken one', () => {
  assert.match(js, /\/api\/context is STALE — \$\{window\.__canonicalContext\.failureReason \|\| 'aged run'\}; the live \/api\/markets feed is in use/);
  assert.match(js, /\/api\/context failed — \$\{window\.__canonicalContext\.failureReason \|\| 'error'\}/);
  // ...and the canonical rows are refused in BOTH cases.
  assert.match(js, /failed: true,/);
  assert.match(js, /degraded: !!_canonicalDegraded,/);
});

test('A: downgrading the notice did not touch what the scanner actually reads', () => {
  const fd = code(fetchDataRegion());
  // The live read is still the thing that feeds the scanner after a refusal.
  assert.match(fd, /const _mktUrl = force \? '\/api\/markets\?force=1' : '\/api\/markets';/);
  // A forced read still never consults the canonical store.
  assert.match(fd, /const _canonical = _canonicalContextEnabled\(\) && !force;/);
});

// ─────────────────────────────────────────────────────────────
// B · the RADAR context post fires only on fresh/live data
// ─────────────────────────────────────────────────────────────

test('B: every blocking condition is checked, separately and by name', () => {
  const push = code(pushRegion());
  const required = [
    [/if \(!_snapshot\)/, 'no market read has completed yet'],
    [/if \(_snapshot\.ok === false\)/, 'the market read failed'],
    [/if \(!Number\.isFinite\(_snapshot\.generatedAt\)\)/, 'no generatedAt'],
    [/if \(_unusable\.unusable\)/, 'hard-stale / unavailable'],
    [/if \(_fresh\.stale\)/, 'soft-stale'],
  ];
  for (const [re, label] of required) {
    assert.match(push, re, 'missing gate: ' + label);
  }
  // Each one refuses by returning — none of them merely warns and continues.
  const returns = (push.match(/_noteRadarContextSkip\([^\n]*\);\s*\r?\n?\s*return;|_noteRadarContextSkip\([^\n]*\); return;/g) || []);
  assert.ok(returns.length >= 5, 'every gate must return, got ' + returns.length);
});

test('B: freshness is read in the same tick as the post, before the throttle', () => {
  const push = code(pushRegion());
  const snapshotAt = push.indexOf('const _snapshot = window.__marketsFreshness;');
  const throttleAt = push.indexOf('RADAR_CONTEXT_MIN_INTERVAL_MS');
  const postAt = push.indexOf("_fleetFetch('POST', '/api/bot/radar-context'");
  assert.ok(snapshotAt !== -1 && throttleAt !== -1 && postAt !== -1);
  assert.ok(snapshotAt < throttleAt, 'freshness must be judged before the throttle');
  assert.ok(throttleAt < postAt, 'the throttle must still gate the post');
  // Nothing awaits between the freshness read and the post, so the verdict
  // cannot go stale in between.
  const between = push.slice(snapshotAt, postAt);
  assert.doesNotMatch(between, /\bawait\b/);
});

test('B: the throttle was kept, not reduced', () => {
  assert.match(js, /const RADAR_CONTEXT_MIN_INTERVAL_MS = 45 \* 1000;/);
  const push = code(pushRegion());
  assert.match(push, /if \(_lastRadarContextPostAt && \(now - _lastRadarContextPostAt\) < RADAR_CONTEXT_MIN_INTERVAL_MS\)/);
  // No caller may reset the clock.
  assert.doesNotMatch(js, /window\.__lastRadarContextPush = null; pushScannerContextToRadar/);
  assert.doesNotMatch(js, /Date\.now\(\) - window\.__lastRadarContextPush > 45000/);
});

test('B: a post states the freshness it was allowed on — source, age, rows', () => {
  const push = code(pushRegion());
  assert.match(push, /const _postProof = \{/);
  assert.match(push, /market_fresh: true,/);
  assert.match(push, /source: _snapshot\.servedFrom \|\| 'unknown',/);
  assert.match(push, /age_ms: _fresh\.ageMs,/);
  assert.match(push, /rows: payload\.length,/);
  assert.match(push, /generated_at: new Date\(_snapshot\.generatedAt\)\.toISOString\(\),/);
  assert.match(push, /console\.log\('\[RADAR\] posting scanner context to \/api\/bot\/radar-context', _postProof\)/);
  // The completion line carries the same facts, so a stored count is never
  // reported without the data it came from.
  assert.match(push, /console\.log\('\[RADAR\] scanner context post successful', \{ stored: res\.stored, sent: _postProof\.rows, source: _postProof\.source, age_ms: _postProof\.age_ms \}\)/);
});

test('B: a skip states its reason and is readable from the page', () => {
  assert.match(js, /window\.__lastRadarContextPostStatus = 'skipped: ' \+ reason;/);
  assert.match(js, /window\.__lastRadarContextPostProof = \{ market_fresh: false, skipped_reason: reason \};/);
  assert.match(js, /console\.warn\('\[RADAR\] scanner context post skipped —', reason\)/);
});

test('B: the reasons are non-secret status text only', () => {
  const push = pushRegion();
  const reasons = [...push.matchAll(/_noteRadarContextSkip\(([^;]*)\);/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 5, 'expected a named reason per gate');
  for (const r of reasons) {
    assert.doesNotMatch(r, /token|Bearer|Authorization|email|chat_id|apiKey|secret/i, 'reason must stay non-secret: ' + r);
  }
});

test('B: the real gate verdicts — fresh posts, everything else blocks', () => {
  // The pure module is what pushScannerContextToRadar consults, so these are
  // the verdicts the gate actually acts on.
  const live = { ok: true, servedFrom: 'live', stale: false, generatedAt: NOW - 5_000 };
  assert.equal(marketDataUnusable(live, { now: NOW }).unusable, false);
  assert.equal(marketFreshnessState(live, { now: NOW }).stale, false);      // → POSTS

  const softStale = { ok: true, servedFrom: 'live', stale: false, generatedAt: NOW - (MARKET_MAX_AGE_MS + 1) };
  assert.equal(marketFreshnessState(softStale, { now: NOW }).stale, true);  // → BLOCKED

  const hardStale = { ok: true, servedFrom: 'canonical', stale: true, generatedAt: NOW - AGE_27H };
  assert.equal(marketDataUnusable(hardStale, { now: NOW }).unusable, true); // → BLOCKED

  const failed = { ok: false, servedFrom: 'error', stale: true, generatedAt: null };
  assert.equal(marketDataUnusable(failed, { now: NOW }).unusable, true);    // → BLOCKED

  const noStamp = { ok: true, servedFrom: 'live', stale: false, generatedAt: null };
  assert.equal(marketDataUnusable(noStamp, { now: NOW }).unusable, true);   // → BLOCKED

  // A degraded canonical WITH a working live replacement is the posting case:
  // __marketsFreshness describes the replacement, judged on its own age.
  assert.equal(marketDataUnusable(live, { now: NOW }).unusable, false);
  assert.ok(HARD_MAX_MARKET_AGE_MS > MARKET_MAX_AGE_MS);
});

test('B: no RADAR gate, ENTRY_READY rule, Telegram field or order path is touched', () => {
  const push = code(pushRegion());
  for (const forbidden of ['ENTRY_READY', 'entryReady', 'telegramEligible', 'sendTelegram', 'newOrder', 'createOrder', 'placeOrder']) {
    assert.ok(!push.includes(forbidden), 'the post gate must not mention ' + forbidden);
  }
  // The server side is untouched by this branch and still preserves first-pass
  // Telegram eligibility.
  const bot = read('netlify/functions/bot.mjs');
  assert.match(bot, /candidate\.telegramEligible = baselineTelegramEligibility\.get\(candidate\.symbol\);/);
  assert.match(bot, /affectsTelegram: false,/);
  assert.doesNotMatch(bot, /_postProof|_canonicalDegraded|canonicalDegraded/);
  // The row cap and the server's own ceiling are unchanged.
  assert.match(js, /const RADAR_CONTEXT_MAX_ROWS = 500;/);
  assert.match(bot, /if \(rawCandidates\.length > 500\)/);
});

test('B: no DB collector is re-enabled and no price-history write is added', () => {
  const breaker = read('netlify/functions/_cost-breaker.mjs');
  assert.match(breaker, /return env\[flag\] === 'true';/);
  assert.match(breaker, /if \(masterKillSwitchEngaged\(env\)\) return false;/);
  assert.match(read('netlify/functions/_price-history.mjs'), /if \(!priceHistoryReadsAllowed\(deps\.env \|\| process\.env\)\) \{/);
  assert.doesNotMatch(code(js), /price-history-collect|market-context-collect/);
});

// ─────────────────────────────────────────────────────────────
// C · document type / quirks mode
// ─────────────────────────────────────────────────────────────

test('C: index.html opens with a standards-mode doctype', () => {
  const raw = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url));
  // Only a UTF-8 BOM may precede it; anything else drops the page into quirks.
  const bytes = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;
  assert.match(bytes.toString('utf8').slice(0, 40), /^<!DOCTYPE html>/i);
  assert.equal((html.match(/<!DOCTYPE/gi) || []).length, 1);
  assert.doesNotMatch(html, /<!DOCTYPE html PUBLIC/i);
  assert.doesNotMatch(html, /<!DOCTYPE html SYSTEM/i);
});

test('C: nothing in the app can create a second, doctype-less document', () => {
  // These are the only ways this app could put a browser in BackCompat:
  // a written document, an iframe srcdoc, or an about:blank frame it fills in.
  const src = code(js);
  assert.doesNotMatch(src, /document\.write\(/);
  assert.doesNotMatch(src, /document\.open\(/);
  assert.doesNotMatch(src, /srcdoc/);
  assert.doesNotMatch(html, /srcdoc/);
  // MEASURED, not assumed: production at f1eefde reports
  // document.compatMode === 'CSS1Compat' (standards mode). The browser's
  // "quirks / backward compatibility" report therefore does not come from this
  // document — it is another frame on the page, i.e. an extension or an
  // embedded third-party iframe. No code change is warranted; this test is what
  // keeps the conclusion true.
  assert.match(html, /^<!DOCTYPE html>/);
});

// ─────────────────────────────────────────────────────────────
// Cache-bust discipline
// ─────────────────────────────────────────────────────────────

test('the cache-bust token was bumped once, consistently, for this JS change', () => {
  const tokens = [...new Set((html.match(/\?v=([0-9a-z]+)/g) || []).map((m) => m.slice(3)))];
  assert.equal(tokens.length, 1, 'every versioned asset must carry the SAME token, got ' + tokens.join(','));
  assert.equal(tokens[0], '6m3');
  assert.doesNotMatch(html, /\?v=6m2/);
  assert.ok(html.includes('js/terminal.js?v=6m3'), 'terminal.js changed, so it must carry the bumped token');
});

// ─────────────────────────────────────────────────────────────
// B · executable proof — the REAL gate, run against real inputs
//
// The assertions above prove the gate is WRITTEN correctly. This runs it.
// pushScannerContextToRadar is lifted out of the bundle verbatim and executed
// with stubbed collaborators, so a future edit that loosens a gate fails here
// rather than in production.
// ─────────────────────────────────────────────────────────────

function extractFunction(name) {
  const start = js.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  for (let i = js.indexOf('{', start); i < js.length; i += 1) {
    if (js[i] === '{') depth += 1;
    else if (js[i] === '}') { depth -= 1; if (depth === 0) return js.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// Runs the real function once and reports what it did.
function runPush({ rows = 3, freshness, unusable, stale, lastPostAt = 0, now = NOW }) {
  const posts = [];
  const skips = [];
  const win = { __marketsFreshness: freshness };
  const harness = new Function('win', 'posts', 'skips', 'rowCount', 'unusableState', 'freshState', 'lastPostAt', 'nowMs', `
    const window = win;
    const DATA = Array.from({ length: rowCount }, (_, i) => ({ symbol: 'C' + i, pair: 'C' + i + 'USDT', current_price: 1, total_volume: 1 }));
    const RADAR_CONTEXT_MIN_INTERVAL_MS = 45 * 1000;
    const RADAR_CONTEXT_MAX_ROWS = 500;
    let _lastRadarContextPostAt = lastPostAt;
    const Date_now = () => nowMs;
    function _noteRadarContextSkip(reason) {
      skips.push(reason);
      window.__lastRadarContextPostStatus = 'skipped: ' + reason;
      window.__lastRadarContextPostProof = { market_fresh: false, skipped_reason: reason };
    }
    function _marketDataUnusableState() { return unusableState; }
    function _marketFreshnessState() { return freshState; }
    function _radarFiniteOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
    function _sigOf() { return null; }
    function _radarDetectScannerFields() { return []; }
    function _fleetFetch(method, path, body) { posts.push({ method, path, rows: body.scannerCandidates.length }); return Promise.resolve({ stored: body.scannerCandidates.length }); }
    const console = { log() {}, warn() {}, error() {} };
    ${extractFunction('pushScannerContextToRadar').replace(/\bDate\.now\(\)/g, 'Date_now()')}
    return pushScannerContextToRadar({ trigger: 'test' });
  `);
  harness(win, posts, skips, rows, unusable, stale, lastPostAt, now);
  return { posts, skips, proof: win.__lastRadarContextPostProof, status: win.__lastRadarContextPostStatus };
}

const USABLE = { unusable: false, reason: null, ageMs: 5_000, ageLabel: '5s' };
const LIVE = { stale: false, reason: null, ageMs: 5_000, ageLabel: '5s' };

test('B(run): fresh live market data POSTS, and the proof carries source/age/rows', () => {
  const r = runPush({
    rows: 3,
    freshness: { ok: true, servedFrom: 'live', stale: false, generatedAt: NOW - 5_000 },
    unusable: USABLE,
    stale: LIVE,
  });
  assert.equal(r.skips.length, 0, 'no skip: ' + r.skips.join('; '));
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].path, '/api/bot/radar-context');
  assert.equal(r.posts[0].method, 'POST');
  assert.equal(r.proof.market_fresh, true);
  assert.equal(r.proof.source, 'live');
  assert.equal(r.proof.age_ms, 5_000);
  assert.equal(r.proof.rows, 3);
  assert.equal(r.proof.generated_at, new Date(NOW - 5_000).toISOString());
});

test('B(run): every unfit state BLOCKS the post and names why', () => {
  const cases = [
    ['no market read yet', { freshness: undefined, unusable: USABLE, stale: LIVE }, /no market read has completed yet/],
    ['the read failed', { freshness: { ok: false, servedFrom: 'error', stale: true, staleReason: 'HTTP 500', generatedAt: null }, unusable: { unusable: true, reason: 'the market read failed' }, stale: { stale: true, reason: 'fetch failed' } }, /the market read failed/],
    ['no generatedAt', { freshness: { ok: true, servedFrom: 'live', stale: false, generatedAt: null }, unusable: USABLE, stale: LIVE }, /no generatedAt timestamp/],
    ['hard-stale (27h canonical)', { freshness: { ok: true, servedFrom: 'canonical', stale: true, generatedAt: NOW - AGE_27H }, unusable: { unusable: true, reason: 'snapshot is 27h old — beyond the 30m hard limit', ageMs: AGE_27H }, stale: { stale: true, reason: 'old', ageLabel: '27h' } }, /market data unavailable/],
    ['soft-stale', { freshness: { ok: true, servedFrom: 'live', stale: false, generatedAt: NOW - (MARKET_MAX_AGE_MS + 1) }, unusable: USABLE, stale: { stale: true, reason: 'snapshot is 4m old', ageLabel: '4m' } }, /market snapshot is STALE/],
    ['no rows', { rows: 0, freshness: { ok: true, servedFrom: 'live', stale: false, generatedAt: NOW - 5_000 }, unusable: USABLE, stale: LIVE }, /no scanner rows loaded/],
  ];
  for (const [label, input, expected] of cases) {
    const r = runPush(input);
    assert.equal(r.posts.length, 0, label + ' must NOT post');
    assert.equal(r.skips.length, 1, label + ' must record exactly one reason');
    assert.match(r.skips[0], expected, label);
    assert.equal(r.proof.market_fresh, false);
    assert.match(r.status, /^skipped: /);
  }
});

test('B(run): the throttle still blocks a second post inside the window', () => {
  const input = {
    freshness: { ok: true, servedFrom: 'live', stale: false, generatedAt: NOW - 5_000 },
    unusable: USABLE,
    stale: LIVE,
  };
  const throttled = runPush({ ...input, lastPostAt: NOW - 10_000 });   // 10s < 45s
  assert.equal(throttled.posts.length, 0);
  assert.match(throttled.status, /^throttled \(35s to go\)$/);
  const allowed = runPush({ ...input, lastPostAt: NOW - 46_000 });     // 46s > 45s
  assert.equal(allowed.posts.length, 1);
});

test('B(run): freshness outranks the throttle — an unfit state says so, not "throttled"', () => {
  const r = runPush({
    freshness: { ok: true, servedFrom: 'canonical', stale: true, generatedAt: NOW - AGE_27H },
    unusable: { unusable: true, reason: 'snapshot is 27h old — beyond the 30m hard limit', ageMs: AGE_27H },
    stale: { stale: true, reason: 'old', ageLabel: '27h' },
    lastPostAt: NOW - 10_000,      // ALSO inside the throttle window
  });
  assert.equal(r.posts.length, 0);
  assert.match(r.skips[0], /market data unavailable/);
  assert.doesNotMatch(r.status, /throttled/);
});

test('B(run): the payload is capped at the server ceiling', () => {
  const r = runPush({
    rows: 900,
    freshness: { ok: true, servedFrom: 'live', stale: false, generatedAt: NOW - 5_000 },
    unusable: USABLE,
    stale: LIVE,
  });
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].rows, 500, 'never more than the 500 the server accepts');
  assert.equal(r.proof.rows_available, 900, 'and it reports what it had');
});
