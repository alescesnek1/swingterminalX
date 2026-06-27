// Phase 2 — GECKO auth/origin parity (intentional posture).
//
// The handler can't be executed under node:test (it dynamically imports
// lib/security.js, which pulls a Deno-only esm.sh dependency). These guards
// pin the INTENT: /api/coingecko-highlights is gated like /api/markets, and
// the frontend forwards the bearer token so the gated call still succeeds.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const gecko = fs.readFileSync(new URL('../apps/edge/netlify/edge-functions/coingecko-highlights.js', import.meta.url), 'utf8');
const terminal = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

test('GECKO handler enforces origin allowlist + Supabase JWT', () => {
  assert.match(gecko, /await import\('\.\/lib\/security\.js'\)/);
  assert.match(gecko, /checkOrigin, verifyAuth, pickAllowOrigin/);
  assert.match(gecko, /checkOrigin\(request\)/);
  assert.match(gecko, /await verifyAuth\(request\)/);
  // Unauthorized / forbidden responses are returned (not silently allowed).
  assert.match(gecko, /'Forbidden origin'/);
  assert.match(gecko, /status:\s*403/);
  assert.match(gecko, /'Unauthorized'/);
  assert.match(gecko, /status:\s*auth\.status\s*\|\|\s*401/);
});

test('GECKO cannot be bypassed via a shared cache (Vary: Authorization + no-store gate)', () => {
  // Root cause of the earlier fail-open: `public` cache without Vary:Authorization
  // let the CDN serve an authenticated 200 to an anonymous caller.
  assert.match(gecko, /'Vary':\s*'Origin, Authorization'/);
  // Gate (4xx) responses are never cached.
  assert.match(gecko, /function gateHeaders[\s\S]*'Cache-Control':\s*'no-store'/);
  assert.match(gecko, /status:\s*403,\s*headers:\s*gateHeaders/);
  assert.match(gecko, /status:\s*auth\.status \|\| 401,\s*headers:\s*gateHeaders/);
});

test('GECKO no longer reflects an arbitrary Origin', () => {
  // Old behaviour: `req.headers.get('origin') || '*'`. Must be gone — CORS
  // now flows from pickAllowOrigin (the same allowlist as markets.js).
  assert.doesNotMatch(gecko, /req\.headers\.get\('origin'\)\s*\|\|\s*'\*'/);
  assert.match(gecko, /pickAllowOrigin\(request\)/);
});

test('GECKO still handles OPTIONS preflight', () => {
  assert.match(gecko, /request\.method === 'OPTIONS'/);
  assert.match(gecko, /status:\s*204/);
});

test('GECKO failure stays soft (degraded payload, HTTP 200, no crash)', () => {
  // Upstream non-200 and fetch failure both return a parsed degraded payload.
  assert.match(gecko, /degraded\.diagnostics\.warnings\.push\(`HTTP \$\{res\.status\}`\)/);
  assert.match(gecko, /degraded\.diagnostics\.warnings\.push\(`Fetch failed: \$\{err\.message\}`\)/);
});

test('frontend forwards the bearer token to the gated GECKO endpoint', () => {
  assert.match(terminal, /const authHeaders = await _getAuthHeaders\(\);\s*\n\s*const res = await fetch\(url, \{ headers: \{ 'Accept': 'application\/json', \.\.\.authHeaders \} \}\)/);
});
