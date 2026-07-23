// Frontend guards for the advisory-only "Live microstructure read" surface in
// the Trading RADAR Focus card and the Cockpit import panel. String/AST-level
// (the file is a classic script, not a module) plus one executable check of the
// pure pair resolver run in isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');

function extractFn(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  assert.ok(start >= 0, `could not find ${sig}`);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// ── 1. RADAR Focus mounts the slot ───────────────────────────
test('RADAR Focus card mounts #radar-live-microstructure-slot', () => {
  assert.ok(terminalJs.includes("_liveMicroSlotHtml('radar-live-microstructure-slot', _resolveLiveMicroTarget(selected))"),
    'RADAR Focus card must render the radar live-microstructure slot for the selected candidate');
  assert.ok(terminalJs.includes("_refreshLiveMicrostructure('radar-live-microstructure-slot')"),
    'renderTradingRadarPanel must refresh the radar slot');
});

// ── 2. Cockpit mounts the slot ───────────────────────────────
test('Cockpit import panel mounts #cockpit-live-microstructure-slot', () => {
  assert.ok(terminalJs.includes("_liveMicroSlotHtml('cockpit-live-microstructure-slot', _resolveLiveMicroTarget(f))"),
    'Cockpit RADAR focus card must render the cockpit live-microstructure slot');
  assert.ok(terminalJs.includes("_refreshLiveMicrostructure('cockpit-live-microstructure-slot')"),
    'renderCockpit must refresh the cockpit slot');
});

// ── 3. Advisory wording names the non-effects explicitly ─────
test('advisory text states it is advisory-read-only and does not satisfy strict Absorb / unblock ENTRY_READY / Telegram', () => {
  const m = terminalJs.match(/const LIVE_MICRO_ADVISORY_TEXT = '([^']+)'/);
  assert.ok(m, 'LIVE_MICRO_ADVISORY_TEXT must be defined');
  const text = m[1];
  assert.match(text, /Advisory read only/i);
  assert.match(text, /does not satisfy strict Absorb/i);
  assert.match(text, /ENTRY_READY/);
  assert.match(text, /Telegram/);
  assert.match(text, /server gate/i);
});

// ── 4. Cache token fully bumped to 6i4 ───────────────────────
test('all versioned assets in index.html are bumped to exactly one token: 6i4', () => {
  const versions = Array.from(indexHtml.matchAll(/\?v=([a-z0-9]+)/g)).map((x) => x[1]);
  assert.ok(versions.length >= 10, 'expected the full versioned asset set');
  assert.ok(versions.every((v) => v === '6i4'), `all asset versions must be 6i4, saw: ${[...new Set(versions)].join(',')}`);
  assert.doesNotMatch(indexHtml, /\?v=6i3\b/, 'the previous cache-bust token must be gone');
});

// ── 5. No inline <script> injected for this feature ──────────
test('the live-microstructure render functions inject no inline <script>', () => {
  const rendered = [
    extractFn(terminalJs, '_liveMicroInnerHtml'),
    extractFn(terminalJs, '_liveMicroSlotHtml'),
  ].join('\n');
  assert.equal(/<script\b/i.test(rendered), false, 'rendered HTML must never contain an inline <script>');
  // Sanity: the feature also never smuggles an event handler attribute.
  assert.equal(/\son\w+=/i.test(rendered), false, 'rendered HTML must not carry inline event handlers');
});

// ── 6. Pair resolver handles a full pair AND a base symbol safely ──
test('_resolveLiveMicroTarget: keeps a quoted pair, appends USDT to a base, reads market', () => {
  const factory = new Function(`${extractFn(terminalJs, '_resolveLiveMicroTarget')}\nreturn _resolveLiveMicroTarget;`);
  const resolve = factory();

  // Full spot pair, already quoted → unchanged, spot.
  assert.deepEqual(resolve({ symbol: 'BTCUSDT' }), { pair: 'BTCUSDT', market: 'spot' });
  // USDC-quoted pair must NOT become USDCUSDT.
  assert.deepEqual(resolve({ symbol: 'ERAUSDC' }), { pair: 'ERAUSDC', market: 'spot' });
  // Base-only symbol → append USDT.
  assert.deepEqual(resolve({ symbol: 'BTC' }), { pair: 'BTCUSDT', market: 'spot' });
  // Futures / ALPHA venue → futures market.
  assert.deepEqual(resolve({ symbol: 'LITUSDT', binance_market: 'futures' }), { pair: 'LITUSDT', market: 'futures' });
  assert.deepEqual(resolve({ symbol: 'LIT', exchange: 'ALPHA' }), { pair: 'LITUSDT', market: 'futures' });
  // Dirty formatting is sanitized.
  assert.deepEqual(resolve({ symbol: 'btc/usdt' }), { pair: 'BTCUSDT', market: 'spot' });
  // No symbol → null (never a bogus pair).
  assert.equal(resolve({}), null);
  assert.equal(resolve(null), null);
});

// ── 7. The refresh path is fail-closed + cached/deduped (no spam) ──
test('refresh path caches/dedupes and fails closed', () => {
  const fn = extractFn(terminalJs, '_refreshLiveMicrostructure');
  assert.match(fn, /_liveMicroInFlight\.has\(key\)/, 'must dedupe concurrent fetches per key');
  assert.match(fn, /LIVE_MICRO_TTL_MS/, 'must honor a client-side TTL cache');
  assert.match(fn, /AbortController/, 'must time out the fetch (fail closed)');
  assert.match(fn, /state: 'error'/, 'must surface a visible error state');
  assert.match(fn, /console\.warn\('\[LIVE-MICRO\]'/, 'must log failures (error-observability)');
});
