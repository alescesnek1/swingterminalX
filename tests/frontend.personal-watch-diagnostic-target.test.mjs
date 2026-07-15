import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../apps/edge/public/index.html', import.meta.url), 'utf8');
const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

function diagnosticBlock() {
  const start = terminalJs.indexOf('async function copyPersonalWatchDiagnosticTarget');
  const end = terminalJs.indexOf('// ── Symbol watch-list', start);
  assert.ok(start !== -1 && end !== -1 && start < end);
  return terminalJs.slice(start, end);
}

test('Cockpit Personal Alerts includes the diagnostic target copy affordance', () => {
  assert.match(indexHtml, /Diagnostic target ID/);
  assert.match(indexHtml, /id="cockpit-pw-diagnostic-target"/);
  assert.match(indexHtml, /Copy my diagnostic target ID/);
  assert.match(indexHtml, /id="cockpit-pw-diagnostic-status"/);
});

test('diagnostic copy uses the shared auth path and clipboard without rendering the id', () => {
  const block = diagnosticBlock();
  assert.match(terminalJs, /PERSONAL_WATCH_DIAGNOSTIC_ENDPOINT\s*=\s*['"]\/api\/cockpit-personal-watch-diagnostic-target['"]/);
  assert.match(block, /await _getAuthHeaders\(\)/);
  assert.match(block, /fetch\(PERSONAL_WATCH_DIAGNOSTIC_ENDPOINT/);
  assert.match(block, /\.\.\.authHeaders/);
  assert.match(block, /navigator\.clipboard\.writeText\(body\.diagnosticTargetUserId\)/);
  assert.match(block, /hasChat/);
  assert.match(block, /watchCount/);
  assert.match(block, /exactlyOneWatch/);
  assert.doesNotMatch(block, /textContent\s*=\s*body\.diagnosticTargetUserId/);
  assert.doesNotMatch(block, /telegramChatId|chatId|secret|token/i);
});

test('diagnostic copy action is wired from initCockpit', () => {
  assert.match(terminalJs, /cockpit-pw-diagnostic-target.*copyPersonalWatchDiagnosticTarget/);
});

test('diagnostic UI introduces no send or trading path', () => {
  const block = diagnosticBlock();
  for (const forbidden of [/api\.telegram\.org/i, /\/order\b/i, /\/sapi\b/i, /\/dapi\b/i, /\/fapi\b/i, /BINANCE_API_KEY/i, /ENTRY_READY/i]) {
    assert.doesNotMatch(block, forbidden);
  }
});