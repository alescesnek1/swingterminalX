// Private retention coordinator for the canonical Context Store. Flag-gated and a
// no-op by default. It never deletes instruments or run audit metadata and never
// touches the latest published run (the store's prune protects it); it only drops
// heavy atomic child rows older than the configured windows. A hard MIN_HOURS
// floor prevents a mis-set env value from pruning recent, still-needed data.
export const MARKET_CONTEXT_RETENTION_ENV_FLAG = 'MARKET_CONTEXT_RETENTION_ENABLED';
export const MARKET_CONTEXT_RETENTION_MARKET_HOURS_FLAG = 'MARKET_CONTEXT_RETENTION_MARKET_HOURS';
export const MARKET_CONTEXT_RETENTION_RADAR_HOURS_FLAG = 'MARKET_CONTEXT_RETENTION_RADAR_HOURS';

const DEFAULT_MARKET_HOURS = 48;
const DEFAULT_RADAR_HOURS = 24 * 7;
const MIN_HOURS = 6;
const MAX_HOURS = 24 * 90;

async function loadStore() { return await import('./_market-context-store.mjs'); }
function outcome(status, body) { return { status, body: { endpoint: 'market_context_retention', ...body } }; }
function hours(env, key, fallback) {
  const raw = Number(env[key]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(raw), MIN_HOURS), MAX_HOURS);
}

export async function runMarketContextRetention(deps = {}) {
  const env = deps.env || process.env;
  if (env[MARKET_CONTEXT_RETENTION_ENV_FLAG] !== 'true') return outcome(200, { ok: true, skipped: true, reason: 'RETENTION_DISABLED' });
  let store; try { store = deps.store || await (deps.loadStore || loadStore)(); } catch { return outcome(503, { ok: false, reason: 'DB_UNAVAILABLE' }); }
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const marketHours = hours(env, MARKET_CONTEXT_RETENTION_MARKET_HOURS_FLAG, DEFAULT_MARKET_HOURS);
  const radarHours = Math.max(hours(env, MARKET_CONTEXT_RETENTION_RADAR_HOURS_FLAG, DEFAULT_RADAR_HOURS), marketHours);
  const marketCutoff = new Date(now - marketHours * 3600_000);
  const radarCutoff = new Date(now - radarHours * 3600_000);
  const transaction = deps.withTransaction || store.withContextTransaction;
  const tx = await transaction(async (db) => store.pruneCanonicalContext(db, { marketCutoff, radarCutoff }), { getDbImpl: deps.getDbImpl });
  if (!tx?.ok) { console.warn('[MARKET_CONTEXT] retention_failed', { reason: tx?.reason || 'DB_UNAVAILABLE' }); return outcome(503, { ok: false, reason: tx?.reason || 'DB_UNAVAILABLE' }); }
  console.info('[MARKET_CONTEXT] retention_completed', { marketHours, radarHours, protectedRunId: tx.protectedRunId, deleted: tx.deleted });
  return outcome(200, { ok: true, skipped: false, marketHours, radarHours, protectedRunId: tx.protectedRunId, deleted: tx.deleted });
}
