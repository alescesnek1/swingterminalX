// Lightweight guardrail for the ChatGPT session handoff + AGENTS workflow doc.
// Asserts the handoff exists and still anchors on the load-bearing facts, without
// pinning brittle exact prose. If a real behavior change makes one of these anchors
// wrong, update CHATGPT_SESSION_HANDOFF.md (that is the point of the test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('CHATGPT_SESSION_HANDOFF.md exists and covers the load-bearing anchors', () => {
  const handoff = read('CHATGPT_SESSION_HANDOFF.md');

  // Points to the repo brain / docs so ChatGPT knows where ground truth lives.
  assert.match(handoff, /AGENTS\.md/);
  assert.match(handoff, /docs\/LIVE-SPOT-RUNBOOK\.md/);
  assert.match(handoff, /docs\/radar-microstructure\.md/);

  // Core safety + product facts that must never silently drift.
  assert.match(handoff, /ENTRY_READY/);
  assert.match(handoff, /MARKET_DATA_PROVIDER=none/);
  assert.match(handoff, /Netlify Blobs/);
  assert.match(handoff, /testnet/i);
  assert.match(handoff, /cron-alerts\.mjs/);

  // Must explicitly disclaim the unrelated realitni_bot surface so ChatGPT
  // never hallucinates Stripe/billing/referral into this project.
  assert.match(handoff, /No Stripe|no Stripe|NOT realitni/i);
  assert.match(handoff, /referral/i);

  // Update policy must be present and enforceable.
  assert.match(handoff, /update not needed because/i);
});

test('AGENTS.md forces the handoff to be maintained', () => {
  const agents = read('AGENTS.md');
  assert.match(agents, /CHATGPT_SESSION_HANDOFF\.md/);
  assert.match(agents, /the task is not\s+complete/i);
  assert.match(agents, /No push,\s+no deploy|no push \/ no deploy/i);
});
