import { getIdentity } from './_auth.mjs';
import {
  loadPersonalWatchSettings,
  publicPersonalWatchSettings,
  removeTelegramChatId,
  saveTelegramChatId,
  validateTelegramChatId,
} from './_personal-watch-store.mjs';

function headers(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin, Authorization',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  };
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(req) });
}

// The only accepted payload is a short numeric Telegram chat id, so the body is
// tiny. Cap it before JSON.parse so a hostile/oversized body fails closed (400)
// instead of being parsed. Kept small and additive; no other behavior changes.
const MAX_BODY_BYTES = 10_000;

async function parseBody(req) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new Error('Request body too large.');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

export async function runPersonalWatchSettings(req, deps = {}) {
  const verifyIdentity = deps.getIdentity || getIdentity;
  const store = deps.store || {
    loadPersonalWatchSettings,
    saveTelegramChatId,
    removeTelegramChatId,
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });

  const identity = await verifyIdentity(req);
  if (!identity || !identity.ok || !identity.userId) {
    return json(req, { ok: false, error: 'Unauthorized', reason: identity && identity.reason ? identity.reason : 'No bearer token' }, 401);
  }

  if (req.method === 'GET') {
    const record = await store.loadPersonalWatchSettings(identity);
    return json(req, publicPersonalWatchSettings(record));
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await parseBody(req);
    } catch (err) {
      return json(req, { ok: false, error: err.message }, 400);
    }
    const valid = validateTelegramChatId(body.telegramChatId);
    if (!valid.ok) return json(req, { ok: false, error: valid.error }, 400);
    const record = await store.saveTelegramChatId(identity, valid.telegramChatId);
    return json(req, publicPersonalWatchSettings(record));
  }

  if (req.method === 'DELETE') {
    const record = await store.removeTelegramChatId(identity);
    return json(req, publicPersonalWatchSettings(record));
  }

  return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
}

export default async function handler(req) {
  return await runPersonalWatchSettings(req);
}

export const config = {
  path: '/api/cockpit-personal-watch-settings',
};
