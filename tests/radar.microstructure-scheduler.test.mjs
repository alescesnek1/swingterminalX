import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const workflowPath = path.join(repoRoot, '.github/workflows/radar-microstructure.yml');
const docsPath = path.join(repoRoot, 'docs/radar-microstructure.md');
const netlifyFnPath = path.join(repoRoot, 'netlify/functions/radar-microstructure-refresh.mjs');

test('scheduler workflow exists', () => {
  assert.ok(fs.existsSync(workflowPath), 'radar-microstructure.yml workflow must exist');
});

const workflow = fs.readFileSync(workflowPath, 'utf8');

test('workflow runs the read-only static microstructure producer', () => {
  assert.match(workflow, /scripts\/radar\/radar-microstructure-producer\.mjs/);
});

// Production cron has moved OFF GitHub Actions (Binance fapi 451 on hosted
// runners). The workflow must be manual-only: workflow_dispatch, no schedule.
test('workflow has NO automatic schedule cron (manual diagnostic only)', () => {
  assert.doesNotMatch(workflow, /^\s*schedule:/m, 'workflow must not define a schedule:');
  assert.doesNotMatch(workflow, /cron:/, 'workflow must not define a cron:');
  assert.match(workflow, /workflow_dispatch/, 'workflow must keep manual workflow_dispatch');
});

test('workflow documents the Binance fapi 451 region block', () => {
  assert.match(workflow, /451/);
});

test('workflow does not reference local-binance-worker', () => {
  assert.doesNotMatch(workflow, /local-binance-worker/);
});

test('workflow does not reference worker-session', () => {
  assert.doesNotMatch(workflow, /worker-session/);
});

test('workflow does not reference order/signed Binance endpoints', () => {
  const forbidden = [/fapi\/v1\/order/, /api\/v3\/order/, /\bdapi\b/, /\bsapi\b/];
  for (const re of forbidden) {
    assert.doesNotMatch(workflow, re, `workflow must not reference ${re}`);
  }
});

test('workflow does not require Binance API key/secret', () => {
  assert.doesNotMatch(workflow, /BINANCE_API_KEY/);
  assert.doesNotMatch(workflow, /BINANCE_API_SECRET/);
});

test('workflow does not reference Telegram or ENTRY_READY', () => {
  assert.doesNotMatch(workflow, /ENTRY_READY/);
  assert.doesNotMatch(workflow, /telegram/i);
});

test('workflow injects BOT_WORKER_TOKEN from the GitHub Actions secret', () => {
  // Exact injection line — the producer reads process.env.BOT_WORKER_TOKEN, so
  // the step env must map it from the repository secret (whitespace-tolerant).
  assert.match(workflow, /BOT_WORKER_TOKEN:\s*\$\{\{\s*secrets\.BOT_WORKER_TOKEN\s*\}\}/);
});

test('workflow sets the full producer env block', () => {
  assert.match(workflow, /CONTROL_BASE_URL:\s*https:\/\/swingterminalx\.netlify\.app/);
  assert.match(workflow, /WORKER_RADAR_MICROSTRUCTURE_ENABLED:\s*['"]true['"]/);
  assert.match(workflow, /WORKER_RADAR_MICROSTRUCTURE_TOP_N:\s*['"]5['"]/);
  assert.match(workflow, /WORKER_RADAR_MICROSTRUCTURE_CACHE_MS:\s*['"]10000['"]/);
});

// ── Netlify Scheduled Function (the production scheduler) ────────────────────

test('netlify scheduled function exists', () => {
  assert.ok(fs.existsSync(netlifyFnPath), 'radar-microstructure-refresh.mjs must exist');
});

const netlifyFn = fs.readFileSync(netlifyFnPath, 'utf8');

test('netlify function reuses the shared producer runner', () => {
  assert.match(netlifyFn, /runRadarMicrostructureProducer/);
  assert.match(netlifyFn, /radar-microstructure-producer\.mjs/);
});

test('netlify function declares a scheduled cron', () => {
  assert.match(netlifyFn, /export\s+const\s+config\s*=\s*\{[\s\S]*schedule/);
  assert.match(netlifyFn, /cron|\*\/10/);
});

test('netlify function protects manual invocation with the worker token', () => {
  assert.match(netlifyFn, /x-bot-worker-token/i);
});

test('netlify function is read-only: no worker/session/order/signed paths', () => {
  assert.doesNotMatch(netlifyFn, /local-binance-worker/);
  assert.doesNotMatch(netlifyFn, /worker-session/);
  for (const re of [/fapi\/v1\/order/, /api\/v3\/order/, /\bdapi\b/, /\bsapi\b/]) {
    assert.doesNotMatch(netlifyFn, re, `netlify function must not reference ${re}`);
  }
});

test('netlify function requires no Binance API key/secret', () => {
  assert.doesNotMatch(netlifyFn, /BINANCE_API_KEY/);
  assert.doesNotMatch(netlifyFn, /BINANCE_API_SECRET/);
});

test('netlify function does not reference Telegram or ENTRY_READY', () => {
  assert.doesNotMatch(netlifyFn, /ENTRY_READY/);
  assert.doesNotMatch(netlifyFn, /telegram/i);
});

test('docs exist and document fail-closed / static-only does not pass Absorb', () => {
  assert.ok(fs.existsSync(docsPath), 'docs/radar-microstructure.md must exist');
  const docs = fs.readFileSync(docsPath, 'utf8');
  assert.match(docs, /fail.?closed/i);
  assert.match(docs, /Absorb/);
  assert.match(docs, /static-only/i);
});

test('docs explain the move to Netlify scheduled function due to 451', () => {
  const docs = fs.readFileSync(docsPath, 'utf8');
  assert.match(docs, /451/);
  assert.match(docs, /Netlify/i);
});
