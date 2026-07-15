import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Source guards for .github/workflows/personal-alerts.yml — the external,
// authenticated scheduler that replaces Netlify's native cron for
// netlify/functions/personal-alerts.mjs (Netlify's native scheduled trigger
// cannot attach the x-terminal-scheduler-secret header this function
// requires). These are text-level guards, not a YAML/GitHub-Actions runner —
// they only prove the committed workflow file has the required shape and
// contains no secrets/chat ids/tokens, mirroring this repo's existing
// source-guard test style.

const WORKFLOW_PATH = new URL('../.github/workflows/personal-alerts.yml', import.meta.url);

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

test('personal-alerts scheduler workflow file exists', () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH), 'expected .github/workflows/personal-alerts.yml to exist');
});

test('workflow declares workflow_dispatch and a 5-minute schedule trigger', () => {
  const source = readWorkflow();
  assert.match(source, /workflow_dispatch/);
  assert.match(source, /schedule:/);
  assert.match(source, /cron:\s*["']\*\/5 \* \* \* \*["']/);
});

test('workflow calls the production personal-alerts function URL', () => {
  const source = readWorkflow();
  assert.match(source, /https:\/\/swingterminalx\.netlify\.app\/\.netlify\/functions\/personal-alerts/);
});

test('workflow attaches the scheduler secret header sourced from GitHub Secrets', () => {
  const source = readWorkflow();
  assert.match(source, /x-terminal-scheduler-secret/);
  assert.match(source, /secrets\.PERSONAL_ALERTS_SCHEDULER_SECRET/);
});

test('workflow no-ops safely when the GitHub secret is missing', () => {
  const source = readWorkflow();
  assert.match(source, /-z\s+"\$\{PERSONAL_ALERTS_SCHEDULER_SECRET:-\}"/);
  assert.match(source, /exit 0/);
});

test('workflow never echoes or prints the scheduler secret value', () => {
  const source = readWorkflow();
  const secretLines = source.split('\n').filter((line) => line.includes('PERSONAL_ALERTS_SCHEDULER_SECRET'));
  assert.ok(secretLines.length > 0, 'expected the workflow to reference the secret at least once');
  for (const line of secretLines) {
    assert.doesNotMatch(line, /\becho\b/i, `unexpected echo of a secret-bearing line: ${line}`);
  }
});

test('workflow does not send next_run as auth and contains no real secrets/tokens/chat ids', () => {
  const source = readWorkflow();
  // The word "next_run" may appear only in explanatory prose/comments (this
  // file documents why Netlify's native next_run signal is NOT trusted for
  // auth) — it must never appear inside the actual request payload sent by
  // curl, which is the thing that would matter as an auth bypass attempt.
  assert.doesNotMatch(source, /--data\s+['"][^'"]*next_run/i);
  assert.doesNotMatch(source, /PERSONAL_ALERTS_ENABLED\s*[:=]\s*['"]?true['"]?/);
  assert.doesNotMatch(source, /BOT_TOKEN\s*[:=]\s*['"]?\d/i);
  assert.doesNotMatch(source, /\b\d{6,}\b/);
});

test('workflow uses read-only permissions and never touches Netlify env or auth', () => {
  const source = readWorkflow();
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(source, /netlify env:set|netlify api updateSite|NETLIFY_AUTH_TOKEN|NETLIFY_API_TOKEN/i);
});

test('workflow POSTs (never GETs) so the function-side POST+auth gate is satisfied', () => {
  const source = readWorkflow();
  assert.match(source, /-X POST/);
});
