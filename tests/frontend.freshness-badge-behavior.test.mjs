// Phase 4 — REAL behavior test for the markets freshness/source badge.
//
// freshness-badge.js is pure (no DOM at import), so we import the actual
// shipped decision the top bar uses (window.freshnessBadge) and assert the
// state→badge mapping directly, instead of grepping terminal.js source.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshnessBadge } from '../apps/edge/public/js/freshness-badge.js';

test('live + fresh → green LIVE badge', () => {
  const b = freshnessBadge({ ok: true, servedFrom: 'live', stale: false }, 'LIVE');
  assert.equal(b.cls, 's-live');
  assert.equal(b.label, 'LIVE');
  assert.match(b.title, /source: live/);
});

test('stale-memory → amber STALE badge (never green)', () => {
  const b = freshnessBadge({ ok: true, servedFrom: 'stale-memory', stale: true }, 'STALE');
  assert.equal(b.cls, 's-stale');
  assert.equal(b.label, 'STALE');
  assert.notEqual(b.cls, 's-live');
});

test('fetch failure → red OFFLINE badge', () => {
  const b = freshnessBadge({ ok: false, servedFrom: 'error', stale: true }, 'ERROR');
  assert.equal(b.cls, 's-error');
  assert.equal(b.label, 'OFFLINE');
});

test('stale state wins even if SRC was not updated', () => {
  // Defense-in-depth: a stale freshness flag degrades the badge regardless
  // of the SRC string the caller passed.
  const b = freshnessBadge({ stale: true, servedFrom: 'stale-memory' }, 'LIVE');
  assert.equal(b.cls, 's-stale');
});

test('error wins over stale', () => {
  const b = freshnessBadge({ ok: false, stale: true, servedFrom: 'error' }, 'STALE');
  assert.equal(b.cls, 's-error');
  assert.equal(b.label, 'OFFLINE');
});

test('initial LOADING state stays muted, not green', () => {
  const b = freshnessBadge({}, 'LOADING');
  assert.equal(b.cls, 's-mock');
  assert.equal(b.label, 'LOADING');
  assert.notEqual(b.cls, 's-live');
});

test('the three degraded/live classes are mutually distinct', () => {
  const live = freshnessBadge({ ok: true, servedFrom: 'live' }, 'LIVE').cls;
  const stale = freshnessBadge({ stale: true, servedFrom: 'stale-memory' }, 'STALE').cls;
  const error = freshnessBadge({ ok: false, servedFrom: 'error' }, 'ERROR').cls;
  assert.equal(new Set([live, stale, error]).size, 3);
});
