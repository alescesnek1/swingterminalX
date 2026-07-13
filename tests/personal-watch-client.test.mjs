// Unit tests for the pure Cockpit Personal Alerts client module
// (apps/edge/public/js/personal-watch.js). Pure, no DOM/fetch at import, so
// we import the actual shipped helpers directly — this proves the client
// validation mirrors the backend, and that no helper ever surfaces a raw
// Telegram chat id, only the server's masked value.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validatePersonalWatchChatId,
  personalWatchRenderModel,
  personalWatchSignedOutModel,
  personalWatchErrorModel,
} from '../apps/edge/public/js/personal-watch.js';

test('validatePersonalWatchChatId accepts a plausible digits-only id (mirrors backend 5-20)', () => {
  const valid = validatePersonalWatchChatId('552398471');
  assert.equal(valid.ok, true);
  assert.equal(valid.chatId, '552398471');
});

test('validatePersonalWatchChatId trims surrounding whitespace', () => {
  const valid = validatePersonalWatchChatId('  552398471  ');
  assert.equal(valid.ok, true);
  assert.equal(valid.chatId, '552398471');
});

test('validatePersonalWatchChatId rejects the same invalid shapes the backend rejects', () => {
  const invalid = {
    empty: '',
    onlyWhitespace: '   ',
    letters: 'abcde',
    symbols: '12!45',
    spaces: '12 34 56',
    tooShort: '123', // < 5 digits
    tooLong: '123456789012345678901', // 21 digits > 20
    negativeGroupId: '-100123456', // group/channel-style id — not supported
  };
  for (const [label, value] of Object.entries(invalid)) {
    const res = validatePersonalWatchChatId(value);
    assert.equal(res.ok, false, `${label} should be invalid`);
    assert.ok(res.error, `${label} should carry an error message`);
  }
});

test('validatePersonalWatchChatId accepts the boundary lengths 5 and 20', () => {
  assert.equal(validatePersonalWatchChatId('12345').ok, true); // 5 digits
  assert.equal(validatePersonalWatchChatId('12345678901234567890').ok, true); // 20 digits
  assert.equal(validatePersonalWatchChatId('1234').ok, false); // 4 digits
  assert.equal(validatePersonalWatchChatId('123456789012345678901').ok, false); // 21 digits
});

test('personalWatchRenderModel surfaces only the masked id when connected', () => {
  const model = personalWatchRenderModel({
    ok: true,
    telegramConnected: true,
    telegramChatIdMasked: '5523••••71',
    telegramChatIdUpdatedAt: '2026-07-13T10:00:00.000Z',
  });
  assert.equal(model.connected, true);
  assert.equal(model.maskedChatId, '5523••••71');
  assert.equal(model.updatedAt, '2026-07-13T10:00:00.000Z');
  assert.match(model.statusText, /Connected/);
  assert.match(model.statusText, /5523••••71/);
});

test('personalWatchRenderModel reflects "not connected" cleanly', () => {
  const model = personalWatchRenderModel({ ok: true, telegramConnected: false, telegramChatIdMasked: null, telegramChatIdUpdatedAt: null });
  assert.equal(model.connected, false);
  assert.equal(model.maskedChatId, null);
  assert.equal(model.statusText, 'Not connected');
});

test('personalWatchRenderModel handles a missing/malformed response without throwing', () => {
  for (const bad of [null, undefined, {}, 'not-an-object', 42]) {
    const model = personalWatchRenderModel(bad);
    assert.equal(model.connected, false);
    assert.equal(model.maskedChatId, null);
  }
});

test('personalWatchRenderModel NEVER surfaces a raw chat id, even if one is present in the payload', () => {
  // Simulates a hypothetical backend regression that leaked a raw field —
  // the frontend model must still only carry the masked value.
  const leaked = {
    ok: true,
    telegramConnected: true,
    telegramChatId: '552398471', // raw — must be ignored
    telegramChatIdMasked: '5523••••71',
    telegramChatIdUpdatedAt: '2026-07-13T10:00:00.000Z',
  };
  const model = personalWatchRenderModel(leaked);
  const serialized = JSON.stringify(model);
  assert.ok(!serialized.includes('552398471'), 'raw chat id must never appear in the render model');
  assert.equal('telegramChatId' in model, false);
  assert.equal(model.maskedChatId, '5523••••71');
});

test('personalWatchSignedOutModel is a safe, non-connected state', () => {
  const model = personalWatchSignedOutModel();
  assert.equal(model.connected, false);
  assert.equal(model.maskedChatId, null);
  assert.equal(model.signedOut, true);
  assert.ok(model.statusText.length > 0);
});

test('personalWatchErrorModel is a safe, non-connected state and never contains input text as a "success"', () => {
  const model = personalWatchErrorModel('network down');
  assert.equal(model.connected, false);
  assert.equal(model.maskedChatId, null);
  assert.equal(model.error, true);
  assert.equal(model.statusText, 'network down');
});
