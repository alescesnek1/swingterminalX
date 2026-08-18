// GET /api/arkham-token-intel?symbol=SOL — advisory Arkham on-chain intel for ONE coin.
//
// DISABLED BY DEFAULT. With `ARKHAM_ENABLED` unset (the production state) this
// route makes no external call at all and answers HTTP 200 with
// `status: "DISABLED"`. That is a deliberate 200: "the feature is off" is a real,
// honest answer the UI can render, not a failure to report.
//
// SHAPE OF THE GUARD LADDER (order matters, and the order is the safety argument)
//   1. method            — GET/OPTIONS only
//   2. auth              — verified identity required, same bar as
//                          /api/cockpit-radar-state. Nothing is answered to an
//                          unauthenticated caller, not even the feature's state.
//   3. request validation— symbol/coingeckoId/chain/contract must normalize, and
//                          only ONE coin per request. This runs BEFORE the
//                          enable check so a cache key can never be derived from
//                          unvalidated input, and so garbage input is honestly a
//                          400 rather than being masked by the DISABLED answer.
//   4. enable / key / cap— DISABLED → NOT_CONFIGURED → COST_CAPPED, all HTTP 200,
//                          all with no fetch. A missing key is a config gap, not
//                          a 500, and its message names the env var without ever
//                          echoing a value.
//   5. upstream          — one call, one coin, bounded, no retry, credit-metered.
//
// This route is READ-ONLY and ADVISORY. It changes no gate, writes no store, and
// nothing in RADAR / ENTRY_READY / strict Absorb / Reclaim / Telegram / alerts /
// Scanner ranking / order paths imports it or reads its output.
async function loadAuth() { return await import('./_auth.mjs'); }
async function loadArkham() { return await import('./_arkham-client.mjs'); }

function headers(req) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin, Authorization',
    'Access-Control-Allow-Origin': req.headers.get('origin') || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  };
}
function json(req, body, status = 200) { return new Response(JSON.stringify(body), { status, headers: headers(req) }); }

// Every response carries the advisory contract, so no consumer can read this
// payload as a trading signal by accident.
function envelope(arkham, extra) {
  return {
    ok: true,
    source: 'arkham',
    ...arkham.ARKHAM_ADVISORY_CONTRACT,
    ...extra,
  };
}

export async function runArkhamTokenIntel(req, deps = {}) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });
  if (req.method !== 'GET') return json(req, { ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405);

  const env = deps.env || process.env;

  let arkham = deps.arkham;
  if (!arkham) {
    try {
      arkham = await (deps.loadArkham || loadArkham)();
    } catch (e) {
      console.warn('[ARKHAM] adapter failed to load:', (e && e.name) || 'unknown');
      return json(req, { ok: false, reason: 'ARKHAM_ADAPTER_UNAVAILABLE' }, 503);
    }
  }

  // ── 2. Auth: identical bar to the other protected Node reads. A disabled
  // feature still must not answer an anonymous caller — that keeps this route
  // from becoming a probe for our configuration state.
  let getIdentity = deps.getIdentity;
  if (!getIdentity) {
    try { getIdentity = (await (deps.loadAuth || loadAuth)()).getIdentity; }
    catch { return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401); }
  }
  let identity;
  try { identity = await getIdentity(req); } catch { return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401); }
  if (!identity?.ok || identity.verified !== true) return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);

  // ── 3. Request validation, before anything else touches the input.
  const url = new URL(req.url);
  const arkhamConfig = arkham.readArkhamConfig(env);

  const rawSymbol = String(url.searchParams.get('symbol') || '');
  // A comma/space-separated list is an attempted batch. Refuse it rather than
  // silently taking the first element — a batch is exactly the cost shape this
  // feature exists to avoid.
  if (/[,;\s]/.test(rawSymbol.trim())) {
    return json(req, { ok: false, reason: 'ARKHAM_TOO_MANY_SYMBOLS', maxSymbolsPerRequest: arkhamConfig.maxSymbolsPerRequest }, 400);
  }
  const symbol = arkham.normalizeArkhamSymbol(rawSymbol);
  if (!symbol) return json(req, { ok: false, reason: 'INVALID_SYMBOL' }, 400);

  // Optional stronger identifiers. Present-but-invalid is a 400, not a silent
  // downgrade to symbol-only — a caller that thinks it passed a contract address
  // must not get intelligence about a same-ticker token on another chain.
  const rawCoingeckoId = url.searchParams.get('coingeckoId');
  const coingeckoId = rawCoingeckoId ? arkham.normalizeCoingeckoId(rawCoingeckoId) : null;
  if (rawCoingeckoId && !coingeckoId) return json(req, { ok: false, reason: 'INVALID_COINGECKO_ID' }, 400);

  const rawChain = url.searchParams.get('chain');
  const chain = rawChain ? arkham.normalizeArkhamChain(rawChain) : null;
  if (rawChain && !chain) return json(req, { ok: false, reason: 'INVALID_CHAIN' }, 400);

  const rawContract = url.searchParams.get('contract');
  const contractAddress = rawContract ? arkham.normalizeContractAddress(rawContract) : null;
  if (rawContract && !contractAddress) return json(req, { ok: false, reason: 'INVALID_CONTRACT_ADDRESS' }, 400);

  const identityResult = arkham.resolveArkhamTokenIdentity({ symbol, coingeckoId, chain, contractAddress });
  if (!identityResult.ok) return json(req, { ok: false, reason: identityResult.reason }, 400);
  // Derived only from normalized values — never from raw query input.
  const cacheKey = arkham.arkhamCacheKey(identityResult);

  const tokenIdentity = {
    symbol: identityResult.symbol,
    source: identityResult.source,
    strong: identityResult.strong === true,
    coingeckoId: identityResult.coingeckoId,
    chain: identityResult.chain,
    contractAddress: identityResult.contractAddress,
  };
  const cache = { key: cacheKey, ttlHours: arkhamConfig.cacheTtlHours, hit: false, store: 'none_yet' };

  // ── 4. The off positions. All HTTP 200, all without any external call.
  const gate = arkham.arkhamStatus(env);
  if (gate.status !== 'READY') {
    return json(req, envelope(arkham, {
      status: gate.status,           // DISABLED | NOT_CONFIGURED | COST_CAPPED
      message: gate.message,
      symbol,
      identity: tokenIdentity,
      cache,
      intel: null,
      missing: ['entity', 'holderConcentration', 'exchangeNetflow', 'whaleTransfers', 'counterparties', 'riskFlags', 'tokenFlowSummary'],
      fetched: false,
    }));
  }

  // ── 5. Enabled path. Arkham's token endpoints are keyed by CoinGecko pricing
  // ID, so without a confirmed one there is nothing to ask — and guessing an id
  // from a ticker would risk returning another token's intelligence. That is
  // reported as its own status, never as "no data".
  if (!tokenIdentity.coingeckoId) {
    return json(req, envelope(arkham, {
      status: 'IDENTITY_UNRESOLVED',
      message: 'Arkham token endpoints are keyed by CoinGecko pricing ID. Pass a confirmed coingeckoId for this coin — a ticker alone is ambiguous across chains and will not be guessed.',
      symbol,
      identity: tokenIdentity,
      cache,
      intel: null,
      missing: ['entity', 'holderConcentration', 'exchangeNetflow', 'whaleTransfers', 'counterparties', 'riskFlags', 'tokenFlowSummary'],
      fetched: false,
    }));
  }

  const result = await arkham.arkhamFetchJson({
    path: `${arkham.ARKHAM_ALLOWED_PATHS.TOKEN_INTELLIGENCE}/${tokenIdentity.coingeckoId}`,
    creditCost: arkham.ARKHAM_CREDIT_COSTS.TOKEN_INTELLIGENCE,
    env,
    fetchImpl: deps.fetchImpl,
  });

  if (!result.ok) {
    // An upstream failure is reported AS a failure with its reason visible, never
    // as an empty panel. No raw upstream body and no key can reach here.
    return json(req, envelope(arkham, {
      status: 'UPSTREAM_ERROR',
      reason: result.reason,
      message: `Arkham lookup failed (${result.reason}). This is a failed read, not an absence of on-chain activity.`,
      symbol,
      identity: tokenIdentity,
      cache,
      intel: null,
      missing: ['entity', 'holderConcentration', 'exchangeNetflow', 'whaleTransfers', 'counterparties', 'riskFlags', 'tokenFlowSummary'],
      fetched: false,
    }));
  }

  const presented = arkham.presentArkhamTokenIntel(result.data);
  return json(req, envelope(arkham, {
    status: 'OK',
    message: 'Advisory on-chain context only.',
    symbol,
    identity: tokenIdentity,
    cache,
    intel: presented.intel,
    missing: presented.missing,
    fetched: true,
    creditsCharged: result.creditsCharged ?? null,
  }));
}

export default async function handler(req) { return await runArkhamTokenIntel(req); }
export const config = { path: '/api/arkham-token-intel' };
