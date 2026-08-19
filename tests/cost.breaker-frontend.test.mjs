// Browser-side half of the emergency Netlify cost breaker, plus the safety
// invariants the breaker must not have violated.
//
// The DB-backed panels (price-history signals, the server RADAR verdict) are
// repainted on every RADAR/Cockpit render — and the RADAR view repaints on a 4s
// Fleet poll tick. Each of those fetches is a Netlify Postgres round trip, so a
// panel that is off screen, or a tab nobody is looking at, must not be able to
// open one: a read at any cadence under 5 minutes keeps the database awake, and
// awake time is what Netlify bills.
//
// Behaviour is asserted by extracting the real functions out of terminal.js and
// running them, not by matching source text — same technique as
// tests/cost.poll-governor.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

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

// A minimal DOM: `slots` maps an element id to its layout facts.
// { offsetParent, offsetWidth, offsetHeight } — null offsetParent with no box is
// how a browser reports a display:none subtree.
function makeGate(visibilityState, slots = {}) {
  const win = { __pollGovernor: { skipped: {}, ran: {}, lastSkipAt: null, lastResumeAt: null } };
  const doc = {
    visibilityState,
    getElementById: (id) => (Object.prototype.hasOwnProperty.call(slots, id) ? slots[id] : null),
  };
  const factory = new Function('window', 'document', 'console', `
    ${extractFunction('_pageIsActive')}
    ${extractFunction('_dbPanelReadAllowed')}
    return { _pageIsActive, _dbPanelReadAllowed };
  `);
  return { win, ...factory(win, doc, { warn() {} }) };
}

const VISIBLE_SLOT = { offsetParent: {}, offsetWidth: 320, offsetHeight: 180 };
const HIDDEN_SLOT = { offsetParent: null, offsetWidth: 0, offsetHeight: 0 };

// ── 8. the browser does not call DB-heavy endpoints when hidden or inactive ──

test('8. a hidden tab spends no database read, for any DB-backed panel', () => {
  const { _dbPanelReadAllowed, win } = makeGate('hidden', {
    'cockpit-radar-state-slot': VISIBLE_SLOT,
    'radar-ph-signals-slot': VISIBLE_SLOT,
    'cockpit-admin-price-history-body': VISIBLE_SLOT,
  });
  assert.equal(_dbPanelReadAllowed('cockpit-radar-state', 'cockpit-radar-state-slot'), false);
  assert.equal(_dbPanelReadAllowed('radar-price-history', 'radar-ph-signals-slot'), false);
  assert.equal(_dbPanelReadAllowed('admin-price-history', 'cockpit-admin-price-history-body'), false);
  // The skip is counted, so a paused terminal is a visible fact rather than a mystery.
  assert.equal(win.__pollGovernor.skipped['cockpit-radar-state'], 1);
  assert.equal(win.__pollGovernor.ran['cockpit-radar-state'], undefined);
});

test('8b. an inactive (off-screen) panel spends no database read even while the tab is visible', () => {
  const { _dbPanelReadAllowed } = makeGate('visible', {
    'cockpit-radar-state-slot': HIDDEN_SLOT,
    'radar-ph-signals-slot': VISIBLE_SLOT,
  });
  assert.equal(_dbPanelReadAllowed('cockpit-radar-state', 'cockpit-radar-state-slot'), false, 'display:none panel');
  assert.equal(_dbPanelReadAllowed('radar-price-history', 'radar-ph-signals-slot'), true, 'the on-screen panel still reads');
});

test('8c. a panel that is not in the document at all spends nothing', () => {
  const { _dbPanelReadAllowed } = makeGate('visible', {});
  assert.equal(_dbPanelReadAllowed('radar-price-history', 'radar-ph-signals-slot'), false);
});

test('8d. a visible panel on a visible tab reads normally — the gate does not break the feature', () => {
  const { _dbPanelReadAllowed } = makeGate('visible', { 'cockpit-radar-state-slot': VISIBLE_SLOT });
  assert.equal(_dbPanelReadAllowed('cockpit-radar-state', 'cockpit-radar-state-slot'), true);
});

test('8e. a DOM without offset* metrics counts as visible — the gate errs toward spending, never toward starving a panel', () => {
  const { _dbPanelReadAllowed } = makeGate('visible', { slot: { /* jsdom-like: no offsetParent, no metrics */ } });
  assert.equal(_dbPanelReadAllowed('x', 'slot'), true);
});

// ── the three call sites actually consult the gate, and defer honestly ───────

test('the server RADAR verdict panel checks the gate, and never reads with no selected coin', () => {
  const fn = extractFunction('_refreshCockpitRadarState');
  assert.match(fn, /_dbPanelReadAllowed\('cockpit-radar-state', 'cockpit-radar-state-slot'\)/);
  // The gate is consulted BEFORE the fetch.
  assert.ok(fn.indexOf('_dbPanelReadAllowed') < fn.indexOf('fetch('), 'the gate precedes the fetch');
  // No symbol selected -> paint and return, never fetch.
  assert.match(fn, /if \(!symbol\) \{.*state: 'waiting'.*return; \}/);
  assert.ok(fn.indexOf('if (!symbol)') < fn.indexOf('fetch('), 'the no-coin guard precedes the fetch');
  // A deferred read must not render as "loading" — a box that spins forever is
  // exactly what the error-observability rules forbid.
  assert.match(fn, /state: 'deferred'/);
});

test('a deferred verdict renders an explicit deferred message, not a perpetual spinner and not an error', () => {
  const html = extractFunction('_cpRadarStateInnerHtml');
  assert.match(html, /model\.state === 'deferred'/);
  const start = html.indexOf("model.state === 'deferred'");
  const line = html.slice(start, html.indexOf('\n', start) + 200);
  assert.match(line, /not visible/i, 'it says why');
  assert.match(line, /cost guard/i, 'it names the cause');
  assert.equal(/Loading/.test(line), false, 'a deferred read is not a loading read');
});

test('the RADAR focus price-history panel checks the gate and reports a deferred status', () => {
  const fn = extractFunction('_refreshRadarPriceHistorySignals');
  assert.match(fn, /_dbPanelReadAllowed\('radar-price-history', 'radar-ph-signals-slot'\)/);
  assert.ok(fn.indexOf('_dbPanelReadAllowed') < fn.indexOf('fetch('), 'the gate precedes the fetch');
  assert.match(fn, /data-ph-status', 'deferred'/);
  assert.match(fn, /deferred — panel not visible/);
});

test('the admin price-history card memoizes, so re-entering the Cockpit repaints instead of re-reading', () => {
  const fn = extractFunction('refreshAdminPriceHistorySignals');
  // One Postgres read PER SYMBOL, so both guards matter: a warm memo short-
  // circuits before the gate, and the gate short-circuits before the fetch.
  assert.match(fn, /_adminPriceHistoryMemo && \(Date\.now\(\) - _adminPriceHistoryMemo\.at\) < ADMIN_PRICE_HISTORY_TTL_MS/);
  assert.match(fn, /_dbPanelReadAllowed\('admin-price-history', 'cockpit-admin-price-history-body'\)/);
  assert.ok(fn.indexOf('_adminPriceHistoryMemo &&') < fn.indexOf('fetch('), 'the memo precedes the fetch');
  assert.ok(fn.indexOf('_dbPanelReadAllowed') < fn.indexOf('fetch('), 'the gate precedes the fetch');
  assert.match(fn, /_adminPriceHistoryMemo = \{ at: Date\.now\(\), html: body\.innerHTML \}/, 'a successful read is stored');
  assert.match(terminalJs, /const ADMIN_PRICE_HISTORY_TTL_MS = 5 \* 60 \* 1000;/);
});

test('no NEW recurring poll was introduced — the breaker only ever subtracts requests', () => {
  // Every setInterval in terminal.js, with the name it polls under. The breaker
  // adds gates and memos; it must not add a timer.
  const intervals = terminalJs.match(/setInterval\(/g) || [];
  assert.equal(intervals.length, 11, 'the timer count is unchanged (11); a new one needs its own cost review');
  // And the recurring ticks that reach the network all still consult the governor.
  for (const name of ['markets-rest', 'markets-aggressive', 'markets-fallback', 'fleet', 'orderbook', 'news']) {
    assert.ok(terminalJs.includes(`_pollTickAllowed('${name}')`), `${name} tick is governed`);
  }
});

// ── 9 & 10. safety invariants: what this change must NOT have touched ────────

const fnDir = new URL('../netlify/functions/', import.meta.url);
const readFn = (name) => fs.readFileSync(new URL(name, fnDir), 'utf8');

// Prose is not logic: the breaker's header comment names the systems it must
// stay out of, so these checks run against the CODE with comments stripped.
function codeOf(name) {
  // CRs are stripped first: JS `.` does not match a carriage return, so on a
  // CRLF file a trailing `\r` would stop `//.*$` from ever reaching end-of-line
  // and no line comment would be removed at all.
  const withoutBlockComments = readFn(name)
    .replace(/[/][*][\s\S]*?[*][/]/g, ' ')
    .split(String.fromCharCode(13)).join('');
  const lines = withoutBlockComments.split(String.fromCharCode(10));
  return lines.map((line) => line.replace(/(^|\s)[/][/].*$/, '')).join(String.fromCharCode(10));
}

test('9. the cost breaker module carries no trading, order, signing, Telegram, ENTRY_READY or auth logic', () => {
  const breaker = codeOf('_cost-breaker.mjs');
  for (const forbidden of [
    'ENTRY_READY', 'telegram', 'TG_BOT_TOKEN', 'sendMessage', 'binance', 'signature', 'hmac',
    'apiSecret', 'order', 'getIdentity', 'isAdmin', 'jwt', 'password',
  ]) {
    assert.equal(breaker.toLowerCase().includes(forbidden.toLowerCase()), false, `_cost-breaker.mjs must not mention ${forbidden}`);
  }
  // It reads no environment variable at import time and opens no connection.
  assert.equal(/^\s*(const|let)\s+\w+\s*=\s*process\.env/m.test(breaker), false, 'no top-level env read');
  assert.equal(breaker.includes('_db.mjs'), false, 'the breaker never imports the database');
  assert.equal(breaker.includes('@netlify/database'), false);
});

test('9b. the breaker never emits anything that could be a secret or user identifier', () => {
  const breaker = codeOf('_cost-breaker.mjs');
  // The only values that can reach a header or a log line are our own fixed codes.
  assert.match(breaker, /COST_BREAKER_REASONS\.includes\(reason\)/);
  for (const forbidden of ['connectionString', 'NETLIFY_DB_URL', 'chatId', 'email', 'userId']) {
    assert.equal(breaker.includes(forbidden), false, `must not reference ${forbidden}`);
  }
});

test('9c. the Telegram / ENTRY_READY / alert senders are untouched by the breaker', () => {
  // cron-alerts.mjs is the only file allowed to call the Telegram HTTP API, and
  // it decides what may reach an ENTRY_READY alert. It must not import the
  // breaker: an emergency cost gate must never be able to suppress or alter a
  // confirmed entry alert.
  for (const file of ['cron-alerts.mjs', 'telegram.mjs', 'personal-alerts.mjs', '_personal-watch-notifier.mjs', '_personal-watch-triggers.mjs', 'bot.mjs']) {
    assert.equal(readFn(file).includes('_cost-breaker.mjs'), false, `${file} must not import the cost breaker`);
  }
});

test('9d. the RADAR gate modules are untouched — no breaker import in the evaluator or the publisher', () => {
  for (const file of ['_radar-context-publisher.mjs', '_market-context-absorb.mjs', '_market-context-store.mjs']) {
    assert.equal(readFn(file).includes('_cost-breaker.mjs'), false, `${file} must not import the cost breaker`);
  }
  const radarEvaluator = fs.readFileSync(new URL('../scripts/radar/trading-radar.mjs', import.meta.url), 'utf8');
  assert.equal(radarEvaluator.includes('_cost-breaker.mjs'), false, 'the RADAR evaluator must not import the cost breaker');
});

test('9e. auth is not weakened — no auth module imports or is bypassed by the breaker', () => {
  for (const file of ['_auth.mjs', '_native-jwt.mjs', '_user-store.mjs', '_password.mjs', 'auth-login.mjs', 'auth-refresh.mjs', 'auth-change-password.mjs']) {
    assert.equal(readFn(file).includes('_cost-breaker.mjs'), false, `${file} must not import the cost breaker`);
  }
  // In every endpoint the breaker guards, the identity check comes first.
  for (const file of ['context.mjs', 'cockpit-radar-state.mjs', 'admin-price-history.mjs', 'admin-price-history-signals.mjs']) {
    const src = readFn(file);
    const auth = src.indexOf('getIdentity');
    const guard = src.search(/masterKillSwitchEngaged\(|priceHistoryReadsAllowed\(/);
    assert.ok(auth !== -1 && guard !== -1, `${file} has both an auth check and a guard`);
    assert.ok(auth < guard, `${file}: authentication must be reached before the cost guard`);
  }
});

test('10. no new scheduler or cron was added — the schedules are exactly the ones that already existed', () => {
  // Netlify native schedules, declared as `export const config = { schedule: ... }`.
  const schedules = [];
  for (const file of fs.readdirSync(new URL(fnDir))) {
    if (!file.endsWith('.mjs')) continue;
    const m = readFn(file).match(/schedule:\s*'([^']+)'/g);
    if (m) for (const entry of m) schedules.push(`${file} ${entry}`);
  }
  assert.deepEqual(schedules.sort(), [
    "cron-alerts.mjs schedule: '*/5 * * * *'",
    "market-context-collect-scheduled.mjs schedule: '*/3 * * * *'",
    "market-context-retention-scheduled.mjs schedule: '17 * * * *'",
    "morning-briefing.mjs schedule: '0 5-9 * * *'",
    "personal-watch-triggers-scheduled.mjs schedule: '*/5 * * * *'",
  ], 'the set of native schedules is unchanged');

  // netlify.toml declares no cron of its own.
  const toml = fs.readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.equal(/\bschedule\b/.test(toml), false, 'netlify.toml declares no schedule');

  // GitHub Actions crons.
  const wfDir = new URL('../.github/workflows/', import.meta.url);
  const crons = [];
  for (const file of fs.readdirSync(new URL(wfDir))) {
    const src = fs.readFileSync(new URL(file, wfDir), 'utf8');
    for (const line of src.split(/\r?\n/)) {
      const m = line.match(/^\s{2,}-\s*cron:\s*"([^"]+)"/);
      if (m) crons.push(`${file} ${m[1]}`);
    }
  }
  assert.deepEqual(crons.sort(), [
    'personal-alerts.yml */5 * * * *',
    'price-history-collect.yml */30 * * * *',
  ], 'the set of GitHub Actions crons is unchanged');
});

test('10b. package.json and its lockfile were not touched by the cost breaker', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // The breaker adds no dependency: it is one plain module with no imports.
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@netlify/blobs', '@netlify/database']);
  const breaker = codeOf('_cost-breaker.mjs');
  assert.equal(/^import /m.test(breaker), false, 'the breaker imports nothing at all');
});

test('10c. no migration was added — the breaker is code-only', () => {
  const migrations = fs.readdirSync(new URL('../netlify/database/migrations/', import.meta.url));
  for (const name of migrations) {
    assert.equal(/cost|breaker/i.test(name), false, `${name} looks like a cost-breaker migration; none should exist`);
  }
});
