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
    return json(req, { ok: false, error: 'Personal Watch store unavailable' }, 503);
  }

  const record = result && result.record && typeof result.record === 'object' ? result.record : {};
  const watches = Array.isArray(record.watches) ? record.watches : [];
  const hasChat = /^\d{5,20}$/.test(String(record.telegramChatId || '').trim());

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
