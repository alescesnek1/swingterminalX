// Netlify credit-drain guards for the browser polling paths.
//
// ROOT CAUSE THESE LOCK IN: connectStream() takes the dead-infra branch
// (LEGACY_FLY_STREAM_ENABLED === false) and used to call _enableAggressivePoll(),
// making the 10-second EMERGENCY cadence the permanent steady state — its only
// disable path is the WebSocket onopen handler, which can never run in this
// build. Each tick ran a full doRefresh() → /api/context (four Postgres queries,
// up to 2,000 ticker + 600 microstructure rows, no-store) + /api/markets +
// /api/regime, forever, including while the tab was hidden.
//
// These tests assert the cost controls, NOT any trading behaviour. They must
// stay true for the terminal to remain affordable to run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

// Pulls a top-level function out of terminal.js so its BEHAVIOUR can be asserted
// rather than its source text. Same helper shape as
// tests/frontend.canonical-context-cutover.test.mjs.
function extractFunction(name) {
  const start = terminalJs.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  let depth = 0;
  const i = terminalJs.indexOf('{', start);
  for (let j = i; j < terminalJs.length; j += 1) {
    if (terminalJs[j] === '{') depth += 1;
    else if (terminalJs[j] === '}') { depth -= 1; if (depth === 0) return terminalJs.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

function makeGovernor(visibilityState) {
  const win = { __pollGovernor: { skipped: {}, ran: {}, lastSkipAt: null, lastResumeAt: null } };
  const doc = { visibilityState };
  const factory = new Function('window', 'document', 'console', `
    ${extractFunction('_pageIsActive')}
    ${extractFunction('_pollTickAllowed')}
    return { _pageIsActive, _pollTickAllowed };
  `);
  return { win, ...factory(win, doc, { warn() {} }) };
}

// ── 1. inactive panels / tabs do not trigger expensive fetches ──────────────

test('a hidden tab defers every recurring poll instead of spending a request', () => {
  const { _pollTickAllowed, win } = makeGovernor('hidden');
  for (const poll of ['markets-rest', 'fleet', 'orderbook', 'news']) {
    assert.equal(_pollTickAllowed(poll), false, `${poll} tick is skipped while hidden`);
  }
  assert.equal(win.__pollGovernor.skipped['markets-rest'], 1);
  assert.equal(win.__pollGovernor.ran['markets-rest'], undefined, 'a skipped tick is never counted as run');
});

test('a visible tab runs every recurring poll normally', () => {
  const { _pollTickAllowed, win } = makeGovernor('visible');
  for (const poll of ['markets-rest', 'fleet', 'orderbook', 'news']) {
    assert.equal(_pollTickAllowed(poll), true, `${poll} tick runs while visible`);
  }
  assert.equal(win.__pollGovernor.ran.fleet, 1);
  assert.deepEqual(win.__pollGovernor.skipped, {}, 'nothing is skipped while visible');
});

test('skipping is observable, never silent — counters and a resume hook exist', () => {
  const { _pollTickAllowed, win } = makeGovernor('hidden');
  _pollTickAllowed('markets-rest');
  _pollTickAllowed('markets-rest');
  assert.equal(win.__pollGovernor.skipped['markets-rest'], 2);
  assert.ok(win.__pollGovernor.lastSkipAt, 'the pause is timestamped');
  // A hidden-tab pause must log at least the first skip so the operator can tell
  // a paused terminal from a broken one.
  assert.match(terminalJs, /POLL_GOVERNOR\] tab hidden — deferring poll/);
  // And coming back must catch up immediately rather than waiting out the interval.
  assert.match(terminalJs, /function _installPollGovernorVisibilityHook\(\)/);
  assert.match(terminalJs, /addEventListener\('visibilitychange'/);
  assert.match(terminalJs, /_installPollGovernorVisibilityHook\(\);\s+\/\/ pause recurring polls/);
});

test('non-browser contexts are treated as active so nothing is blocked off-page', () => {
  const factory = new Function('window', 'console', `
    ${extractFunction('_pageIsActive')}
    return _pageIsActive;
  `);
  assert.equal(factory({}, { warn() {} })(), true);
});

test('every recurring network poll is routed through the governor', () => {
  // Market data (steady state, emergency fallback, long safety net).
  assert.match(terminalJs, /async function _restPollTick\(\)\s*\{\s*\n\s*if \(!_pollTickAllowed\('markets-rest'\)\) return;/);
  assert.match(terminalJs, /async function _aggressivePollTick\(\)\s*\{\s*\n\s*if \(!_pollTickAllowed\('markets-aggressive'\)\) return;/);
  assert.match(terminalJs, /async function _fallbackPollTick\(\)\s*\{\s*\n\s*if \(!_pollTickAllowed\('markets-fallback'\)\) return;/);
  // Bot fleet (4s) and order book (1.5s) — the two hottest panel polls.
  assert.match(terminalJs, /if \(!_pollTickAllowed\('fleet'\)\) return;\s*\n\s*refreshFleet\(\);/);
  assert.match(terminalJs, /if \(!_pollTickAllowed\('orderbook'\)\) return;\s*\n\s*loadOrderbook\(/);
  // News (5min).
  assert.match(terminalJs, /if \(!_pollTickAllowed\('news'\)\) return;\s*\n\s*this\.fetchNews\(\);/);
});

// ── 2. the permanent 10s poll is gone ───────────────────────────────────────

test('the WS-disabled build uses the steady-state cadence, not the emergency one', () => {
  const branch = terminalJs.slice(
    terminalJs.indexOf('if (!LEGACY_FLY_STREAM_ENABLED) {'),
    terminalJs.indexOf('if (window.STREAM_DISABLED) return;'),
  );
  assert.ok(branch.length > 0, 'the dead-infra branch is present');
  assert.match(branch, /_enableRestPoll\(\);/, 'steady-state REST poll');
  assert.doesNotMatch(branch, /_enableAggressivePoll\(\)/, 'the 10s emergency cadence must not be the steady state');
});

test('the steady-state cadence is at least a minute and can never be tuned into a hot loop', () => {
  const factory = new Function('window', `
    const STREAM_AGGRESSIVE_POLL_MS = 10 * 1000;
    const STREAM_REST_POLL_DEFAULT_MS = 60 * 1000;
    ${extractFunction('_streamRestPollMs')}
    return _streamRestPollMs;
  `);
  assert.equal(factory({})(), 60_000, 'default is 60s');
  assert.equal(factory({ STREAM_REST_POLL_MS: 120_000 })(), 120_000, 'a slower override is honoured');
  // Overrides below the emergency cadence fall back to the default — an override
  // must never be able to reintroduce the drain this fix removes.
  assert.equal(factory({ STREAM_REST_POLL_MS: 250 })(), 60_000);
  assert.equal(factory({ STREAM_REST_POLL_MS: 0 })(), 60_000);
  assert.equal(factory({ STREAM_REST_POLL_MS: 'fast' })(), 60_000);
  // Guard the declared default itself.
  assert.match(terminalJs, /const STREAM_REST_POLL_DEFAULT_MS = 60 \* 1000;/);
});

// ── 3. in-flight dedupe ─────────────────────────────────────────────────────

test('concurrent refresh triggers share one round trip instead of three', async () => {
  const win = { __pollGovernor: { skipped: {}, ran: {} } };
  let coreCalls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const factory = new Function('window', '_doRefreshCore', `
    let _refreshInFlight = null;
    ${extractFunction('doRefresh')}
    return doRefresh;
  `);
  const doRefresh = factory(win, async () => { coreCalls += 1; await gate; return 'done'; });

  const a = doRefresh();
  const b = doRefresh();
  const c = doRefresh();
  assert.equal(coreCalls, 1, 'one underlying fetch for three concurrent callers');
  release();
  assert.deepEqual(await Promise.all([a, b, c]), ['done', 'done', 'done'], 'every caller still gets the data');
  assert.equal(win.__pollGovernor.dedupedRefreshes, 2, 'the saving is counted');

  // Once settled, a later refresh really does fetch again — dedupe is not a cache.
  await doRefresh();
  assert.equal(coreCalls, 2);
});

// ── 4. panel-scoped polls stop when their panel is not showing ──────────────

test('the 4s fleet poll is stopped when neither the bot nor the radar view is open', () => {
  assert.match(
    terminalJs,
    /if \(activeViewName !== 'bot' && activeViewName !== 'radar'\) \{\s*\n\s*try \{ _stopFleetPoll\(\); \}/,
    'leaving both owning views stops the poll',
  );
  // Entering the view still starts it AND refreshes at once, so no visible data is lost.
  assert.match(terminalJs, /refreshFleet\(\); _startFleetPoll\(\);/);
});

// ── 5. no trading / alerting behaviour is touched ───────────────────────────

test('the cost controls gate only polling, never RADAR / ENTRY_READY / Telegram / orders', () => {
  // The governor may only ever appear next to the six known recurring polls.
  const gated = [...terminalJs.matchAll(/_pollTickAllowed\('([a-z-]+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    gated,
    ['fleet', 'markets-aggressive', 'markets-fallback', 'markets-rest', 'news', 'orderbook'],
    'no new path was put behind the gate',
  );
  // It must not be wired into any signal, alert, or order decision.
  for (const forbidden of [/ENTRY_READY[^\n]*_pollTickAllowed/, /_pollTickAllowed[^\n]*ENTRY_READY/, /_pollTickAllowed[^\n]*[Tt]elegram/, /_pollTickAllowed[^\n]*(createExecutionIntent|placeOrder|live-order)/]) {
    assert.doesNotMatch(terminalJs, forbidden);
  }
});
