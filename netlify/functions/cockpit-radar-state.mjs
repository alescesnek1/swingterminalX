// Authenticated, read-only, single-coin read of the atomized RADAR state.
//
// Why a dedicated route: /api/context returns the whole universe (2000 tickers, 600
// measurements, every RADAR candidate) in one payload. The Cockpit works ONE selected
// coin, so it had no cheap way to ask the database about that coin and instead used
// whatever the scanner happened to be holding in the browser. This route answers
// exactly one question — "what is the server's current RADAR verdict for this coin"
// — straight off the (market, symbol) primary key.
//
// It is a READ. It computes nothing, writes nothing, and changes no gate: the verdict
// it returns was produced by the RADAR publisher. Freshness is reported, never
// assumed, so the Cockpit can show an old verdict AS old rather than as current.
import {
  costGuardHeaders,
  masterKillSwitchEngaged,
  noteCostBreakerBlock,
  REASON_COST_BREAKER_DISABLED_PATH,
} from './_cost-breaker.mjs';

async function loadAuth() { return await import('./_auth.mjs'); }
async function loadStore() { return await import('./_market-context-store.mjs'); }
async function loadDb() { return await import('./_db.mjs'); }

// Two collector cycles, matching the market freshness bound in
// getAtomizedMarketContext. A verdict older than this is reported STALE — it is not
// withheld, because a stale verdict the user can see is safer than a blank panel.
const FRESH_MS = 6 * 60 * 1000;

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

const num = (value) => (value === null || value === undefined ? null : (Number.isFinite(Number(value)) ? Number(value) : null));

// Explicit column projection rather than echoing the stored payload: the columns are
// the atomized contract, and a blob echo would ship whatever else the evaluator
// happened to attach. NULL stays null so the client renders UNKNOWN, never a zero.
function present(row, nowMs) {
  const computedAtMs = row.computed_at ? new Date(row.computed_at).getTime() : NaN;
  const ageMs = Number.isFinite(computedAtMs) ? Math.max(0, nowMs - computedAtMs) : null;
  return {
    market: row.market,
    symbol: row.symbol,
    status: row.status,
    entryType: row.entry_type,
    entryReady: row.entry_ready === true,
    // Freshness is part of the answer, not metadata the caller has to infer.
    computedAt: row.computed_at ?? null,
    observedAt: row.observed_at ?? null,
    ageMs,
    freshness: ageMs === null ? 'UNKNOWN' : ageMs <= FRESH_MS ? 'FRESH' : 'STALE',
    scores: {
      setup: num(row.setup_score), execution: num(row.execution_score), riskReward: num(row.risk_reward_score),
      marketRegime: num(row.market_regime_score), confidence: num(row.confidence),
      dislocation: num(row.dislocation_score), flush: num(row.flush_score), stabilization: num(row.stabilization_score),
      reclaim: num(row.reclaim_score), orderBookSupport: num(row.order_book_support_score),
      flowConfirmation: num(row.flow_confirmation_score), derivativesRisk: num(row.derivatives_risk_score),
    },
    reclaim: { status: row.reclaim_status },
    absorb: {
      status: row.absorb_status, mode: row.absorb_mode,
      strictStatus: row.strict_absorb_status, strictScore: num(row.strict_absorb_score),
      strictConfirmed: row.strict_absorb_confirmed === true,
    },
    plan: {
      entryZoneLow: num(row.entry_zone_low), entryZoneHigh: num(row.entry_zone_high),
      stopLoss: num(row.stop_loss), hardInvalidation: num(row.hard_invalidation),
      tp1: num(row.tp1_level), tp2: num(row.tp2_level), tp3: num(row.tp3_level),
      positionSizePctLow: num(row.position_size_pct_low), positionSizePctHigh: num(row.position_size_pct_high),
      positionSizeGuidance: row.position_size_guidance,
      timeframeContext: row.timeframe_context, timeValidity: row.time_validity,
    },
    dataStatus: row.data_status,
    missingInputs: Array.isArray(row.missing_inputs) ? row.missing_inputs : [],
  };
}

export async function runCockpitRadarStateRead(req, deps = {}) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });
  if (req.method !== 'GET') return json(req, { ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405);

  let getIdentity = deps.getIdentity;
  if (!getIdentity) { try { getIdentity = (await (deps.loadAuth || loadAuth)()).getIdentity; } catch { return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401); } }
  let identity; try { identity = await getIdentity(req); } catch { return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401); }
  if (!identity?.ok || identity.verified !== true) return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);

  // Validate before touching the database. The store validates again — this is the
  // boundary check that turns junk input into an honest 400 instead of a 503.
  const url = new URL(req.url);
  const symbol = String(url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,32}$/.test(symbol)) return json(req, { ok: false, reason: 'INVALID_SYMBOL' }, 400);
  const requestedMarket = url.searchParams.get('market');
  const market = requestedMarket === 'spot' || requestedMarket === 'futures' ? requestedMarket : undefined;

  // Emergency master kill switch only — this endpoint keeps its normal
  // behaviour under the narrow flags, because a RADAR verdict the operator can
  // read is part of the safety surface. When the owner engages the master lever
  // the panel says so explicitly instead of reporting NOT_SCORED, which would
  // read as "the server rejected this setup".
  if (masterKillSwitchEngaged(deps.env || process.env)) {
    noteCostBreakerBlock('cockpit_radar_state', REASON_COST_BREAKER_DISABLED_PATH);
    return new Response(JSON.stringify({
      ok: false, disabled: true, symbol, reason: REASON_COST_BREAKER_DISABLED_PATH,
    }), { status: 200, headers: costGuardHeaders(REASON_COST_BREAKER_DISABLED_PATH, headers(req)) });
  }

  let store = deps.store; let database = deps.database;
  try {
    store ||= await (deps.loadStore || loadStore)();
    if (!database) database = (await (deps.loadDb || loadDb)()).getDb().pool;
  } catch { return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503); }

  const result = await store.getRadarCandidateState(database, symbol, { market });
  if (!result?.ok) {
    const reason = result?.reason || 'DB_UNAVAILABLE';
    return json(req, { ok: false, reason }, reason === 'INVALID_SYMBOL' ? 400 : 503);
  }
  // "Not scored" is a real, distinguishable answer — not an error, and not an empty
  // object the client could mistake for a computed verdict of nothing. But it has two
  // causes, so the miss carries the table's coverage: a gap for THIS coin
  // (other coins are scored) is a different fact from the publisher writing nothing
  // for anyone, and the client must be able to say which.
  if (!result.state) {
    // A failing coverage probe must not turn an honest 404 into a 500, so the miss is
    // answered with the coverage reported as unavailable.
    let coverage;
    try { coverage = await store.getRadarStateCoverage(database); } catch { coverage = null; }
    const covered = coverage && coverage.ok === true ? coverage.rows : null;
    const newest = coverage && coverage.ok === true ? coverage.newestComputedAt : null;
    const newestMs = newest ? new Date(newest).getTime() : NaN;
    return json(req, {
      ok: true, found: false, symbol,
      reason: covered === 0 ? 'RADAR_STATE_EMPTY' : 'NOT_SCORED',
      coverage: {
        scoredSymbols: covered,
        newestComputedAt: newest ?? null,
        newestAgeMs: Number.isFinite(newestMs) ? Math.max(0, Date.now() - newestMs) : null,
        available: !!(coverage && coverage.ok === true),
      },
    }, 404);
  }
  return json(req, { ok: true, found: true, state: present(result.state, Date.now()) });
}

export default async function handler(req) { return await runCockpitRadarStateRead(req); }
export const config = { path: '/api/cockpit-radar-state' };
