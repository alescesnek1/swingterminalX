// Phase 2 fix — GECKO auth is ENFORCED (behavioural, not source-grep).
//
// The default handler can't run under node (Deno-only esm.sh import in
// lib/security.js), so we exercise the injectable core `runGecko` with mock
// security + a fetch spy. This proves the gate fails closed AND never reaches
// the CoinGecko scrape when auth/origin fail.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runGecko, __resetGeckoCacheForTests } from '../apps/edge/netlify/edge-functions/coingecko-highlights.js';

const ALLOW = 'https://swingterminalx.netlify.app';
const req = (method = 'GET', headers = {}) =>
  new Request('https://swingterminalx.netlify.app/api/coingecko-highlights', { method, headers });

// A fetch spy that records calls and returns a minimal valid highlights page.
function makeFetchSpy() {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const html = `<html><body>
      <h2>Top Gainers</h2><table>
        <tr><td><a href="/en/coins/alpha">Alpha ALP</a></td><td>$1.50</td><td><span class="gecko-up">+12.0%</span></td></tr>
      </table></body></html>`;
    return new Response(html, { status: 200 });
  };
  return { impl, calls };
}

const okOrigin = () => ({ ok: true, origin: ALLOW });
const badOrigin = () => ({ ok: false, reason: 'Origin not on allowlist' });
const okAuth = async () => ({ ok: true, status: 200, user: { id: 'u1', email: 'x@y.z' } });
const noAuth = async () => ({ ok: false, status: 401, reason: 'Missing Bearer token' });
const badAuth = async () => ({ ok: false, status: 403, reason: 'Role anon not allowed' });
const pick = () => ALLOW;

test.beforeEach(() => __resetGeckoCacheForTests());

test('missing Authorization → 401 and CoinGecko is NEVER fetched', async () => {
  const spy = makeFetchSpy();
  const res = await runGecko(req('GET'), { checkOrigin: okOrigin, verifyAuth: noAuth, pickAllowOrigin: pick, fetchImpl: spy.impl });
  assert.equal(res.status, 401);
  assert.equal(spy.calls.length, 0, 'auth failure must not fall through to the scrape');
  const body = await res.json();
  assert.equal(body.error, 'Unauthorized');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('invalid Authorization → 403 and no fetch', async () => {
  const spy = makeFetchSpy();
  const res = await runGecko(req('GET', { authorization: 'Bearer bogus' }), { checkOrigin: okOrigin, verifyAuth: badAuth, pickAllowOrigin: pick, fetchImpl: spy.impl });
  assert.equal(res.status, 403);
  assert.equal(spy.calls.length, 0);
});

test('forbidden origin → 403 before auth is even checked, no fetch', async () => {
  const spy = makeFetchSpy();
  let authChecked = false;
  const verifyAuth = async () => { authChecked = true; return { ok: true }; };
  const res = await runGecko(req('GET'), { checkOrigin: badOrigin, verifyAuth, pickAllowOrigin: pick, fetchImpl: spy.impl });
  assert.equal(res.status, 403);
  assert.equal(authChecked, false, 'origin is gated before auth');
  assert.equal(spy.calls.length, 0);
});

test('allowed origin + valid auth → 200 with sections (fetch happens once)', async () => {
  const spy = makeFetchSpy();
  const res = await runGecko(req('GET', { authorization: 'Bearer good' }), { checkOrigin: okOrigin, verifyAuth: okAuth, pickAllowOrigin: pick, fetchImpl: spy.impl });
  assert.equal(res.status, 200);
  assert.equal(spy.calls.length, 1);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.sections) && body.sections.length > 0);
});

test('200 response Varies on Authorization so a CDN cannot serve it to anon', async () => {
  const spy = makeFetchSpy();
  const res = await runGecko(req('GET', { authorization: 'Bearer good' }), { checkOrigin: okOrigin, verifyAuth: okAuth, pickAllowOrigin: pick, fetchImpl: spy.impl });
  const vary = res.headers.get('Vary') || '';
  assert.match(vary, /Authorization/i);
});

test('OPTIONS preflight still returns 204 without auth', async () => {
  const spy = makeFetchSpy();
  const res = await runGecko(req('OPTIONS'), { checkOrigin: okOrigin, verifyAuth: noAuth, pickAllowOrigin: pick, fetchImpl: spy.impl });
  assert.equal(res.status, 204);
  assert.equal(spy.calls.length, 0);
});
