// Endpoint guards for /api/arkham-token-intel (netlify/functions/arkham-token-intel.mjs).
//
// The route is disabled by default and must stay safe in every direction: no
// unauthenticated answer, no secret in a response, no 500 for a missing key, no
// external call while off, and no batch. Every case here injects a fake env and a
// fetch that throws if called — no test contacts Arkham.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runArkhamTokenIntel } from '../netlify/functions/arkham-token-intel.mjs';

const KEY = 'ark_test_key_do_not_use_1234567890';

function req(url = 'https://terminal.test/api/arkham-token-intel?symbol=SOL', method = 'GET') {
  return new Request(url, { method, headers: { origin: 'https://terminal.test' } });
}
const verified = async () => ({ ok: true, verified: true, userId: 'u1', email: 'owner@test', orgId: 'default' });
const anonymous = async () => ({ ok: false, reason: 'No bearer token', verified: false });

// Any fetch reaching this is a bug: while disabled there must be no network call.
function forbiddenFetch() {
  return async () => { throw new Error('no external fetch is permitted here'); };
}

async function call(url, { env = {}, getIdentity = verified, method = 'GET', fetchImpl = forbiddenFetch() } = {}) {
  const res = await runArkhamTokenIntel(req(url, method), { env, getIdentity, fetchImpl });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { res, body };
}

test('the default (no env at all) answers HTTP 200 DISABLED and makes no external call', async () => {
  const { res, body } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL');
  assert.equal(res.status, 200);
  assert.equal(body.status, 'DISABLED');
  assert.equal(body.source, 'arkham');
  assert.equal(body.advisoryOnly, true);
  assert.match(body.message, /Arkham Intel is disabled\. Set ARKHAM_ENABLED=true and ARKHAM_API_KEY to enable\./);
  assert.equal(body.fetched, false);
  assert.equal(body.intel, null, 'no intel object may be implied while disabled');
});

test('the disabled response declares itself advisory and denies every gate', async () => {
  const { body } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL');
  assert.equal(body.advisoryOnly, true);
  assert.equal(body.affectsTrading, false);
  for (const key of ['radar', 'entryReady', 'strictAbsorb', 'reclaim', 'telegram', 'alerts', 'orders', 'scannerRanking', 'leadScore', 'defaultSorting', 'valuation', 'gateChecklist']) {
    assert.equal(body.affects[key], false, `${key} must be declared unaffected`);
  }
  assert.match(body.disclaimer, /does not affect ENTRY_READY/i);
});

test('missing data is reported as UNKNOWN-by-omission, never as a signal', async () => {
  const { body } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL');
  assert.equal(body.intel, null);
  for (const field of ['entity', 'holderConcentration', 'exchangeNetflow', 'whaleTransfers', 'counterparties', 'riskFlags', 'tokenFlowSummary']) {
    assert.ok(body.missing.includes(field), `${field} must be listed as missing`);
  }
  // No DATA field may read as a trading label. (The advisory disclaimer names
  // ENTRY_READY on purpose — to deny it — so it is excluded from this scan.)
  const dataOnly = JSON.stringify({ status: body.status, symbol: body.symbol, identity: body.identity, intel: body.intel, missing: body.missing, message: body.message });
  assert.equal(/\b(BUY|SELL|BEARISH|BULLISH|ENTRY_READY|STRICT_ABSORB)\b/.test(dataOnly), false);
});

test('an unauthenticated caller learns nothing — not even the feature state', async () => {
  const { res, body } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL', { getIdentity: anonymous });
  assert.equal(res.status, 401);
  assert.equal(body.reason, 'UNAUTHENTICATED');
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'status'), false);
});

test('a decode-only (unverified) identity is refused, matching the other protected reads', async () => {
  const { res, body } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL', {
    getIdentity: async () => ({ ok: true, verified: false, userId: 'u1' }),
  });
  assert.equal(res.status, 401);
  assert.equal(body.reason, 'UNAUTHENTICATED');
});

test('a thrown identity check fails closed rather than 500-ing', async () => {
  const { res } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL', {
    getIdentity: async () => { throw new Error('jwks down'); },
  });
  assert.equal(res.status, 401);
});

test('only GET/OPTIONS are accepted', async () => {
  const { res } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL', { method: 'POST' });
  assert.equal(res.status, 405);
  const options = await runArkhamTokenIntel(req(undefined, 'OPTIONS'), { env: {}, getIdentity: verified });
  assert.equal(options.status, 204);
});

test('an enabled-but-keyless server returns a safe config status, never a 500 and never a secret', async () => {
  const { res, body } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL', { env: { ARKHAM_ENABLED: 'true' } });
  assert.equal(res.status, 200, 'a config gap is not a server error');
  assert.equal(body.status, 'NOT_CONFIGURED');
  assert.equal(body.fetched, false);
  // The message must name the variable to set, and carry no value.
  assert.match(body.message, /ARKHAM_API_KEY/);
  assert.equal(JSON.stringify(body).includes(KEY), false);
});

test('the API key never appears in any response, including the enabled path', async () => {
  const envs = [
    {},
    { ARKHAM_ENABLED: 'true' },
    { ARKHAM_ENABLED: 'true', ARKHAM_API_KEY: KEY },
    { ARKHAM_ENABLED: 'true', ARKHAM_API_KEY: KEY, ARKHAM_DAILY_CREDIT_CAP: '10' },
  ];
  for (const env of envs) {
    const { body } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL&coingeckoId=solana', {
      env,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ entityName: 'Solana Foundation' }) }),
    });
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(KEY), false, `key leaked for env ${JSON.stringify(Object.keys(env))}`);
    assert.equal(/apiKey|api_key|ARKHAM_API_KEY"\s*:/.test(serialized), false);
  }
});

test('a zero credit cap (the default) blocks the lookup with no external call', async () => {
  const { res, body } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL&coingeckoId=solana', {
    env: { ARKHAM_ENABLED: 'true', ARKHAM_API_KEY: KEY, ARKHAM_DAILY_CREDIT_CAP: '0' },
  });
  assert.equal(res.status, 200);
  assert.equal(body.status, 'COST_CAPPED');
  assert.equal(body.fetched, false);
});

test('an invalid or missing symbol is rejected safely as a 400', async () => {
  for (const query of ['', '?symbol=', '?symbol=x', '?symbol=' + encodeURIComponent('../../etc/passwd'), '?symbol=' + encodeURIComponent('SOL/USDT'), '?symbol=' + 'A'.repeat(40)]) {
    const { res, body } = await call(`https://terminal.test/api/arkham-token-intel${query}`);
    assert.equal(res.status, 400, `${query} must be a 400`);
    assert.equal(body.reason, 'INVALID_SYMBOL');
    assert.equal(body.ok, false);
  }
});

test('a batch of symbols is refused — one coin per request, by design', async () => {
  for (const raw of ['SOL,ETH', 'SOL ETH', 'SOL;ETH']) {
    const { res, body } = await call(`https://terminal.test/api/arkham-token-intel?symbol=${encodeURIComponent(raw)}`);
    assert.equal(res.status, 400);
    assert.equal(body.reason, 'ARKHAM_TOO_MANY_SYMBOLS');
    assert.equal(body.maxSymbolsPerRequest, 1);
  }
});

test('a present-but-invalid strong identifier is a 400, never a silent downgrade to symbol-only', async () => {
  const cases = [
    ['coingeckoId=' + encodeURIComponent('../solana'), 'INVALID_COINGECKO_ID'],
    ['chain=made-up-chain', 'INVALID_CHAIN'],
    ['contract=0xnothex', 'INVALID_CONTRACT_ADDRESS'],
  ];
  for (const [query, reason] of cases) {
    const { res, body } = await call(`https://terminal.test/api/arkham-token-intel?symbol=SOL&${query}`);
    assert.equal(res.status, 400, `${query} must be a 400`);
    assert.equal(body.reason, reason);
  }
});

test('the cache key is derived only from normalized identity', async () => {
  const { body } = await call('https://terminal.test/api/arkham-token-intel?symbol=sol&coingeckoId=Solana');
  assert.equal(body.cache.key, 'arkham:v1:cg:solana');
  assert.equal(body.cache.ttlHours, 24);
  assert.equal(body.identity.source, 'coingecko_id');
  assert.equal(body.identity.strong, true);

  const weak = await call('https://terminal.test/api/arkham-token-intel?symbol=sol');
  assert.equal(weak.body.cache.key, 'arkham:v1:sym:SOL');
  assert.equal(weak.body.identity.strong, false, 'a ticker-only identity must be flagged ambiguous');
});

test('a ticker with no CoinGecko id is IDENTITY_UNRESOLVED, not a guessed lookup', async () => {
  const { res, body } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL', {
    env: { ARKHAM_ENABLED: 'true', ARKHAM_API_KEY: KEY, ARKHAM_DAILY_CREDIT_CAP: '10' },
    fetchImpl: forbiddenFetch(),   // proves nothing was requested
  });
  assert.equal(res.status, 200);
  assert.equal(body.status, 'IDENTITY_UNRESOLVED');
  assert.equal(body.fetched, false);
  assert.match(body.message, /CoinGecko pricing ID/);
});

test('the enabled path calls the approved Arkham host exactly once and shapes the result', async () => {
  const calls = [];
  const { res, body } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL&coingeckoId=solana', {
    env: { ARKHAM_ENABLED: 'true', ARKHAM_API_KEY: KEY, ARKHAM_DAILY_CREDIT_CAP: '10' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ entityName: 'Solana Foundation', entityType: 'fund', inflowUsd: 2_000_000, outflowUsd: 500_000, windowHours: 24 }) };
    },
  });
  assert.equal(res.status, 200);
  assert.equal(body.status, 'OK');
  assert.equal(calls.length, 1, 'exactly one upstream call — no retry, no fan-out');
  assert.equal(new URL(calls[0].url).host, 'api.arkm.com');
  assert.equal(new URL(calls[0].url).protocol, 'https:');
  assert.equal(new URL(calls[0].url).pathname, '/intelligence/token/solana');
  assert.equal(calls[0].url.includes(KEY), false, 'the key is a header, never a query parameter');
  assert.equal(body.intel.entity.name, 'Solana Foundation');
  assert.equal(body.intel.exchangeNetflow.netUsd, 1_500_000);
  assert.equal(body.creditsCharged, 1);
  assert.equal(body.advisoryOnly, true);
});

test('an upstream failure is reported AS a failure, not as an empty panel', async () => {
  const { res, body } = await call('https://terminal.test/api/arkham-token-intel?symbol=SOL&coingeckoId=solana', {
    env: { ARKHAM_ENABLED: 'true', ARKHAM_API_KEY: KEY, ARKHAM_DAILY_CREDIT_CAP: '10' },
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ detail: 'raw upstream body' }) }),
  });
  assert.equal(res.status, 200);
  assert.equal(body.status, 'UPSTREAM_ERROR');
  assert.equal(body.reason, 'ARKHAM_RATE_LIMITED');
  assert.match(body.message, /failed read, not an absence of on-chain activity/);
  assert.equal(JSON.stringify(body).includes('raw upstream body'), false);
});

test('the route is declared at /api/arkham-token-intel', async () => {
  const mod = await import('../netlify/functions/arkham-token-intel.mjs');
  assert.equal(mod.config.path, '/api/arkham-token-intel');
  // No scheduled trigger may ever be attached to this route.
  assert.equal(Object.prototype.hasOwnProperty.call(mod.config, 'schedule'), false);
});
