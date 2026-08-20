// Boot-order invariants for apps/edge/public/js/terminal.js.
//
// WHY THIS FILE EXISTS — a production outage, 2026-08-20. The terminal booted
// into a blank Scanner with empty data panels and one toast:
//
//   "Unhandled promise rejection — can't access lexical declaration
//    'DEFAULT_COLUMN_ORDER' before initialization"
//
// The chain: terminal.js has a top-level statement (~line 12770) that calls
// `AuthClient.init()`. That call can adopt a stored session and notify listeners
// WITHOUT awaiting anything, and this file's `onChange` handler answers a
// notification by booting the whole terminal —
// `_applyAuthenticatedState()` → `initTerminalApp()` → `initColumnDnD()` →
// `_ensureColumnPositions()`, whose first statement reads
// `DEFAULT_COLUMN_ORDER`. That `const` is declared ~170 lines FURTHER DOWN, so
// while the script is still being evaluated it sits in the temporal dead zone
// and reading it is a ReferenceError. Thrown inside a promise, it surfaced as an
// unhandled rejection and the app never finished booting.
//
// terminal.js is a 14k-line classic script whose top-level order is therefore
// load-bearing, and it is not practical to boot it under node:test (no DOM, no
// jsdom in devDependencies). So the guards here are:
//   1. a source-order invariant — the constant is declared above every use;
//   2. a boot-order invariant — nothing that boots the app runs as a top-level
//      statement before the column constants are initialized;
//   3. an executable proof, in a vm, that the inline shape really does throw the
//      production error and the deferred shape really does not.
//
// If a future change reintroduces an eager top-level boot, (2) fails here rather
// than the terminal breaking for every user with a valid stored session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const lines = source.split(/\r?\n/);

// Comments legitimately mention these identifiers before they exist; only real
// code counts, so strip line comments before scanning.
function code(line) {
  return line.replace(/\/\/.*$/, '');
}

const DECL_RE = /^const DEFAULT_COLUMN_ORDER\s*=/;

function declarationLine() {
  const index = lines.findIndex((line) => DECL_RE.test(line));
  assert.notEqual(index, -1, 'const DEFAULT_COLUMN_ORDER must exist at the top level of terminal.js');
  return index;
}

// ── 1) source-order invariant ──

test('DEFAULT_COLUMN_ORDER is declared above every use', () => {
  const decl = declarationLine();
  const uses = lines
    .map((line, i) => ({ i, text: code(line) }))
    .filter(({ text }) => text.includes('DEFAULT_COLUMN_ORDER'))
    .map(({ i }) => i);

  assert.ok(uses.length > 1, 'the constant should be used somewhere');
  assert.equal(
    Math.min(...uses),
    decl,
    `DEFAULT_COLUMN_ORDER is read on line ${Math.min(...uses) + 1} but only declared on line ${decl + 1} — `
    + 'a read that executes before the declaration is a TDZ ReferenceError',
  );
});

test('the column-layout constants are declared above _ensureColumnPositions', () => {
  // _ensureColumnPositions() is the boot-time reader that broke production. Every
  // binding it touches in its first statements must already be initialized by the
  // time the function body can run.
  const body = lines.findIndex((line) => /^function _ensureColumnPositions\(\)/.test(line));
  assert.notEqual(body, -1, '_ensureColumnPositions must exist');

  for (const name of ['DEFAULT_COLUMN_ORDER', '_columnOrder', '_columnPositions', 'COLUMN_GAP_PX']) {
    const decl = lines.findIndex((line) => new RegExp(`^(?:const|let) ${name}\\s*=`).test(line));
    assert.notEqual(decl, -1, `${name} must be declared at the top level`);
    assert.ok(decl < body, `${name} (line ${decl + 1}) must be declared above _ensureColumnPositions (line ${body + 1})`);
  }
});

// ── 2) boot-order invariant: nothing boots the app during evaluation ──

test('the native-session restore is DEFERRED, not a bare top-level IIFE', () => {
  assert.doesNotMatch(
    source,
    // Anchored to the start of a line: `queueMicrotask(async function …` also
    // contains "(async function", and matching that would make this guard
    // impossible to satisfy.
    /^\(async function _restoreNativeSession/m,
    'a bare IIFE runs during script evaluation and boots the terminal ~170 lines above the column '
    + 'constants — that is the production TDZ crash. Keep it inside queueMicrotask()/setTimeout().',
  );
  // The deferral mechanism moved on: a microtask runs as soon as THIS file
  // finishes, which fixes the TDZ crash but is still BEFORE the deferred ES
  // modules beside terminal.js have executed — so a fast restore booted the app
  // while window.__tabOrder did not yet exist. DOMContentLoaded fires after every
  // deferred module has run, so it satisfies this invariant strictly harder.
  // The readyState check keeps a microtask path for an already-parsed document.
  assert.match(
    source,
    /if \(document\.readyState === 'loading'\) \{/,
    'the restore must be gated on document readiness, not started during evaluation',
  );
  assert.match(
    source,
    /document\.addEventListener\('DOMContentLoaded', _restoreNativeSession, \{ once: true \}\)/,
    'while the document is parsing the restore must wait for DOMContentLoaded, so the',
  );
  assert.match(
    source,
    /queueMicrotask\(_restoreNativeSession\)/,
    'an already-parsed document still defers past the evaluation of this file',
  );
});

test('the top-level statement that calls AuthClient.init() is deferred', () => {
  const callIndex = lines.findIndex((line) => code(line).includes('window.AuthClient.init()'));
  assert.notEqual(callIndex, -1, 'the restore must still call AuthClient.init()');

  // Walk back to the top-level statement that encloses the call (the nearest
  // preceding line starting in column 0 that is not a comment).
  let statement = -1;
  for (let i = callIndex; i >= 0; i -= 1) {
    const text = lines[i];
    if (/^\S/.test(text) && !text.startsWith('//')) { statement = i; break; }
  }
  assert.notEqual(statement, -1, 'could not find the enclosing top-level statement');
  // A DECLARATION is not an execution (same principle as the test below). When
  // the call lives inside `async function _restoreNativeSession()`, what has to
  // be deferred is every top-level INVOCATION of it — and there must be no bare
  // one, or the boot happens during evaluation exactly as before.
  if (/^(?:async\s+)?function _restoreNativeSession/.test(lines[statement])) {
    const invocations = lines.filter((line) => /^\s*[^\s/].*_restoreNativeSession[^A-Za-z0-9_]/.test(code(line))
      && !/^(?:async\s+)?function _restoreNativeSession/.test(line));
    assert.ok(invocations.length > 0, 'the restore is declared but never started');
    for (const line of invocations) {
      assert.match(
        line,
        /queueMicrotask\(|setTimeout\(|addEventListener\('DOMContentLoaded'/,
        `"${line.trim()}" starts the restore without deferring it; it must wait until this file `
        + 'is fully initialized (and, while parsing, until the deferred modules have run)',
      );
    }
    assert.doesNotMatch(
      source,
      /^_restoreNativeSession\(\)/m,
      'a bare top-level call runs AuthClient.init() during script evaluation',
    );
  } else {
    assert.match(
      lines[statement],
      /queueMicrotask\(|setTimeout\(/,
      `line ${statement + 1} runs AuthClient.init() during script evaluation; it must be deferred `
      + 'so the whole file is initialized before a stored session can boot the terminal',
    );
  }
});

test('no top-level statement boots the terminal before the column constants', () => {
  const decl = declarationLine();
  const offenders = [];
  for (let i = 0; i < decl; i += 1) {
    const text = code(lines[i]);
    // A declaration is not an execution: `function _applyAuthenticatedState(…)`
    // defines the boot path, it does not run it.
    if (/^(?:async\s+)?function\s/.test(text)) continue;
    if (!/\binitTerminalApp\(\)|_applyAuthenticatedState\(/.test(text)) continue;
    // Indented = nested inside a function or callback, which only runs later.
    // Column 0 = a statement executed right now, during evaluation.
    if (/^\S/.test(text)) offenders.push(`${i + 1}: ${text.trim()}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'these top-level statements boot the app before the column-layout constants exist:\n'
    + offenders.join('\n'),
  );
});

// ── 3) executable proof of the mechanism ──

test('the inline shape throws the exact production error; the deferred shape does not', async () => {
  const shape = (trigger) => `
    globalThis.result = null;
    globalThis.error = null;
    function boot() { return DECLARED_LATER.slice(); }
    ${trigger}
    const DECLARED_LATER = ['rank', 'coin'];
  `;

  // Inline: the trigger runs while the script is still being evaluated.
  const inlineCtx = vm.createContext({ queueMicrotask });
  vm.runInContext(
    shape('(function () { try { globalThis.result = boot(); } catch (e) { globalThis.error = e; } })();'),
    inlineCtx,
  );
  assert.equal(inlineCtx.result, null, 'the inline trigger must not succeed');
  // `instanceof` is realm-bound and a vm context carries its own intrinsics, so
  // compare the error NAME rather than the constructor.
  assert.equal(
    inlineCtx.error && inlineCtx.error.name,
    'ReferenceError',
    `expected a ReferenceError, got ${inlineCtx.error}`,
  );
  // V8 says "Cannot access 'X' before initialization"; SpiderMonkey (the browser
  // that produced the production toast) says "can't access lexical declaration
  // 'X' before initialization". Both end the same way.
  assert.match(inlineCtx.error.message, /before initialization/);

  // Deferred: the trigger runs once evaluation has completed.
  const deferredCtx = vm.createContext({ queueMicrotask });
  vm.runInContext(
    shape('queueMicrotask(function () { try { globalThis.result = boot(); } catch (e) { globalThis.error = e; } });'),
    deferredCtx,
  );
  // Let the queued microtask run.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(deferredCtx.error, null, `the deferred trigger must not throw, got ${deferredCtx.error}`);
  // Same realm caveat as above: the array comes from the vm context, so its
  // prototype is not this realm's Array. Compare the contents, not the object.
  assert.equal(
    Array.isArray(deferredCtx.result) || deferredCtx.result.length === 2, true,
    'the deferred trigger must return the constant',
  );
  assert.equal(deferredCtx.result.join(','), 'rank,coin', 'and it must see the fully initialized constant');
});
