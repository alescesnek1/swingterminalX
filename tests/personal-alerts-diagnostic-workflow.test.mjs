import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Source guards for .github/workflows/personal-alerts-diagnostic.yml — the
// manual-only diagnostic Telegram delivery test. Text-level guards, not a
// YAML/GitHub-Actions runner, mirroring this repo's existing source-guard
// test style (see tests/personal-alerts-scheduler-workflow.test.mjs).

const WORKFLOW_PATH = new URL('../.github/workflows/personal-alerts-diagnostic.yml', import.meta.url);

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

test('personal-alerts-diagnostic workflow file exists', () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH), 'expected .github/workflows/personal-alerts-diagnostic.yml to exist');
});

test('workflow uses only workflow_dispatch, never a schedule', () => {
  const source = readWorkflow();
  assert.match(source, /workflow_dispatch/);
  assert.doesNotMatch(source, /schedule:/);
  assert.doesNotMatch(source, /cron:/);
});

test('workflow calls the production diagnostic function URL', () => {
  const source = readWorkflow();
  assert.match(source, /https:\/\/swingterminalx\.netlify\.app\/\.netlify\/functions\/personal-alerts-diagnostic/);
});

test('workflow uses POST', () => {
  const source = readWorkflow();
  assert.match(source, /-X POST/);
});

test('workflow attaches the diagnostic secret header sourced from GitHub Secrets', () => {
  const source = readWorkflow();
  assert.match(source, /x-terminal-diagnostic-secret/);
  assert.match(source, /secrets\.PERSONAL_ALERTS_DIAGNOSTIC_SECRET/);
});

test('workflow no-ops safely before any curl call when the GitHub secret is missing', () => {
  const source = readWorkflow();
  assert.match(source, /-z\s+"\$\{PERSONAL_ALERTS_DIAGNOSTIC_SECRET:-\}"/);
  assert.match(source, /exit 0/);
  const noOpIndex = source.indexOf('exit 0');
  const curlIndex = source.indexOf('curl -sS');
  assert.ok(noOpIndex > -1 && curlIndex > -1 && noOpIndex < curlIndex, 'no-op must appear before the curl call');
});

test('workflow never echoes or prints the diagnostic secret value', () => {
  const source = readWorkflow();
  const secretLines = source.split('\n').filter((line) => line.includes('PERSONAL_ALERTS_DIAGNOSTIC_SECRET'));
  assert.ok(secretLines.length > 0, 'expected the workflow to reference the secret at least once');
  for (const line of secretLines) {
    assert.doesNotMatch(line, /\becho\b/i, `unexpected echo of a secret-bearing line: ${line}`);
  }
});

test('workflow contains no real secrets, tokens, chat ids, or user ids', () => {
  const source = readWorkflow();
  assert.doesNotMatch(source, /\b\d{6,}\b/);
});

test('workflow does not set PERSONAL_ALERTS_ENABLED=true', () => {
  const source = readWorkflow();
  assert.doesNotMatch(source, /PERSONAL_ALERTS_ENABLED\s*[:=]\s*['"]?true['"]?/);
});

test('workflow does not set PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED=true', () => {
  const source = readWorkflow();
  assert.doesNotMatch(source, /PERSONAL_ALERTS_DIAGNOSTIC_SEND_ENABLED\s*[:=]\s*['"]?true['"]?/);
});

test('workflow does not send next_run as auth', () => {
  const source = readWorkflow();
  assert.doesNotMatch(source, /--data\s+['"][^'"]*next_run/i);
});

test('workflow uses read-only permissions', () => {
  const source = readWorkflow();
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
});

test('workflow never touches the normal personal-alerts endpoint or its scheduler secret', () => {
  const source = readWorkflow();
  assert.doesNotMatch(source, /functions\/personal-alerts(?!-diagnostic)\b/);
  assert.doesNotMatch(source, /x-terminal-scheduler-secret/);
  assert.doesNotMatch(source, /PERSONAL_ALERTS_SCHEDULER_SECRET/);
});
