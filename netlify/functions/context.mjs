// Authenticated, read-only API over canonical atomized PostgreSQL records.
async function loadAuth() { return await import('./_auth.mjs'); }
async function loadSafety() { return await import('../../scripts/safety/chain-safety.mjs'); }

// The scanner reads safety off the market row (`row.safetyStatus`), but the
// canonical rows are raw atoms and carried none — so the safety column was blank
// for every coin even though the classifier resolves them perfectly well from the
// listing axis alone. Classification is pure and I/O-free, so it is done here
// once per read rather than pushed into the DB layer or duplicated in the browser.
function withSafety(tickers, classifyMarketSafety) {
  return tickers.map((row) => {
    try {
      const safety = classifyMarketSafety({
        symbol: row.symbol, baseAsset: row.base_asset, quoteAsset: row.quote_asset,
        status: 'TRADING', exchange: 'binance', binanceListed: true,
        quoteVolume: Number(row.quote_volume),
      });
      return {
        ...row,
        safety_status: safety.safetyStatus, safety_reason: safety.safetyReason,
        safety_basis: safety.safetyBasis, safety_source: safety.source,
        listing_safety_status: safety.listingSafetyStatus,
      };
    } catch { return row; }
  });
}
async function loadStore() { return await import('./_market-context-store.mjs'); }
async function loadDb() { return await import('./_db.mjs'); }
function headers(req) { return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin, Authorization', 'Access-Control-Allow-Origin': req.headers.get('origin') || '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept' }; }
function json(req, body, status = 200) { return new Response(JSON.stringify(body), { status, headers: headers(req) }); }
export async function runContextRead(req, deps = {}) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });
  if (req.method !== 'GET') return json(req, { ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405);
  let getIdentity = deps.getIdentity; if (!getIdentity) { try { getIdentity = (await (deps.loadAuth || loadAuth)()).getIdentity; } catch { return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401); } }
  let identity; try { identity = await getIdentity(req); } catch { return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401); }
  if (!identity?.ok || identity.verified !== true) return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);
  let store = deps.store; let database = deps.database; try { store ||= await (deps.loadStore || loadStore)(); if (!database) database = (await (deps.loadDb || loadDb)()).getDb().pool; } catch { return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503); }
  // Over-fetch deliberately: the reader collapses spot/futures rows of the same
  // base asset into one coin, so ~1000 displayed coins needs materially more rows
  // than 1000 here.
  const context = await store.getAtomizedMarketContext(database, { tickerLimit: 2000, microLimit: 600 });
  if (!context?.ok) return json(req, { ok: false, reason: context?.reason || 'DB_UNAVAILABLE' }, 503);
  // Safety annotation must never take the read down: a classifier failure leaves
  // the rows unannotated (blank, i.e. UNKNOWN) rather than failing the response.
  if (context.market && Array.isArray(context.market.tickers)) {
    try {
      const { classifyMarketSafety } = deps.safety || await (deps.loadSafety || loadSafety)();
      context.market.tickers = withSafety(context.market.tickers, classifyMarketSafety);
    } catch (error) { console.warn('[CONTEXT] safety_annotation_unavailable', { name: error?.name || 'Error' }); }
  }
  return json(req, context);
}
export default async function handler(req) { return await runContextRead(req); }
export const config = { path: '/api/context' };