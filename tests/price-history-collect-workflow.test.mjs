import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Source guards for .github/workflows/price-history-collect.yml — same
// style as tests/personal-alerts-scheduler-workflow.test.mjs. Text-level
// guards only, not a YAML/GitHub-Actions runner: they prove the committed
// workflow file has the required shape, starts with the schedule trigger
// commented out, and contains no secrets.

const WORKFLOW_PATH = new URL('../.github/workflows/price-history-collect.yml', import.meta.url);

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

test('price-history-collect scheduler workflow file exists', () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH), 'expected .github/workflows/price-history-collect.yml to exist');
});

test('workflow declares workflow_dispatch and an active 30-minute schedule trigger (Stage 7 soak)', () => {
  const source = readWorkflow();
  assert.match(source, /workflow_dispatch/);
  // Stage 7 (commit ed1357c) deliberately enabled the schedule trigger for
  // a 24h soak at a 30-minute cadence. An active (uncommented) `schedule:`
  // key is now the correct, intended production state — not a regression.
  // The cron must be exactly */30 * * * * (not */15 or any other cadence)
  // until a later, separately reviewed stage tightens it.
  assert.match(source, /^\s*schedule:\s*$/m);
  assert.doesNotMatch(source, /^\s*#\s*schedule:/m);
  assert.match(source, /^\s*-\s*cron:\s*["']\*\/30 \* \* \* \*["']/m);
  assert.doesNotMatch(source, /^\s*-\s*cron:\s*["']\*\/15 \* \* \* \*["']/m);
});

test('workflow references both the initial 30-minute soak cadence and the eventual 15-minute target', () => {
  const source = readWorkflow();
  assert.match(source, /\*\/30 \* \* \* \*/);
  assert.match(source, /\*\/15 \* \* \* \*/);
});

test('workflow declares its own concurrency group, distinct from personal-alerts', () => {
  const source = readWorkflow();
  assert.match(source, /concurrency:\s*\n\s*group:\s*price-history-collect/);
  assert.match(source, /cancel-in-progress:\s*false/);
});

test('workflow calls the price-history-collect-scheduled endpoint at the documented path', () => {
  const source = readWorkflow();
  assert.match(source, /https:\/\/swingterminalx\.netlify\.app\/api\/price-history-collect-scheduled/);
});

test('workflow attaches its own scheduler secret header, never the personal-alerts one', () => {
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

test('workflow contains no real secrets, tokens, or long numeric ids', () => {
  const source = readWorkflow();
  assert.doesNotMatch(source, /PRICE_HISTORY_SCHEDULE_ENABLED\s*[:=]\s*['"]?true['"]?/);
  assert.doesNotMatch(source, /PRICE_HISTORY_COLLECT_ENABLED\s*[:=]\s*['"]?true['"]?/);
  assert.doesNotMatch(source, /PRICE_HISTORY_WRITE_ENABLED\s*[:=]\s*['"]?true['"]?/);
  assert.doesNotMatch(source, /BOT_TOKEN\s*[:=]\s*['"]?\d/i);
  assert.doesNotMatch(source, /\b\d{6,}\b/);
});
