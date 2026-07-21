import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Source guards for .github/workflows/price-history-prune.yml — same style
// as tests/price-history-collect-workflow.test.mjs.

const WORKFLOW_PATH = new URL('../.github/workflows/price-history-prune.yml', import.meta.url);

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

test('price-history-prune scheduler workflow file exists', () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH), 'expected .github/workflows/price-history-prune.yml to exist');
});

test('workflow declares workflow_dispatch and does NOT have an active schedule trigger yet', () => {
  const source = readWorkflow();
  assert.match(source, /workflow_dispatch/);
  assert.doesNotMatch(source, /^\s*schedule:\s*$/m);
  assert.match(source, /#\s*schedule:/);
  assert.match(source, /#\s*-\s*cron:/);
});

test('workflow declares its own concurrency group, distinct from collect and personal-alerts', () => {
  const source = readWorkflow();
  assert.match(source, /concurrency:\s*\n\s*group:\s*price-history-prune/);
  assert.match(source, /cancel-in-progress:\s*false/);
});

test('workflow calls the price-history-prune-scheduled endpoint at the documented path', () => {
  const source = readWorkflow();
  assert.match(source, /https:\/\/swingterminalx\.netlify\.app\/api\/price-history-prune-scheduled/);
});

test('workflow attaches the same price-history scheduler secret header as collect, never personal-alerts', () => {
  const source = readWorkflow();
  assert.match(source, /x-price-history-scheduler-secret/);
  assert.match(source, /secrets\.PRICE_HISTORY_SCHEDULER_SECRET/);
  assert.doesNotMatch(source, /PERSONAL_ALERTS_SCHEDULER_SECRET/);
  assert.doesNotMatch(source, /x-terminal-scheduler-secret/);
});

test('workflow no-ops safely when the GitHub secret is missing', () => {
  const source = readWorkflow();
  assert.match(source, /-z\s+"\$\{PRICE_HISTORY_SCHEDULER_SECRET:-\}"/);
  assert.match(source, /exit 0/);
});

test('workflow never echoes or prints the scheduler secret value', () => {
  const source = readWorkflow();
  const secretLines = source.split('\n').filter((line) => line.includes('PRICE_HISTORY_SCHEDULER_SECRET'));
  assert.ok(secretLines.length > 0, 'expected the workflow to reference the secret at least once');
  for (const line of secretLines) {
    assert.doesNotMatch(line, /\becho\b/i, `unexpected echo of a secret-bearing line: ${line}`);
  }
});

test('workflow uses read-only permissions and never touches Netlify env or auth', () => {
  const source = readWorkflow();
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(source, /netlify env:set|netlify api updateSite|NETLIFY_AUTH_TOKEN|NETLIFY_API_TOKEN/i);
});

test('workflow POSTs (never GETs) and fails the job on a non-2xx response', () => {
  const source = readWorkflow();
  assert.match(source, /-X POST/);
  assert.match(source, /non-2xx response/);
  assert.match(source, /exit 1/);
});

test('workflow has a bounded timeout', () => {
  const source = readWorkflow();
  assert.match(source, /timeout-minutes:\s*3/);
});

test('workflow contains no real secrets, enabled flags, tokens, or long numeric ids', () => {
  const source = readWorkflow();
  assert.doesNotMatch(source, /PRICE_HISTORY_PRUNE_ENABLED\s*[:=]\s*['"]?true['"]?/);
  assert.doesNotMatch(source, /PRICE_HISTORY_RETENTION_DAYS\s*[:=]\s*['"]?\d/);
  assert.doesNotMatch(source, /BOT_TOKEN\s*[:=]\s*['"]?\d/i);
  assert.doesNotMatch(source, /\b\d{6,}\b/);
});
