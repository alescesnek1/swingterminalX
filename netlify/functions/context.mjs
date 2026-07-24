// Authenticated, read-only shadow API for the canonical Context Store. Existing
// Scanner/RADAR/Cockpit calls are deliberately not redirected here in this phase.
async function loadAuth() { return await import('./_auth.mjs'); }
async function loadStore() { return await import('./_market-context-store.mjs'); }
async function loadDb() { return await import('./_db.mjs'); }

function headers(req) {
  return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin, Authorization', 'Access-Control-Allow-Origin': req.headers.get('origin') || '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept' };
}
function json(req, body, status = 200) { return new Response(JSON.stringify(body), { status, headers: headers(req) }); }

export async function runContextRead(req, deps = {}) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });
  if (req.method !== 'GET') return json(req, { ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405);
  let getIdentity = deps.getIdentity;
  if (!getIdentity) {
    try { getIdentity = (await (deps.loadAuth || loadAuth)()).getIdentity; } catch { return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401); }
  }
  let identity;
  try { identity = await getIdentity(req); } catch { return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401); }
  if (!identity?.ok || identity.verified !== true) return json(req, { ok: false, reason: 'UNAUTHENTICATED' }, 401);
  let store = deps.store; let database = deps.database;
  try {
    store ||= await (deps.loadStore || loadStore)();
    if (!database) database = (await (deps.loadDb || loadDb)()).getDb().pool;
  } catch { return json(req, { ok: false, reason: 'DB_UNAVAILABLE' }, 503); }
  const context = await store.getPublishedContext(database, { rowLimit: 500, microLimit: 50 });
  if (!context?.ok) return json(req, { ok: false, reason: context?.reason || 'DB_UNAVAILABLE' }, 503);
  return json(req, context);
}

export default async function handler(req) { return await runContextRead(req); }
export const config = { path: '/api/context' };
