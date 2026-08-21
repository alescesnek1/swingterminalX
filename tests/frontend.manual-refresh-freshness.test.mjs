// Manual-refresh freshness hotfix — frontend contract.
//
// Layer 1: REAL behaviour of the pure trust gate the UI paints from
//          (js/freshness-badge.js — imported and executed).
// Layer 2: source-level wiring assertions on the shipped terminal.js /
//          index.html bundle, matching how the repo's other frontend.*
//          tests guard a classic-<script> file that cannot be imported.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  freshnessBadge,
  marketFreshnessState,
  pct24hDisplay,
  ageAgoLabel,
  MARKET_MAX_AGE_MS,
} from '../apps/edge/public/js/freshness-badge.js';

const js = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');

const NOW = 1_700_000_000_000;

// ── REFRESH click reaches the real market refresh path ───────

test('the REFRESH button dispatches a MANUAL refresh_now event', () => {
  assert.match(html, /id="btn-refresh"/);
  assert.match(html, /new CustomEvent\('refresh_now',\{detail:\{manual:true\}\}\)/);
});

test('refresh_now routes into manualRefresh -> doRefresh -> fetchData', () => {
  assert.match(js, /document\.addEventListener\('refresh_now', \(e\) => \{[\s\S]{0,200}manualRefresh\(\{ force: manual \}\)/);
  assert.match(js, /async function manualRefresh\(opts\)[\s\S]{0,900}await doRefresh\(\{ force \}\)/);
  assert.match(js, /const live = await fetchData\(opts\);/);
});

// ── manual refresh bypasses the throttles, not the auth gate ─

test('a manual refresh forces the market read past every cache layer', () => {
  // URL flag (edge rebuild + no-store), header flag, and the browser cache.
  assert.match(js, /const _mktUrl = force \? '\/api\/markets\?force=1' : '\/api\/markets';/);
  assert.match(js, /_mktInit\.cache = 'reload';/);
  assert.match(js, /_mktInit\.headers\['X-Force-Refresh'\] = '1';/);
});

test('a user click is NOT absorbed by an in-flight background (cached) tick', () => {
  // Dedupe now only joins an existing FORCED refresh; a background tick in
  // flight would have handed the click back the same stale bytes.
  assert.match(js, /if \(_refreshInFlight && \(!force \|\| _refreshInFlightForced\)\)/);
});

test('two concurrent forced refreshes still collapse onto one', () => {
  assert.match(js, /_refreshInFlightForced = force;/);
  assert.match(js, /dedupedRefreshes/);
});

test('the poll governor still gates recurring ticks only, never the manual click', () => {
  // Recurring ticks keep their hidden-tab gate...
  assert.match(js, /async function _restPollTick\(\)\s*\{\s*if \(!_pollTickAllowed\('markets-rest'\)\) return;/);
  // ...and the manual path never consults it.
  const mr = js.slice(js.indexOf('async function manualRefresh'), js.indexOf('async function _doRefreshCore'));
  assert.ok(mr.length > 0);
  assert.doesNotMatch(mr, /_pollTickAllowed/);
});

test('manual refresh does NOT bypass auth', () => {
  // The forced request carries the same auth headers as any other read.
  assert.match(js, /const authHeaders = await _getAuthHeaders\(\);/);
  assert.match(js, /headers: \{ 'Accept': 'application\/json', \.\.\.authHeaders \}/);
  const fd = js.slice(js.indexOf('async function fetchData(opts)'), js.indexOf('// ========== RENDER FUNCTIONS =========='));
  assert.ok(fd.length > 0);
  assert.doesNotMatch(fd, /skipAuth|noAuth/);
});

test('manual refresh does not force any DB-heavy history/context read', () => {
  const fd = js.slice(js.indexOf('async function fetchData(opts)'), js.indexOf('// ========== RENDER FUNCTIONS =========='));
  // /api/context (four Postgres queries) is fetched without any force flag.
  assert.match(js, /fetch\('\/api\/context', \{ headers: \{ 'Accept': 'application\/json', \.\.\.authHeaders \} \}\)/);
  assert.doesNotMatch(fd, /\/api\/context\?force/);
  assert.doesNotMatch(js, /price-history[^\n]*force=1/);
  // Only ONE endpoint in the whole bundle is ever given the force flag
  // (matches on quoted request URLs, so prose in comments does not count).
  const forcedUrls = js.match(/'\/api\/[a-z-]+\?force=1'/g) || [];
  assert.deepEqual(forcedUrls, ["'/api/markets?force=1'"]);
});

// ── the trust gate itself (real behaviour) ───────────────────

test('a fresh snapshot inside the age budget is not stale', () => {
  const st = marketFreshnessState({ ok: true, servedFrom: 'live', stale: false, generatedAt: NOW - 20_000 }, { now: NOW });
  assert.equal(st.stale, false);
  assert.equal(st.reason, null);
});

test('a backend stale timestamp keeps the UI STALE', () => {
  const st = marketFreshnessState({ ok: true, servedFrom: 'live', stale: false, generatedAt: NOW - (MARKET_MAX_AGE_MS + 1) }, { now: NOW });
  assert.equal(st.stale, true);
  assert.match(st.reason, /old/);
});

test('a backend fresh timestamp clears STALE', () => {
  const before = marketFreshnessState({ ok: true, stale: true, servedFrom: 'stale-memory', generatedAt: NOW - 2_880_000 }, { now: NOW });
  const after = marketFreshnessState({ ok: true, stale: false, servedFrom: 'live', generatedAt: NOW - 1_000 }, { now: NOW });
  assert.equal(before.stale, true);
  assert.equal(after.stale, false);
});

test('an explicit stale-memory header is stale regardless of age', () => {
  const st = marketFreshnessState({ ok: true, servedFrom: 'stale-memory', stale: true, generatedAt: NOW }, { now: NOW });
  assert.equal(st.stale, true);
});

test('freshness fails closed: no timestamp and failed fetch are both STALE', () => {
  assert.equal(marketFreshnessState({ ok: true, stale: false, generatedAt: null }, { now: NOW }).stale, true);
  assert.equal(marketFreshnessState({ ok: false }, { now: NOW }).stale, true);
  assert.equal(marketFreshnessState(undefined, { now: NOW }).stale, true);
});

test('the badge cannot render green while the dataset is age-stale', () => {
  // renderTopbar hands the age verdict in, so an age-stale snapshot whose
  // header still said live degrades to the amber badge.
  assert.equal(freshnessBadge({ ok: true, servedFrom: 'live' }, 'STALE').cls, 's-stale');
  assert.match(js, /window\.freshnessBadge\(fresh, fState\.stale && SRC !== 'ERROR' \? 'STALE' : SRC\)/);
});

// ── 24h % honesty (the VELVET case) ─────────────────────────

test('a stale dataset renders 24h as STALE, never a confident number', () => {
  const stale = marketFreshnessState({ ok: true, servedFrom: 'stale-memory', stale: true, generatedAt: NOW - 2_880_000 }, { now: NOW });
  const d = pct24hDisplay(35.2, stale);
  assert.equal(d.text, 'STALE');
  assert.equal(d.known, false);
  assert.doesNotMatch(d.text, /35/);
  assert.notEqual(d.cls, 'pos');
});

test('VELVET-like fixture: a stale +35.20% cannot be displayed as a gain', () => {
  const velvet = { symbol: 'VELVET', _c24: 35.2, _c24Known: true, price_change_percentage_24h: 35.2 };
  const staleAt1100 = marketFreshnessState(
    { ok: true, servedFrom: 'stale-memory', stale: true, generatedAt: NOW - 48 * 60_000 },
    { now: NOW },
  );
  const shown = pct24hDisplay(velvet._c24, staleAt1100);
  assert.equal(shown.text, 'STALE');
  assert.match(shown.title, /not live/);
  assert.match(shown.title, /48m/);
  // Same fixture on a CURRENT snapshot is allowed to show the number.
  const fresh = marketFreshnessState({ ok: true, servedFrom: 'live', stale: false, generatedAt: NOW - 5_000 }, { now: NOW });
  assert.equal(pct24hDisplay(velvet._c24, fresh).text, '+35.20%');
  assert.equal(pct24hDisplay(velvet._c24, fresh).cls, 'pos');
});

test('an unreported 24h renders UNKNOWN, never 0.00%', () => {
  const fresh = marketFreshnessState({ ok: true, servedFrom: 'live', stale: false, generatedAt: NOW - 5_000 }, { now: NOW });
  for (const v of [null, undefined, '', NaN, 'abc']) {
    const d = pct24hDisplay(v, fresh);
    assert.equal(d.text, 'UNKNOWN', 'value ' + String(v) + ' must be UNKNOWN');
    assert.equal(d.known, false);
  }
  // The Number(null)===0 trap: a real zero is still a real zero.
  assert.equal(pct24hDisplay(0, fresh).text, '+0.00%');
});

test('24h is never synthesized from the 24h range or the current price', () => {
  // getTimeframePct('c24') reads ONLY reported 24h-change fields.
  const keys = js.slice(js.indexOf('  c24: ['), js.indexOf('  c7d: ['));
  assert.ok(keys.length > 0);
  for (const forbidden of ['high_24h', 'low_24h', 'current_price', 'range']) {
    assert.ok(!keys.includes(forbidden), 'c24 must not read ' + forbidden);
  }
  // And the detail panel's 24h comes from the reported field, gated by _c24Known.
  assert.match(js, /d\._c24Known === false \? null : \(d\._c24 \?\? d\.price_change_percentage_24h\)/);
  assert.match(js, /d\._c24Known = c24 != null;/);
});

test('the detail panel routes 24h through the shared trust gate on BOTH paths', () => {
  // Initial paint (pickCoin) and the in-place poll mutation must agree.
  assert.match(js, /data-detail="c24" title="\$\{_esc\(_c24Disp\.title\)\}">\$\{_esc\(_c24Disp\.text\)\}/);
  assert.match(js, /const c24Disp = _pct24hDisplay\(c24Raw, _fState\);/);
  assert.match(js, /c24El\.textContent = c24Disp\.text;/);
  // The old unconditional confident render is gone.
  assert.doesNotMatch(js, /data-detail="c24">\$\{_esc\(fp\(d\.price_change_percentage_24h\|\|0\)\)\}/);
  assert.doesNotMatch(js, /c24El\.textContent = fp\(c24Val\);/);
});

test('the trust gate fails closed if freshness-badge.js never loads', () => {
  // Inline fallbacks in terminal.js degrade to STALE, not to a number.
  assert.match(js, /if \(!state \|\| state\.stale\) return \{ text: 'STALE', cls: 'pct-stale'/);
  assert.match(js, /stale: fresh\.ok === false \|\| fresh\.stale === true \|\| gen == null/);
});

// ── stale-mode UI degrade ───────────────────────────────────

test('a stale dataset shows a prominent banner and degrades the panel', () => {
  assert.match(js, /function _detailStaleBannerText\(state\)/);
  assert.match(js, /Values below are NOT live/);
  assert.match(js, /_applyDetailStaleClass\(_fState\.stale\)/);
  assert.match(css, /\.detail-stale-banner\{/);
  assert.match(css, /#dcon\.data-stale/);
  assert.match(css, /\.pct-stale,\.pct-unknown\{/);
});

test('the momentum stack 24H row is degraded too, not left confident', () => {
  assert.match(js, /_fState\.stale \|\| d\._c24Known === false/);
});

test('the top-bar timestamp never paints wall-clock over an unknown age', () => {
  assert.match(js, /window\.__marketsFreshness \? '— · age unknown' : new Date\(\)\.toLocaleTimeString/);
  assert.match(js, /lu\.classList\.toggle\('is-stale', fState\.stale\)/);
  assert.match(css, /#last-update\.is-stale\{/);
});

// ── button UX + visible failure reasons ─────────────────────

test('the REFRESH button shows a loading state and cannot double-fire', () => {
  assert.match(js, /btn\.disabled = true; btn\.classList\.add\('is-loading'\)/);
  assert.match(js, /if \(_manualRefreshBusy\) return/);
  assert.match(js, /btn\.disabled = false; btn\.classList\.remove\('is-loading'\)/);
  assert.match(css, /\.hbtn\.is-loading\{/);
});

test('a failed refresh surfaces a visible reason AND logs it', () => {
  assert.match(js, /window\.Toast\?\.error\?\.\('Refresh failed', reason/);
  assert.match(js, /console\.error\('\[REFRESH\] manual refresh failed:'/);
});

test('a refresh that returns still-stale data says so instead of looking fine', () => {
  assert.match(js, /'Still STALE after refresh'/);
  assert.match(js, /Force was throttled/);
  assert.match(js, /console\.warn\('\[REFRESH\] manual refresh completed but data is still stale:'/);
});

test('the forced read outcome is recorded from the response headers', () => {
  // The header is the truth; a forced read that cannot READ the header still
  // reports what it knows rather than `null` (see the P0 hotfix tests).
  assert.match(js, /const _forceHdr = r\.headers\.get\('X-Force-Refresh'\);/);
  assert.match(js, /forceOutcome: _forceOutcome,/);
  assert.match(js, /staleReason: r\.headers\.get\('X-Stale-Reason'\) \|\| null/);
  assert.match(js, /console\.warn\('\[REFRESH\] forced \/api\/markets read'/);
});

// ── cost protection is unchanged ────────────────────────────

test('background polling stays conservative — no cadence change', () => {
  assert.match(js, /const STREAM_REST_POLL_DEFAULT_MS = 60 \* 1000;/);
  assert.match(js, /const STREAM_AGGRESSIVE_POLL_MS = 10 \* 1000;/);
});

test('no scheduled collector or price-history write is introduced', () => {
  assert.doesNotMatch(js, /price-history-collect|market-context-collect/);
});

// ── misc ─────────────────────────────────────────────────────

test('the age label stays human and never lies about an unknown age', () => {
  assert.equal(ageAgoLabel(20_000), '20s');
  assert.equal(ageAgoLabel(48 * 60_000), '48m');
  assert.equal(ageAgoLabel(null), '—');
  assert.equal(ageAgoLabel(-1), '—');
});

test('the asset cache-bust token was bumped so returning users get this code', () => {
  assert.doesNotMatch(html, /\?v=6l5/);
  assert.doesNotMatch(html, /\?v=6m1/);
  assert.match(html, /js\/terminal\.js\?v=6m4/);
  assert.match(html, /js\/freshness-badge\.js\?v=6m4/);
});
