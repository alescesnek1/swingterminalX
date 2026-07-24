import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  RADAR_TRADE_INTENT_CANDIDATE_FIXTURES,
  RADAR_TRADE_INTENT_FIXTURE_SCHEMA_VERSION,
  RADAR_TRADE_INTENT_FIXTURE_VERSION,
  RADAR_TRADE_INTENT_REPLAY_CAPTURED_AT,
  RADAR_TRADE_INTENT_REPLAY_CLOCK_MS,
} from './fixtures/radar-trade-intent-candidates.mjs';
import {
  TRADE_INTENT_VALIDATION_SOURCE,
  validateRadarCandidateForTradeIntent,
} from '../scripts/radar/trade-intent-candidate-validation.mjs';

function assertSupportedFixtureVersion(fixture) {
  assert.equal(fixture.fixtureVersion, RADAR_TRADE_INTENT_FIXTURE_VERSION,
    `unsupported fixture version for ${fixture.name}`);
  assert.equal(fixture.schemaVersion, RADAR_TRADE_INTENT_FIXTURE_SCHEMA_VERSION,
    `unsupported fixture schema for ${fixture.name}`);
}

function replayFixture(fixture) {
  assertSupportedFixtureVersion(fixture);
  const capturedAtMs = Date.parse(fixture.capturedAt);
  assert.equal(capturedAtMs, RADAR_TRADE_INTENT_REPLAY_CLOCK_MS,
    `fixture ${fixture.name} must use the deterministic replay clock`);
  return validateRadarCandidateForTradeIntent(fixture.candidate, {
    nowMs: capturedAtMs,
    maxAgeMs: 120000,
    symbolMapping: fixture.symbolMapping,
  });
}

test('every historical RADAR candidate fixture replays to its stable validation contract', () => {
  assert.ok(RADAR_TRADE_INTENT_CANDIDATE_FIXTURES.length >= 9);
  for (const fixture of RADAR_TRADE_INTENT_CANDIDATE_FIXTURES) {
    const result = replayFixture(fixture);
    assert.equal(result.source, TRADE_INTENT_VALIDATION_SOURCE);
    assert.deepEqual({ ok: result.ok, reasonCodes: result.reasonCodes }, fixture.expectedValidation, fixture.name);
  }
});

test('fixture schema and capture time are explicit, deterministic, and sanitized', () => {
  assert.equal(RADAR_TRADE_INTENT_REPLAY_CAPTURED_AT, '2026-07-24T12:00:00.000Z');
  assert.equal(RADAR_TRADE_INTENT_REPLAY_CLOCK_MS, Date.parse(RADAR_TRADE_INTENT_REPLAY_CAPTURED_AT));
  for (const fixture of RADAR_TRADE_INTENT_CANDIDATE_FIXTURES) {
    assertSupportedFixtureVersion(fixture);
    assert.equal(fixture.source, 'trading-radar-v1');
    assert.equal(fixture.capturedAt, RADAR_TRADE_INTENT_REPLAY_CAPTURED_AT);
    assert.ok(fixture.candidate && typeof fixture.candidate === 'object');
    assert.doesNotMatch(JSON.stringify(fixture), /token|secret|password|authorization/i);
  }
});

test('replay requires an explicit deterministic clock and rejects unknown future fixture versions loudly', () => {
  const validFixture = RADAR_TRADE_INTENT_CANDIDATE_FIXTURES[0];
  assert.ok(validateRadarCandidateForTradeIntent(validFixture.candidate, {
    symbolMapping: validFixture.symbolMapping,
  }).reasonCodes.includes('unknown_state'));
  assert.throws(() => replayFixture({ ...validFixture, fixtureVersion: RADAR_TRADE_INTENT_FIXTURE_VERSION + 1 }), /unsupported fixture version/);
  assert.throws(() => replayFixture({ ...validFixture, schemaVersion: 'radar-trade-intent-candidate/v2' }), /unsupported fixture schema/);
});

test('fixture replay remains local-only and imports no exchange, Telegram, order, or worker code', () => {
  const fixtureSource = fs.readFileSync(new URL('./fixtures/radar-trade-intent-candidates.mjs', import.meta.url), 'utf8');
  const replaySource = fs.readFileSync(new URL('./radar-trade-intent-candidate-replay.test.mjs', import.meta.url), 'utf8');
  const replayImports = [...replaySource.matchAll(/^.*from\s+'([^']+)'/gm)].map((match) => match[1]);
  assert.deepEqual(replayImports, [
    'node:test',
    'node:assert/strict',
    'node:fs',
    './fixtures/radar-trade-intent-candidates.mjs',
    '../scripts/radar/trade-intent-candidate-validation.mjs',
  ]);
  assert.doesNotMatch(fixtureSource, /^\s*import\s/m);
  assert.doesNotMatch(fixtureSource, /\bfetch\s*\(/i);
  assert.doesNotMatch(fixtureSource, /kucoin|binance|telegram|worker|placeorder|submitorder/i);
});
