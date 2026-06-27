// Batch B — /api/markets freshness metadata.
//
// The markets handler itself is a Deno edge function (network + Deno
// globals), so we test the PURE freshness contract it relies on:
// lib/freshness.js. The handler's only job is to call these helpers
// with servedFrom=live on the hot path and servedFrom=stale-memory on
// the last-good fallback path — which we assert separately by grepping
// the handler so the wiring can't silently regress.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildFreshnessMeta,
  freshnessHeaders,
  SERVED_LIVE,
  SERVED_STALE,
} from '../apps/edge/netlify/edge-functions/lib/freshness.js';

const marketsSrc = fs.readFileSync(
  new URL('../apps/edge/netlify/edge-functions/markets.js', import.meta.url),
  'utf8',
);

test('live response carries fresh, non-stale freshness metadata', () => {
  const now = 1_000_000;
  const meta = buildFreshnessMeta({ servedFrom: SERVED_LIVE, generatedAt: now - 5_000, now });
  assert.equal(meta.servedFrom, 'live');
  assert.equal(meta.stale, false);
  assert.equal(meta.ageMs, 5_000);
  assert.ok(meta.generatedAt, 'live response exposes a generatedAt timestamp');

  const headers = freshnessHeaders(meta);
  assert.equal(headers['X-Served-From'], 'live');
  assert.equal(headers['X-Stale'], 'false');
  assert.equal(headers['X-Age-Ms'], '5000');
  assert.ok(headers['X-Generated-At']);
});

test('stale-memory fallback is flagged stale and degraded', () => {
  const now = 2_000_000;
  const meta = buildFreshnessMeta({ servedFrom: SERVED_STALE, generatedAt: now - 600_000, now });
  assert.equal(meta.servedFrom, 'stale-memory');
  assert.equal(meta.stale, true);
  assert.equal(meta.ageMs, 600_000);

  const headers = freshnessHeaders(meta);
  assert.equal(headers['X-Served-From'], 'stale-memory');
  assert.equal(headers['X-Stale'], 'true');
});

test('stale fallback must NOT look identical to a live response', () => {
  const now = 3_000_000;
  const live = freshnessHeaders(buildFreshnessMeta({ servedFrom: SERVED_LIVE, generatedAt: now, now }));
  const stale = freshnessHeaders(buildFreshnessMeta({ servedFrom: SERVED_STALE, generatedAt: now - 900_000, now }));
  assert.notEqual(live['X-Served-From'], stale['X-Served-From']);
  assert.notEqual(live['X-Stale'], stale['X-Stale']);
});

test('unknown / non-live servedFrom fails safe to stale', () => {
  const meta = buildFreshnessMeta({ servedFrom: 'fallback', generatedAt: null });
  assert.equal(meta.stale, true);
  // No timestamp known → age is null, not a misleading 0.
  assert.equal(meta.ageMs, null);
  assert.equal(meta.generatedAt, null);
});

test('markets handler wires live + stale-memory freshness onto both paths', () => {
  // Hot path stamps the live snapshot with its true build time.
  assert.match(marketsSrc, /buildFreshnessMeta\(\{\s*servedFrom:\s*SERVED_LIVE,\s*generatedAt:\s*bundle\.at/);
  // Fallback path keeps the stale-memory contract.
  assert.match(marketsSrc, /buildFreshnessMeta\(\{\s*servedFrom:\s*SERVED_STALE,\s*generatedAt:\s*_responseCache\.at/);
  // Both responses emit the freshness headers.
  assert.ok((marketsSrc.match(/\.\.\.freshnessHeaders\(/g) || []).length >= 2);
});
