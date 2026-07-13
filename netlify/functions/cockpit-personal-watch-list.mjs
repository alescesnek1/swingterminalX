import { getIdentity } from './_auth.mjs';
import {
  addPersonalWatch,
  listPersonalWatches,
  publicPersonalWatchList,
  removePersonalWatch,
  validateWatchSymbol,
} from './_personal-watch-store.mjs';

// Cockpit personal watch-list (Phase 3) — selected-symbols-only CRUD.
//
// A sibling to /api/cockpit-personal-watch-settings. It manages the per-user
// symbol watch list (notify me when a symbol reaches a confirmed RADAR entry
// setup — delivery is a FUTURE phase). It NEVER sends Telegram, never touches
// Binance/orders/execution, and never returns the raw chat id. Auth is the
// shared getIdentity(); ownership is the token userId only.

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

// Symbol payload is tiny; cap the body before JSON.parse so a hostile/oversized
// body fails closed (400) instead of being parsed. Mirrors the settings handler.
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

export async function runPersonalWatchList(req, deps = {}) {
  const verifyIdentity = deps.getIdentity || getIdentity;
  const store = deps.store || { addPersonalWatch, listPersonalWatches, removePersonalWatch };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });

  const identity = await verifyIdentity(req);
  if (!identity || !identity.ok || !identity.userId) {
    return json(req, { ok: false, error: 'Unauthorized', reason: identity && identity.reason ? identity.reason : 'No bearer token' }, 401);
  }

  if (req.method === 'GET') {
    const watches = await store.listPersonalWatches(identity);
    return json(req, publicPersonalWatchList(watches));
  }

  if (req.method === 'POST' || req.method === 'DELETE') {
    let body;
    try {
      body = await parseBody(req);
    } catch (err) {
      return json(req, { ok: false, error: err.message }, 400);
    }
    // Validate the symbol shape before touching the store so a bad input is a
    // clean 400 regardless of add/remove.
    const valid = validateWatchSymbol(body.symbol);
    if (!valid.ok) return json(req, { ok: false, error: valid.error }, 400);

    const result = req.method === 'POST'
      ? await store.addPersonalWatch(identity, valid.symbol)
      : await store.removePersonalWatch(identity, valid.symbol);

    if (!result.ok) return json(req, { ok: false, error: result.error }, 400);
    return json(req, publicPersonalWatchList(result.watches));
  }

  return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
}

export default async function handler(req) {
  return await runPersonalWatchList(req);
}

export const config = {
  path: '/api/cockpit-personal-watch-list',
};
