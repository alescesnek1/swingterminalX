// Containment guards: Arkham Intel must stay a leaf.
//
// The single largest risk in adding an on-chain intelligence source to a
// real-money-adjacent terminal is that it quietly becomes a trading input. These
// tests read the actual source tree and fail if any RADAR / ENTRY_READY / strict
// Absorb / Reclaim / Telegram / alert / order / Scanner-ranking module ever
// references Arkham, and if the skeleton ever grows a scheduler or a WebSocket.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Every source directory that could contain a gate, a sender, or an order path.
const SCAN_DIRS = ['netlify/functions', 'scripts', 'apps/edge/netlify/edge-functions', 'apps/edge/public/js', 'apps/ingest'];
// The only files in the repo that are allowed to know Arkham exists.
const ARKHAM_OWNED = new Set([
  'netlify/functions/_arkham-client.mjs',
  'netlify/functions/arkham-token-intel.mjs',
  'apps/edge/public/js/terminal.js',   // the disabled UI placeholder only
]);

function walk(dir, out = []) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(rel, out);
    } else if (/\.(mjs|js)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const allSources = SCAN_DIRS.flatMap((dir) => walk(dir));

test('the source tree is actually being scanned (guard against a silent zero-file sweep)', () => {
  assert.ok(allSources.length > 50, `expected to scan the real tree, saw ${allSources.length} files`);
  assert.ok(allSources.includes('netlify/functions/cron-alerts.mjs'));
  assert.ok(allSources.includes('netlify/functions/_arkham-client.mjs'));
});

test('only the Arkham-owned files reference Arkham at all', () => {
  const offenders = allSources.filter((rel) => !ARKHAM_OWNED.has(rel) && /arkham|arkm\.com/i.test(read(rel)));
  assert.deepEqual(offenders, [], `these files must not reference Arkham: ${offenders.join(', ')}`);
});

test('no trading, alert, or gate module imports the Arkham adapter', () => {
  // Named explicitly (rather than pattern-matched) so a rename cannot quietly
  // drop a module out of this list.
  const GATE_MODULES = [
    'netlify/functions/cron-alerts.mjs',
    'netlify/functions/personal-alerts.mjs',
    'netlify/functions/personal-alerts-diagnostic.mjs',
    'netlify/functions/telegram.mjs',
    'netlify/functions/morning-briefing.mjs',
    'netlify/functions/_radar-context-publisher.mjs',
    'netlify/functions/_radar-valuation-context.mjs',
    'netlify/functions/_market-context-absorb.mjs',
    'netlify/functions/_market-context-collector.mjs',
    'netlify/functions/_personal-watch-triggers.mjs',
    'netlify/functions/cockpit-radar-state.mjs',
    'scripts/radar/trading-radar.mjs',
  ];
  for (const rel of GATE_MODULES) {
    const src = read(rel);
    assert.equal(/_arkham-client|arkham-token-intel/i.test(src), false, `${rel} must not import Arkham`);
    assert.equal(/arkham/i.test(src), false, `${rel} must not mention Arkham`);
  }
});

test('the Arkham adapter imports nothing from RADAR, trading, alerting or the store', () => {
  const client = read('netlify/functions/_arkham-client.mjs');
  const imports = [...client.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(imports, [], 'the adapter must stay dependency-free');
  assert.equal(/require\(|await import\(/.test(client), false);
});

test('the endpoint imports only auth and the Arkham adapter', () => {
  const endpoint = read('netlify/functions/arkham-token-intel.mjs');
  const dynamic = [...endpoint.matchAll(/import\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
  const statik = [...endpoint.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
  assert.deepEqual(dynamic, ['./_arkham-client.mjs', './_auth.mjs']);
  assert.deepEqual(statik, [], 'no static imports — the adapter and auth are loaded lazily');
  // Scan the MODULE SPECIFIERS, not the prose: the header comment names the gates
  // it is isolated from, and naming them is the point.
  const specifiers = [...dynamic, ...statik].join(' ').toLowerCase();
  for (const f of ['_db.mjs', 'market-context-store', 'fleet-store', 'telegram', 'binance', 'radar', 'orderbook']) {
    assert.equal(specifiers.includes(f), false, `the endpoint must not import ${f}`);
  }
});

test('the skeleton adds no scheduler, no cron, and no WebSocket', () => {
  for (const rel of ['netlify/functions/_arkham-client.mjs', 'netlify/functions/arkham-token-intel.mjs']) {
    const src = read(rel);
    assert.equal(/schedule\s*:/.test(src), false, `${rel} must not declare a schedule`);
    assert.equal(/setInterval|setTimeout\(\s*\(\)\s*=>\s*[a-zA-Z_$]*etch/.test(src), false, `${rel} must not poll`);
    // Scan for stream USAGE, not the word: both files explain in prose that they
    // deliberately open no WebSocket, and that explanation must survive.
    assert.equal(/new WebSocket|wss:\/\/|['"`]\/ws\//.test(src), false, `${rel} must not open a stream`);
  }
  // No GitHub Actions workflow may drive it either.
  const workflowsDir = path.join(root, '.github/workflows');
  if (fs.existsSync(workflowsDir)) {
    for (const f of fs.readdirSync(workflowsDir)) {
      assert.equal(/arkham/i.test(fs.readFileSync(path.join(workflowsDir, f), 'utf8')), false, `${f} must not reference Arkham`);
    }
  }
});

test('the client is bounded, retry-free and single-host', () => {
  const client = read('netlify/functions/_arkham-client.mjs');
  assert.match(client, /export const ARKHAM_API_HOST = 'api\.arkm\.com'/);
  assert.match(client, /new AbortController\(\)/);
  assert.match(client, /clearTimeout\(timer\)/);
  // No retry/backoff loop: on a metered API a retry storm is a cost incident.
  assert.equal(/for\s*\(.*attempt|retries?\s*[<=]|while\s*\(\s*attempt/i.test(client), false);
});

test('the Arkham surface holds no secret literal and no env write', () => {
  for (const rel of ['netlify/functions/_arkham-client.mjs', 'netlify/functions/arkham-token-intel.mjs', 'docs/arkham-intel-integration.md']) {
    const src = read(rel);
    // No assignment to process.env anywhere — this feature never sets config.
    assert.equal(/process\.env\.[A-Z_]+\s*=[^=]/.test(src), false, `${rel} must not write env`);
    // No key-shaped literal.
    assert.equal(/ARKHAM_API_KEY\s*[:=]\s*['"][^'"]{8,}['"]/.test(src), false, `${rel} must not contain a key literal`);
  }
});

test('the UI placeholder never auto-fetches Arkham on render', () => {
  const terminalJs = read('apps/edge/public/js/terminal.js');
  // The slot painter must be pure HTML — no fetch, no refresh call.
  const start = terminalJs.indexOf('function _arkhamIntelSlotHtml(symbol)');
  const end = terminalJs.indexOf('async function _checkArkhamIntel(symbol)');
  assert.ok(start > 0 && end > start, 'the render block is locatable');
  const renderBlock = terminalJs.slice(start, end);
  assert.equal(/fetch\(/.test(renderBlock), false, 'the placeholder must not fetch while painting');
  assert.equal(/setInterval|setTimeout/.test(renderBlock), false, 'the placeholder must not schedule anything');

  // The only fetch is inside the explicitly-triggered check, and there is exactly one.
  const arkhamRegion = terminalJs.slice(start, terminalJs.indexOf('function _cpUpdateScannerPrice()'));
  assert.equal((arkhamRegion.match(/fetch\(/g) || []).length, 1, 'exactly one on-demand request path');
  assert.equal(/setInterval/.test(arkhamRegion), false, 'no polling interval anywhere in the Arkham block');
});

test('the Arkham UI block touches no gate, score, sort or order action', () => {
  const terminalJs = read('apps/edge/public/js/terminal.js');
  const start = terminalJs.indexOf('const ARKHAM_INTEL_TIMEOUT_MS');
  const end = terminalJs.indexOf('function _cpUpdateScannerPrice()');
  assert.ok(start > 0 && end > start);
  const block = terminalJs.slice(start, end);
  // Actionable identifiers: nothing here may prefill an order, import a setup,
  // move a score, or change the sort. (The gate NAMES do appear in the block —
  // in the prose that denies them — so this scans for the callable surface.)
  for (const forbidden of ['_cpFillForm', '_cpPrefillFromRadar', 'cockpit-import-radar', 'leadScore', 'LEAD_SCORE', 'sortKey', 'placeOrder', 'sendTelegram', 'evaluateTradingRadar']) {
    assert.equal(block.includes(forbidden), false, `the Arkham UI block must not reference ${forbidden}`);
  }
  // And the denial itself must be on screen, not just in a comment.
  assert.match(block, /Advisory only — does not affect ENTRY_READY, RADAR, strict Absorb, Reclaim, Telegram, alerts, Scanner ranking, or any order path\. Not investment advice\./);
});
