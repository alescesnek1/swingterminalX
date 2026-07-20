import { getIdentity } from './_auth.mjs';
import { getPersonalWatchRecordForDiagnostic } from './_personal-watch-store.mjs';

function headers(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin, Authorization',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  };
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(req) });
}

async function recordDiagnosticEvent(event, payload, deps) {
  try {
    const writeSystemEvent = deps.writeSystemEvent || (await import('./_observability.mjs')).writeSystemEvent;
    const result = await writeSystemEvent({ level: 'warn', event, source: 'cockpit-personal-watch-diagnostic-target', payload });
    if (!result || result.ok !== true) console.warn('[cockpitDiagnosticTarget] observability write unavailable', { reason: result?.reason || 'UNKNOWN' });
  } catch (err) {
    console.warn('[cockpitDiagnosticTarget] observability write failed', { name: err?.name || 'Error' });
  }
}
// Authenticated, read-only helper for the owner configuring the separate
// diagnostic sender. The returned id is the current caller's own identity id;
// no other user's record is enumerated or exposed.
export async function runPersonalWatchDiagnosticTarget(req, deps = {}) {
  const verifyIdentity = deps.getIdentity || getIdentity;
  const getRecord = deps.getRecord || getPersonalWatchRecordForDiagnostic;

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });

  const identity = await verifyIdentity(req);
  if (!identity || !identity.ok || !identity.userId) {
    return json(req, { ok: false, error: 'Unauthorized' }, 401);
  }

  if (req.method !== 'GET') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);

  let result;
  try {
    result = await getRecord(identity.userId);
  } catch {
    await recordDiagnosticEvent('cockpit_diagnostic_store_unavailable', { component: 'personal-watch-diagnostic-target', reason: 'STORE_UNAVAILABLE', status: 'degraded' }, deps);
    return json(req, { ok: false, error: 'Personal Watch store unavailable' }, 503);
  }

  const record = result && result.record && typeof result.record === 'object' ? result.record : {};
  const watches = Array.isArray(record.watches) ? record.watches : [];
  const hasChat = /^\d{5,20}$/.test(String(record.telegramChatId || '').trim());

  if (result?.found !== true || !hasChat || watches.length !== 1) {
    await recordDiagnosticEvent('cockpit_diagnostic_target_incomplete', { component: 'personal-watch-diagnostic-target', reason: 'DIAGNOSTIC_TARGET_INCOMPLETE', status: 'degraded', hasPersonalWatchRecord: result?.found === true, hasChat, watchCount: watches.length }, deps);
  }

  return json(req, {
    ok: true,
    diagnosticTargetUserId: identity.userId,
    hasPersonalWatchRecord: result && result.found === true,
    hasChat,
    watchCount: watches.length,
    exactlyOneWatch: watches.length === 1,
  });
}

export default async function handler(req) {
  return await runPersonalWatchDiagnosticTarget(req);
}

export const config = {
  path: '/api/cockpit-personal-watch-diagnostic-target',
};
