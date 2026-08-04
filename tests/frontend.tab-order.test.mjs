// Customizable top tab order — pure resolution model + DOM wiring.
//
// Personalization only. These tests pin that the tab bar can be reordered and
// persisted, AND that reordering changes nothing else: no duplicate tabs, no
// new views, sv() still the only switcher, and no trading/RADAR/alert surface
// touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  resolveTabOrder,
  moveTab,
  canMove,
  readTabOrder,
  writeTabOrder,
  clearTabOrder,
  TAB_ORDER_STORAGE_KEY,
} from '../apps/edge/public/js/tab-order.js';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');
const tabOrderJs = fs.readFileSync(new URL('../apps/edge/public/js/tab-order.js', import.meta.url), 'utf8');

// Source scans below are about what the CODE does. The module header
// necessarily names the surfaces it must not touch (that is the contract it
// documents), so comments are stripped before scanning.
const tabOrderCode = tabOrderJs
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// The shipped tab bar, in markup order. Parsed from index.html so this test
// fails loudly if a tab is added without a canonical id.
const CANONICAL = [...indexHtml.matchAll(/<div class="tab(?: on)?"[^>]*data-view="([a-z]+)"/g)].map(m => m[1]);

// Minimal localStorage double. `mode` lets a test simulate the private-mode /
// quota failures that make real localStorage throw.
function fakeStorage(initial = {}, mode = 'ok') {
  const data = { ...initial };
  return {
    data,
    getItem(k) { if (mode === 'throw-read' || mode === 'throw-all') throw new Error('read blocked'); return k in data ? data[k] : null; },
    setItem(k, v) { if (mode === 'throw-write' || mode === 'throw-all') throw new Error('quota exceeded'); data[k] = String(v); },
    removeItem(k) { if (mode === 'throw-all') throw new Error('remove blocked'); delete data[k]; },
  };
}

test('the shipped tab bar exposes a canonical id for every tab', () => {
  assert.equal(CANONICAL.length, 14, 'all 14 nav tabs carry data-view');
  assert.deepEqual(CANONICAL, [
    'scanner', 'radar', 'cockpit', 'charts', 'bubbles', 'heatmap', 'movers',
    'calendar', 'bot', 'alerts', 'livefeed', 'regime', 'gecko', 'manual',
  ]);
  assert.equal(new Set(CANONICAL).size, CANONICAL.length, 'no duplicate view ids');
  // Every data-view must match the id sv() is actually called with.
  for (const view of CANONICAL) {
    assert.match(indexHtml, new RegExp(`data-view="${view}"[^>]*onclick="sv\\('${view}',this\\)"|onclick="sv\\('${view}',this\\)"[^>]*data-view="${view}"`), view);
  }
});

// ── 1. default order when nothing is saved ────────────────────

test('default order is used when no saved order exists', () => {
  assert.deepEqual(resolveTabOrder(null, CANONICAL), CANONICAL);
  assert.deepEqual(resolveTabOrder(undefined, CANONICAL), CANONICAL);
  assert.deepEqual(readTabOrder(CANONICAL, fakeStorage()), CANONICAL);
});

// ── 2. a saved valid order is applied ─────────────────────────

test('a saved valid order is applied', () => {
  const saved = ['cockpit', 'radar', 'scanner', ...CANONICAL.filter(v => !['cockpit', 'radar', 'scanner'].includes(v))];
  assert.deepEqual(resolveTabOrder(saved, CANONICAL), saved);
  const store = fakeStorage({ [TAB_ORDER_STORAGE_KEY]: JSON.stringify(saved) });
  assert.deepEqual(readTabOrder(CANONICAL, store), saved);
});

// ── 3. unknown saved ids are ignored ──────────────────────────

test('unknown / stale saved tab ids are ignored', () => {
  const out = resolveTabOrder(['gecko', 'ghost-view', 'scanner', 'workspace-2'], CANONICAL);
  assert.ok(!out.includes('ghost-view'));
  assert.ok(!out.includes('workspace-2'));
  assert.equal(out[0], 'gecko');
  assert.equal(out[1], 'scanner');
  // Nothing real was lost along with the junk.
  assert.deepEqual([...out].sort(), [...CANONICAL].sort());
});

test('non-string and duplicate saved entries cannot survive', () => {
  const out = resolveTabOrder(['scanner', 'scanner', null, 42, '', '  ', { view: 'radar' }, 'radar'], CANONICAL);
  assert.equal(out.filter(v => v === 'scanner').length, 1);
  assert.equal(out.filter(v => v === 'radar').length, 1);
  assert.deepEqual([...out].sort(), [...CANONICAL].sort());
  for (const v of out) assert.equal(typeof v, 'string');
});

// ── 4. new tabs are appended ──────────────────────────────────

test('tabs missing from a saved order are appended in canonical order', () => {
  // A user who customized before 'gecko' and 'manual' shipped.
  const saved = CANONICAL.filter(v => v !== 'gecko' && v !== 'manual').reverse();
  const out = resolveTabOrder(saved, CANONICAL);
  assert.deepEqual(out.slice(0, saved.length), saved, 'the saved order is preserved');
  assert.deepEqual(out.slice(saved.length), ['gecko', 'manual'], 'new tabs appended, canonical order');
  assert.equal(out.length, CANONICAL.length);
});

test('an empty saved array still yields every tab', () => {
  assert.deepEqual(resolveTabOrder([], CANONICAL), CANONICAL);
});

// ── 5. reset ──────────────────────────────────────────────────

test('reset drops the saved key so the canonical order returns', () => {
  const custom = ['manual', ...CANONICAL.filter(v => v !== 'manual')];
  const store = fakeStorage();
  assert.equal(writeTabOrder(custom, store), true);
  assert.deepEqual(readTabOrder(CANONICAL, store), custom);
  assert.equal(clearTabOrder(store), true);
  assert.equal(store.data[TAB_ORDER_STORAGE_KEY], undefined);
  assert.deepEqual(readTabOrder(CANONICAL, store), CANONICAL);
});

// ── move semantics ────────────────────────────────────────────

test('moveTab moves a tab left and right without losing or duplicating any', () => {
  const left = moveTab(CANONICAL, 'cockpit', -1);
  assert.deepEqual(left.slice(0, 3), ['scanner', 'cockpit', 'radar']);
  const right = moveTab(CANONICAL, 'scanner', 1);
  assert.deepEqual(right.slice(0, 2), ['radar', 'scanner']);
  for (const out of [left, right]) {
    assert.equal(out.length, CANONICAL.length);
    assert.equal(new Set(out).size, CANONICAL.length);
  }
});

test('moves clamp at the ends and unknown ids are a no-op', () => {
  assert.deepEqual(moveTab(CANONICAL, 'scanner', -1), CANONICAL, 'first tab cannot go further left');
  assert.deepEqual(moveTab(CANONICAL, 'manual', 1), CANONICAL, 'last tab cannot go further right');
  assert.deepEqual(moveTab(CANONICAL, 'nope', -1), CANONICAL);
  assert.deepEqual(moveTab(CANONICAL, 'scanner', 0), CANONICAL);
  assert.deepEqual(moveTab(CANONICAL, 'scanner', NaN), CANONICAL);
  // The input array is never mutated.
  const before = CANONICAL.slice();
  moveTab(CANONICAL, 'gecko', -1);
  assert.deepEqual(CANONICAL, before);
});

test('canMove reports the real ends so the arrows can disable', () => {
  assert.equal(canMove(CANONICAL, 'scanner', -1), false);
  assert.equal(canMove(CANONICAL, 'scanner', 1), true);
  assert.equal(canMove(CANONICAL, 'manual', 1), false);
  assert.equal(canMove(CANONICAL, 'manual', -1), true);
  assert.equal(canMove(CANONICAL, 'ghost', -1), false);
});

test('repeated moves round-trip back to the canonical order', () => {
  let order = CANONICAL.slice();
  for (let i = 0; i < 5; i += 1) order = moveTab(order, 'gecko', -1);
  for (let i = 0; i < 5; i += 1) order = moveTab(order, 'gecko', 1);
  assert.deepEqual(order, CANONICAL);
});

// ── 10. storage failure must not crash ────────────────────────

test('a localStorage failure degrades to the default order instead of throwing', () => {
  for (const mode of ['throw-read', 'throw-write', 'throw-all']) {
    const store = fakeStorage({}, mode);
    assert.doesNotThrow(() => readTabOrder(CANONICAL, store), mode);
    assert.deepEqual(readTabOrder(CANONICAL, store), CANONICAL, mode);
    assert.doesNotThrow(() => writeTabOrder(CANONICAL, store), mode);
    assert.doesNotThrow(() => clearTabOrder(store), mode);
  }
  // A write that could not be stored reports false so the caller can say so.
  assert.equal(writeTabOrder(CANONICAL, fakeStorage({}, 'throw-write')), false);
  // Absent storage entirely (SSR / private mode with no object at all).
  assert.deepEqual(readTabOrder(CANONICAL, null), CANONICAL);
});

test('corrupt stored JSON falls back to the default order', () => {
  for (const raw of ['{not json', 'null', '"scanner"', '{"a":1}', '[]']) {
    const store = fakeStorage({ [TAB_ORDER_STORAGE_KEY]: raw });
    assert.deepEqual(readTabOrder(CANONICAL, store), CANONICAL, raw);
  }
});

// ── 9. no undefined / null / NaN leaks ────────────────────────

test('no resolved order ever contains undefined, null, NaN or a blank id', () => {
  const inputs = [null, undefined, [], ['scanner'], ['x', null, undefined, NaN, 'radar'],
    CANONICAL, [...CANONICAL].reverse(), 'not-an-array', 42, {}];
  for (const saved of inputs) {
    const out = resolveTabOrder(saved, CANONICAL);
    assert.equal(out.length, CANONICAL.length, JSON.stringify(saved));
    for (const id of out) {
      assert.equal(typeof id, 'string');
      assert.ok(id.trim().length > 0);
      assert.ok(!['undefined', 'null', 'NaN'].includes(id));
      assert.ok(CANONICAL.includes(id));
    }
  }
});

test('a broken canonical list cannot produce junk entries', () => {
  assert.deepEqual(resolveTabOrder(null, ['a', null, 'a', '', 'b']), ['a', 'b']);
  assert.deepEqual(resolveTabOrder(null, null), []);
});

// ── behavioural: the real _applyTabOrder against a DOM stub ───
//
// There is no DOM library in this repo, so (matching the convention in
// frontend.canonical-context-cutover.test.mjs) the real function is extracted
// from the shipped terminal.js and run against a minimal stub. This is what
// proves the two load-bearing claims — no duplicate tabs, and the active tab
// survives a reorder — rather than asserting them from source text.

function makeEl(tag, { view = null, cls = [], id = null } = {}) {
  const el = {
    tagName: tag, id, parentNode: null, children: [],
    dataset: view ? { view } : {},
    classList: {
      _s: new Set(cls),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
    },
    appendChild(child) {
      // Real appendChild MOVES an already-parented node. Reproducing that is
      // the whole point: it is why reordering cannot duplicate a tab.
      if (child.parentNode) {
        const i = child.parentNode.children.indexOf(child);
        if (i !== -1) child.parentNode.children.splice(i, 1);
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
  };
  return el;
}

function makeTabBar(order = CANONICAL, activeView = 'scanner') {
  const bar = makeEl('div', { id: 'tabs' });
  for (const view of order) {
    bar.appendChild(makeEl('div', { view, cls: view === activeView ? ['tab', 'on'] : ['tab'] }));
  }
  const tools = makeEl('div', { id: 'tab-tools', cls: ['tab-tools'] });
  bar.appendChild(tools);
  const document = {
    getElementById: (id) => (id === 'tabs' ? bar : id === 'tab-tools' ? tools : null),
    querySelectorAll: (sel) => {
      if (sel === '#tabs .tab[data-view]') return bar.children.filter(c => c.classList.contains('tab') && c.dataset.view);
      return [];
    },
    querySelector: (sel) => {
      const m = /\[data-view="([^"]+)"\]/.exec(sel);
      if (m) return bar.children.find(c => c.dataset.view === m[1]) || null;
      return null;
    },
  };
  return { bar, tools, document };
}

function extractFn(name) {
  const start = terminalJs.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  let depth = 0;
  for (let j = terminalJs.indexOf('{', start); j < terminalJs.length; j += 1) {
    if (terminalJs[j] === '{') depth += 1;
    else if (terminalJs[j] === '}') { depth -= 1; if (depth === 0) return terminalJs.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

function loadTabDom(fixture) {
  const src = `${extractFn('_tabNodes')}\n${extractFn('_tabEl')}\n${extractFn('_applyTabOrder')}\n`
    + 'return { _tabNodes, _tabEl, _applyTabOrder };';
  return new Function('document', src)(fixture.document);
}

test('reordering the DOM keeps exactly one node per tab (no duplicates)', () => {
  const fx = makeTabBar();
  const api = loadTabDom(fx);
  const target = ['manual', 'gecko', ...CANONICAL.filter(v => v !== 'manual' && v !== 'gecko')];

  api._applyTabOrder(target);
  let views = fx.bar.children.filter(c => c.dataset.view).map(c => c.dataset.view);
  assert.deepEqual(views, target);
  assert.equal(views.length, CANONICAL.length);
  assert.equal(new Set(views).size, CANONICAL.length);

  // Applying repeatedly must be idempotent — this is where a naive
  // implementation would append clones and grow the bar every boot.
  api._applyTabOrder(target);
  api._applyTabOrder(target);
  views = fx.bar.children.filter(c => c.dataset.view).map(c => c.dataset.view);
  assert.equal(views.length, CANONICAL.length);
  assert.deepEqual(views, target);
});

test('the tools control stays last and is never treated as a tab', () => {
  const fx = makeTabBar();
  const api = loadTabDom(fx);
  api._applyTabOrder(['regime', ...CANONICAL.filter(v => v !== 'regime')]);
  assert.equal(fx.bar.children[fx.bar.children.length - 1].id, 'tab-tools');
  assert.equal(api._tabNodes().length, CANONICAL.length, 'tools is not counted as a tab');
  assert.ok(api._tabNodes().every(n => n.dataset.view));
});

test('the active tab is still the active tab after a reorder', () => {
  const fx = makeTabBar(CANONICAL, 'cockpit');
  const api = loadTabDom(fx);
  const before = fx.bar.children.find(c => c.classList.contains('on'));
  assert.equal(before.dataset.view, 'cockpit');

  api._applyTabOrder([...CANONICAL].reverse());

  const active = fx.bar.children.filter(c => c.classList.contains('on'));
  assert.equal(active.length, 1, 'exactly one active tab');
  assert.equal(active[0].dataset.view, 'cockpit', 'and it is the same view');
  assert.equal(active[0], before, 'the very same node was moved, not re-created');
});

test('sv() can still address Scanner / RADAR / Cockpit after a reorder', () => {
  const fx = makeTabBar();
  const api = loadTabDom(fx);
  api._applyTabOrder(['manual', 'gecko', 'regime', ...CANONICAL.filter(v => !['manual', 'gecko', 'regime'].includes(v))]);
  // Whatever the order, the tab that owns each view is still findable — this
  // is the lookup sv() is handed, and the reason position-based lookups had
  // to go.
  for (const view of ['scanner', 'radar', 'cockpit']) {
    const el = api._tabEl(view);
    assert.ok(el, `${view} tab resolvable`);
    assert.equal(el.dataset.view, view);
  }
  // SCANNER is no longer first, which is exactly what used to break.
  assert.notEqual(fx.bar.children[0].dataset.view, 'scanner');
  assert.equal(api._tabEl('scanner').dataset.view, 'scanner');
});

test('an order containing an unknown id reorders what it can and drops the rest', () => {
  const fx = makeTabBar();
  const api = loadTabDom(fx);
  api._applyTabOrder(resolveTabOrder(['ghost', 'manual', 'nope'], CANONICAL));
  const views = fx.bar.children.filter(c => c.dataset.view).map(c => c.dataset.view);
  assert.equal(views[0], 'manual');
  assert.equal(views.length, CANONICAL.length, 'nothing lost, nothing invented');
  assert.ok(!views.includes('ghost'));
});

// ── 8 + DOM wiring: no duplicates, sv() untouched ─────────────

test('reordering moves existing nodes, so a tab can never be duplicated', () => {
  // appendChild on a node already in the DOM MOVES it. Re-creating tabs would
  // drop their .on class, their inline onclick and their badge children.
  assert.match(terminalJs, /function _applyTabOrder\(order\)/);
  assert.match(terminalJs, /if \(node\) bar\.appendChild\(node\);/);
  assert.doesNotMatch(terminalJs.slice(terminalJs.indexOf('function _applyTabOrder')), /^[\s\S]{0,600}(innerHTML|createElement\('div'\)|cloneNode)/);
});

test('sv() remains the only view switcher and is not redefined', () => {
  assert.equal(terminalJs.match(/^function sv\(v, el\) \{/gm)?.length, 1, 'exactly one sv() definition');
  // The tab-order code must never call sv() or touch view elements.
  // Bounded to the tab-order block itself — the view-resolution helpers that
  // follow it in the file are sv()'s, not ours.
  const block = terminalJs.slice(terminalJs.indexOf('function _tabOrderApi()'), terminalJs.indexOf('function _viewCandidateIds('));
  assert.ok(block.length > 500, 'tab-order block not found');
  assert.ok(block.includes('function initTabOrder()'), 'block covers the whole tab-order section');
  assert.doesNotMatch(block, /\bsv\(/);
  // It must not resolve, show, hide or activate a view — only move tab nodes.
  // (`dataset.view` is a tab id, not a view element, so scan for the real
  // view-surface helpers instead of a bare `.view`.)
  assert.doesNotMatch(block, /_resolveViewTarget|_applyViewDisplay|querySelectorAll?\('\.view/);
  assert.doesNotMatch(block, /classList\.(add|remove)\('on'\)/);
  // The pure module is DOM-free and network-free.
  assert.doesNotMatch(tabOrderCode, /document\.|\bfetch\s*\(|XMLHttpRequest|innerHTML/);
});

test('the active tab stays active: reordering never clears or sets .on', () => {
  const block = terminalJs.slice(terminalJs.indexOf('function _applyTabOrder'), terminalJs.indexOf('function initTabOrder'));
  assert.doesNotMatch(block, /classList\.remove\('on'\)/);
  assert.doesNotMatch(block, /classList\.add\('on'\)/);
  // Only sv() manages the active tab, exactly as before.
  assert.match(terminalJs, /document\.querySelectorAll\('\.tab'\)\.forEach\(x => x\.classList\.remove\('on'\)\);/);
});

// Regression: three call sites grabbed "the first tab in the bar" and assumed
// it was SCANNER. With a reordered bar that highlights the wrong tab, and via
// the tab's data-target it can resolve the WRONG VIEW entirely.
test('view jumps address the tab by view id, never by position', () => {
  assert.doesNotMatch(terminalJs, /document\.querySelector\('#tabs \.tab'\)/);
  assert.match(terminalJs, /function _tabEl\(viewId\)/);
  // Bubble + heatmap "jump to scanner row" buttons.
  assert.equal((terminalJs.match(/#tabs \.tab\[data-view=scanner\]/g) || []).length, 2);
  // Delegated coin-tab jump resolves the tab that owns the target view.
  assert.match(terminalJs, /_tabEl\(targetTab\)/);
  assert.match(terminalJs, /\[data-view="\$\{targetTab\}"\]/);
});

test('the reorder control exists, is opt-in, and offers a reset', () => {
  assert.match(indexHtml, /id="tab-reorder-toggle"/);
  assert.match(indexHtml, /id="tab-reorder-reset"[^>]*hidden/);
  assert.match(indexHtml, /src="\/js\/tab-order\.js\?v=/);
  assert.match(terminalJs, /function _setTabReorderMode\(on\)/);
  assert.match(terminalJs, /function _resetTabOrder\(\)/);
  assert.match(terminalJs, /initTabOrder\(\);/);
  // Move buttons must not fall through to the tab's inline onclick.
  assert.match(terminalJs, /if \(move\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/);
  assert.match(terminalCss, /\.tab-tools\{/);
  assert.match(terminalCss, /\.tab-move\{/);
});

test('the tools block is not itself a tab', () => {
  // It lives inside #tabs but carries no data-view, and every reorder read is
  // scoped to .tab[data-view] — otherwise it would be dragged into the order.
  assert.match(indexHtml, /<div class="tab-tools" id="tab-tools">/);
  assert.doesNotMatch(indexHtml, /class="tab-tools"[^>]*data-view=/);
  assert.match(terminalJs, /querySelectorAll\('#tabs \.tab\[data-view\]'\)/);
  assert.match(terminalJs, /if \(tools\) bar\.appendChild\(tools\);/);
});

test('a missing tab-order module leaves the shipped bar intact', () => {
  assert.match(terminalJs, /\[TAB-ORDER\] tab-order\.js not loaded/);
  assert.match(terminalJs, /if \(tools\) tools\.hidden = true;/);
});

// ── isolation from every gated surface ────────────────────────

test('tab order never reaches RADAR, ENTRY_READY, Telegram or any trading path', () => {
  const backendFiles = [
    'netlify/functions/bot.mjs',
    'netlify/functions/cron-alerts.mjs',
    'netlify/functions/telegram.mjs',
    'netlify/functions/personal-alerts.mjs',
    'scripts/radar/trading-radar.mjs',
    'scripts/auto/auto-trader.mjs',
    'scripts/cockpit/trade-cockpit.mjs',
  ];
  for (const f of backendFiles) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /tabOrder|tab-order|tabReorder/i, `${f} must not know about tab order`);
  }
  assert.doesNotMatch(tabOrderCode, /ENTRY_READY|STRICT_ABSORB|telegram|reclaim|absorb|executionIntent/i);
  // One global, read-only bridge — nothing else.
  const globals = [...new Set(tabOrderCode.match(/window\.[A-Za-z_$][\w$]*/g) || [])];
  assert.deepEqual(globals, ['window.__tabOrder']);
});

test('storage key is the agreed versioned id and is the only key written', () => {
  assert.equal(TAB_ORDER_STORAGE_KEY, 'terminalX.tabOrder.v1');
  const keys = [...new Set(tabOrderCode.match(/setItem\(([A-Z_]+)/g) || [])];
  assert.deepEqual(keys, ['setItem(TAB_ORDER_STORAGE_KEY']);
});
