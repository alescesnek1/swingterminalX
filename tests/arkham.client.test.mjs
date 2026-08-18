// Adapter guards for the Arkham Intel client (netlify/functions/_arkham-client.mjs).
//
// The whole point of this module is that it is OFF and CHEAP by default, and that
// no secret and no unvalidated input can escape it. These tests pin exactly that,
// and every "enabled" case is driven by a fake env + fake fetch — no test in this
// repo ever contacts Arkham.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARKHAM_API_HOST,
  ARKHAM_API_BASE_URL,
  ARKHAM_AUTH_HEADER,
  ARKHAM_ALLOWED_PATHS,
  ARKHAM_CREDIT_COSTS,
  ARKHAM_DEFAULTS,
  ARKHAM_ADVISORY_CONTRACT,
  readArkhamConfig,
  arkhamStatus,
  scrubSecret,
  normalizeArkhamSymbol,
  normalizeCoingeckoId,
  normalizeArkhamChain,
  normalizeContractAddress,
  resolveArkhamTokenIdentity,
  arkhamCacheKey,
  buildArkhamUrl,
  createArkhamCreditGuard,
  arkhamFetchJson,
  presentArkhamTokenIntel,
  emptyArkhamIntel,
} from '../netlify/functions/_arkham-client.mjs';

const KEY = 'ark_test_key_do_not_use_1234567890';
const enabledEnv = (over = {}) => ({ ARKHAM_ENABLED: 'true', ARKHAM_API_KEY: KEY, ARKHAM_DAILY_CREDIT_CAP: '10', ...over });

// A fetch that fails the test if it is ever called. Anything that must not reach
// the network gets this.
function forbiddenFetch() {
  return async () => { throw new Error('fetch must not be called'); };
}

test('every default is the OFF position', () => {
  assert.equal(ARKHAM_DEFAULTS.enabled, false);
  assert.equal(ARKHAM_DEFAULTS.dailyCreditCap, 0);
  assert.equal(ARKHAM_DEFAULTS.cacheTtlHours, 24);
  assert.equal(ARKHAM_DEFAULTS.maxSymbolsPerRequest, 1);

  const config = readArkhamConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.hasKey, false);
  assert.equal(config.dailyCreditCap, 0);
  assert.equal(config.cacheTtlHours, 24);
  assert.equal(config.maxSymbolsPerRequest, 1);
});

test('ARKHAM_ENABLED only enables on the exact string "true"', () => {
  for (const raw of [undefined, '', '1', 'yes', 'TRUE', 'True', 'on', 'false']) {
    assert.equal(readArkhamConfig({ ARKHAM_ENABLED: raw }).enabled, false, `"${raw}" must not enable`);
  }
  assert.equal(readArkhamConfig({ ARKHAM_ENABLED: 'true' }).enabled, true);
});

test('readArkhamConfig never returns the API key — only hasKey', () => {
  const config = readArkhamConfig(enabledEnv());
  assert.equal(config.hasKey, true);
  assert.equal(JSON.stringify(config).includes(KEY), false);
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'apiKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'ARKHAM_API_KEY'), false);
});

test('the status ladder reports DISABLED -> NOT_CONFIGURED -> COST_CAPPED -> READY', () => {
  assert.equal(arkhamStatus({}).status, 'DISABLED');
  assert.equal(arkhamStatus({ ARKHAM_ENABLED: 'true' }).status, 'NOT_CONFIGURED');
  assert.equal(arkhamStatus({ ARKHAM_ENABLED: 'true', ARKHAM_API_KEY: KEY }).status, 'COST_CAPPED');
  assert.equal(arkhamStatus(enabledEnv()).status, 'READY');
  // Cap 0 is the default, so "enabled + keyed" alone still spends nothing.
  assert.equal(arkhamStatus({ ARKHAM_ENABLED: 'true', ARKHAM_API_KEY: KEY, ARKHAM_DAILY_CREDIT_CAP: '0' }).status, 'COST_CAPPED');
});

test('no status message ever contains the key', () => {
  for (const env of [{}, { ARKHAM_ENABLED: 'true' }, { ARKHAM_ENABLED: 'true', ARKHAM_API_KEY: KEY }, enabledEnv()]) {
    const gate = arkhamStatus(env);
    assert.equal(gate.message.includes(KEY), false);
    assert.equal(JSON.stringify(gate).includes(KEY), false);
  }
  // The NOT_CONFIGURED message names the variable, which is the point — it must
  // tell the owner what to set without echoing any value.
  assert.match(arkhamStatus({ ARKHAM_ENABLED: 'true' }).message, /ARKHAM_API_KEY/);
});

test('scrubSecret redacts the key if it ever reaches a message', () => {
  const env = enabledEnv();
  assert.equal(scrubSecret(`boom ${KEY} boom`, env), 'boom [redacted] boom');
  assert.equal(scrubSecret('nothing sensitive', env), 'nothing sensitive');
  // A short/absent key must not turn into a wildcard redaction.
  assert.equal(scrubSecret('abc', { ARKHAM_API_KEY: '' }), 'abc');
});

test('identifier normalization rejects anything that could reach a URL or cache key', () => {
  assert.equal(normalizeArkhamSymbol('sol'), 'SOL');
  assert.equal(normalizeArkhamSymbol('  eth '), 'ETH');
  for (const bad of ['', 'a', '../etc', 'SOL/USDT', 'SOL USDT', 'S+L', 'x'.repeat(33), null, 42, {}]) {
    assert.equal(normalizeArkhamSymbol(bad), null, `${JSON.stringify(bad)} must be refused`);
  }

  assert.equal(normalizeCoingeckoId('Solana'), 'solana');
  assert.equal(normalizeCoingeckoId('wrapped-bitcoin'), 'wrapped-bitcoin');
  for (const bad of ['', '-leading', '../solana', 'sol ana', 'sol/ana', 'sol?x=1', null]) {
    assert.equal(normalizeCoingeckoId(bad), null, `${JSON.stringify(bad)} must be refused`);
  }

  assert.equal(normalizeArkhamChain('Ethereum'), 'ethereum');
  assert.equal(normalizeArkhamChain('made-up-chain'), null);

  assert.equal(normalizeContractAddress('0xA0b86991C6218B36c1D19D4A2E9EB0CE3606EB48'), '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  assert.equal(normalizeContractAddress('0xnothex'), null);
  assert.equal(normalizeContractAddress('../../etc/passwd'), null);
});

test('identity resolution prefers the strong identifiers and flags a symbol-only read as weak', () => {
  const strong = resolveArkhamTokenIdentity({ symbol: 'SOL', coingeckoId: 'solana' });
  assert.equal(strong.source, 'coingecko_id');
  assert.equal(strong.strong, true);

  const contract = resolveArkhamTokenIdentity({ symbol: 'USDC', chain: 'ethereum', contractAddress: '0xA0b86991C6218B36c1D19D4A2E9EB0CE3606EB48' });
  assert.equal(contract.source, 'chain_contract');
  assert.equal(contract.strong, true);

  const weak = resolveArkhamTokenIdentity({ symbol: 'SOL' });
  assert.equal(weak.source, 'symbol');
  assert.equal(weak.strong, false, 'a ticker collides across chains and must be marked weak');

  assert.equal(resolveArkhamTokenIdentity({ symbol: '../etc' }).ok, false);
  assert.equal(resolveArkhamTokenIdentity({}).reason, 'ARKHAM_IDENTITY_UNRESOLVED');
});

test('the cache key is built only from normalized identity, never raw input', () => {
  assert.equal(arkhamCacheKey(resolveArkhamTokenIdentity({ symbol: 'SOL', coingeckoId: 'Solana' })), 'arkham:v1:cg:solana');
  assert.equal(arkhamCacheKey(resolveArkhamTokenIdentity({ symbol: 'sol' })), 'arkham:v1:sym:SOL');
  assert.equal(
    arkhamCacheKey(resolveArkhamTokenIdentity({ symbol: 'USDC', chain: 'Ethereum', contractAddress: '0xA0b86991C6218B36c1D19D4A2E9EB0CE3606EB48' })),
    'arkham:v1:chain:ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  );
  // Raw, hostile input can never produce a key — not a sanitized one, none at all.
  assert.equal(arkhamCacheKey({ ok: true, symbol: '../../secret', coingeckoId: 'a/b', chain: 'x', contractAddress: 'y' }), null);
  assert.equal(arkhamCacheKey(null), null);
  assert.equal(arkhamCacheKey({ ok: false }), null);
  // Whatever key is produced contains only characters safe for a store path.
  for (const identity of [{ symbol: 'SOL' }, { symbol: 'SOL', coingeckoId: 'solana' }]) {
    assert.match(arkhamCacheKey(resolveArkhamTokenIdentity(identity)), /^arkham:v1:[a-z]+:[a-zA-Z0-9:\-_]+$/);
  }
});

test('URL building is pinned to the single allowlisted HTTPS Arkham host', () => {
  const built = buildArkhamUrl(`${ARKHAM_ALLOWED_PATHS.TOKEN_INTELLIGENCE}/solana`);
  assert.equal(built.ok, true);
  assert.equal(built.url, `${ARKHAM_API_BASE_URL}/intelligence/token/solana`);
  assert.equal(new URL(built.url).host, ARKHAM_API_HOST);
  assert.equal(new URL(built.url).protocol, 'https:');

  // An absolute URL to another host cannot be smuggled in as a "path".
  for (const bad of ['https://evil.example.com/x', '//evil.example.com/x', 'http://api.arkm.com/x', 'intelligence/token/solana', '/intelligence/token/solana?x=1', '']) {
    assert.equal(buildArkhamUrl(bad).ok, false, `${bad} must be refused`);
  }
  assert.equal(buildArkhamUrl('/x', { 'bad key': '1' }).ok, false);
});

test('the credit guard blocks everything at the default cap of 0', () => {
  const guard = createArkhamCreditGuard({ dailyCreditCap: 0 });
  assert.equal(guard.reserve(1), false);
  assert.equal(guard.spent(), 0);
});

test('the credit guard caps spend and rolls over by UTC day', () => {
  let nowMs = Date.parse('2026-08-18T10:00:00Z');
  const guard = createArkhamCreditGuard({ dailyCreditCap: 3, now: () => nowMs });
  assert.equal(guard.reserve(2), true);
  assert.equal(guard.remaining(), 1);
  assert.equal(guard.reserve(2), false, 'a reservation that would exceed the cap is refused whole');
  assert.equal(guard.reserve(1), true);
  assert.equal(guard.remaining(), 0);
  // A failed upstream call is not billed by Arkham, so the reservation returns.
  guard.refund(1);
  assert.equal(guard.remaining(), 1);
  nowMs = Date.parse('2026-08-19T00:00:01Z');
  assert.equal(guard.remaining(), 3, 'the bucket resets on the next UTC day');
});

test('a disabled adapter performs NO fetch and says so', async () => {
  const result = await arkhamFetchJson({ path: '/intelligence/token/solana', env: {}, fetchImpl: forbiddenFetch() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ARKHAM_DISABLED');
  assert.equal(result.status, 'DISABLED');
});

test('enabled-without-a-key performs NO fetch and does not throw a secret-bearing error', async () => {
  const result = await arkhamFetchJson({ path: '/intelligence/token/solana', env: { ARKHAM_ENABLED: 'true' }, fetchImpl: forbiddenFetch() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ARKHAM_NOT_CONFIGURED');
  assert.equal(JSON.stringify(result).includes('ARKHAM_API_KEY='), false);
});

test('a zero credit cap performs NO fetch', async () => {
  const result = await arkhamFetchJson({
    path: '/intelligence/token/solana',
    env: { ARKHAM_ENABLED: 'true', ARKHAM_API_KEY: KEY, ARKHAM_DAILY_CREDIT_CAP: '0' },
    fetchImpl: forbiddenFetch(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ARKHAM_COST_CAPPED');
});

test('a mocked enabled fetch reaches only the approved Arkham host, with header-only auth', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ entityName: 'Solana Foundation', entityType: 'fund' }) };
  };
  const result = await arkhamFetchJson({
    path: `${ARKHAM_ALLOWED_PATHS.TOKEN_INTELLIGENCE}/solana`,
    creditCost: ARKHAM_CREDIT_COSTS.TOKEN_INTELLIGENCE,
    env: enabledEnv(),
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, 'exactly one request — no retry loop');

  const url = new URL(calls[0].url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, ARKHAM_API_HOST);
  assert.equal(url.pathname, '/intelligence/token/solana');
  // The key is a header, never a query parameter — the URL must be safe to log.
  assert.equal(calls[0].url.includes(KEY), false);
  assert.equal(url.search, '');
  assert.equal(calls[0].init.headers[ARKHAM_AUTH_HEADER], KEY);
  assert.equal(calls[0].init.method, 'GET');
  assert.ok(calls[0].init.signal, 'the request is bounded by an abort signal');
});

test('a hostile path is refused before any fetch, even when fully enabled', async () => {
  const result = await arkhamFetchJson({ path: 'https://evil.example.com/steal', env: enabledEnv(), fetchImpl: forbiddenFetch() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ARKHAM_INVALID_PATH');
});

test('upstream failures collapse to stable reasons and never surface the body or the key', async () => {
  const cases = [
    [401, 'ARKHAM_AUTH_REJECTED'], [403, 'ARKHAM_AUTH_REJECTED'],
    [404, 'ARKHAM_NOT_FOUND'], [429, 'ARKHAM_RATE_LIMITED'], [503, 'ARKHAM_HTTP_503'],
  ];
  for (const [status, expected] of cases) {
    const result = await arkhamFetchJson({
      path: '/intelligence/token/solana',
      env: enabledEnv(),
      fetchImpl: async () => ({ ok: false, status, json: async () => ({ secret: KEY, detail: 'raw upstream body' }) }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, expected);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(KEY), false);
    assert.equal(serialized.includes('raw upstream body'), false);
  }
});

test('a failed upstream call refunds its credit reservation (Arkham does not bill 4xx/5xx)', async () => {
  const guard = createArkhamCreditGuard({ dailyCreditCap: 2 });
  await arkhamFetchJson({ path: '/intelligence/token/solana', env: enabledEnv(), guard, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(guard.spent(), 0);
  await arkhamFetchJson({ path: '/intelligence/token/solana', env: enabledEnv(), guard, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.equal(guard.spent(), 1, 'a successful call is charged');
});

test('a thrown or timed-out fetch is a distinguishable reason, never a silent empty result', async () => {
  const thrown = await arkhamFetchJson({ path: '/intelligence/token/solana', env: enabledEnv(), fetchImpl: async () => { throw new Error(`network exploded with ${KEY}`); } });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reason, 'ARKHAM_FETCH_FAILED');
  assert.equal(JSON.stringify(thrown).includes(KEY), false);

  const aborted = await arkhamFetchJson({
    path: '/intelligence/token/solana',
    env: enabledEnv(),
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  });
  assert.equal(aborted.reason, 'ARKHAM_TIMEOUT');

  const badBody = await arkhamFetchJson({ path: '/intelligence/token/solana', env: enabledEnv(), fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) });
  assert.equal(badBody.reason, 'ARKHAM_INVALID_RESPONSE');
});

test('every advisory field starts UNKNOWN (null) — never 0 and never a directional default', () => {
  const empty = emptyArkhamIntel();
  for (const [field, value] of Object.entries(empty)) {
    assert.equal(value, null, `${field} must start null, not a value a reader could act on`);
  }
});

test('the presenter keeps missing figures null and reports WHICH parts are unknown', () => {
  const { intel, missing } = presentArkhamTokenIntel({ entityName: 'Binance', entityType: 'cex' });
  assert.equal(intel.entity.name, 'Binance');
  assert.equal(intel.holderConcentration, null);
  assert.equal(intel.exchangeNetflow, null);
  assert.ok(missing.includes('holderConcentration'));
  assert.ok(missing.includes('exchangeNetflow'));
  assert.ok(missing.includes('riskFlags'));

  // Number(null) === 0 trap: a null/'' figure must stay null, not become a real 0.
  const nulls = presentArkhamTokenIntel({ topHoldersPct: null, holderCount: '', inflowUsd: null, outflowUsd: '' });
  assert.equal(nulls.intel.holderConcentration, null);
  assert.equal(nulls.intel.exchangeNetflow, null);

  // A one-sided netflow is not a netflow — it must not render as a direction.
  const oneSided = presentArkhamTokenIntel({ inflowUsd: 1_000_000 });
  assert.equal(oneSided.intel.exchangeNetflow, null);
  assert.ok(oneSided.missing.includes('exchangeNetflow'));

  const bothSides = presentArkhamTokenIntel({ inflowUsd: 1_000_000, outflowUsd: 250_000, windowHours: 24 });
  assert.equal(bothSides.intel.exchangeNetflow.netUsd, 750_000);
});

test('the advisory contract denies every gate it could be mistaken for', () => {
  assert.equal(ARKHAM_ADVISORY_CONTRACT.advisoryOnly, true);
  assert.equal(ARKHAM_ADVISORY_CONTRACT.affectsTrading, false);
  for (const key of ['radar', 'entryReady', 'strictAbsorb', 'reclaim', 'telegram', 'alerts', 'orders', 'scannerRanking', 'leadScore', 'defaultSorting', 'valuation', 'gateChecklist']) {
    assert.equal(ARKHAM_ADVISORY_CONTRACT.affects[key], false, `${key} must be declared unaffected`);
  }
  assert.match(ARKHAM_ADVISORY_CONTRACT.disclaimer, /Not investment advice/);
});
