import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const workflowPath = path.join(repoRoot, '.github/workflows/radar-microstructure.yml');
const docsPath = path.join(repoRoot, 'docs/radar-microstructure.md');

test('scheduler workflow exists', () => {
  assert.ok(fs.existsSync(workflowPath), 'radar-microstructure.yml workflow must exist');
});

const workflow = fs.readFileSync(workflowPath, 'utf8');

test('workflow runs the read-only static microstructure producer', () => {
  assert.match(workflow, /scripts\/radar\/radar-microstructure-producer\.mjs/);
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

test('workflow uses BOT_WORKER_TOKEN secret and the public control base URL', () => {
  assert.match(workflow, /BOT_WORKER_TOKEN/);
  assert.match(workflow, /secrets\.BOT_WORKER_TOKEN/);
  assert.match(workflow, /CONTROL_BASE_URL/);
});

test('docs exist and document fail-closed / static-only does not pass Absorb', () => {
  assert.ok(fs.existsSync(docsPath), 'docs/radar-microstructure.md must exist');
  const docs = fs.readFileSync(docsPath, 'utf8');
  assert.match(docs, /fail.?closed/i);
  assert.match(docs, /Absorb/);
  assert.match(docs, /static-only/i);
});
