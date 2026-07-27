import { runPersonalWatchTriggers } from './_personal-watch-notifier.mjs';

// Native Netlify schedule — no external scheduler and no GitHub Actions. The
// existing personal-alerts endpoint needs a custom auth header that Netlify's
// native trigger cannot attach, which is why it lives outside; this run needs no
// header because it is invoked in-process rather than over HTTP, so it has no
// public surface to protect.
//
// Flag-gated: with PERSONAL_WATCH_TRIGGERS_ENABLED unset every invocation is a
// no-op that touches no database and sends nothing.
export default async function handler() {
  let result;
  try { result = await runPersonalWatchTriggers(); }
  catch (error) {
    console.error('[PERSONAL_WATCH] cycle_threw', { name: error?.name || 'Error' });
    return new Response(JSON.stringify({ ok: false, reason: 'WATCH_TRIGGER_CYCLE_FAILED' }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  // A Netlify v2 function must resolve to a Response; returning a bare object
  // fails the invocation AFTER the work ran and makes Netlify retry it.
  return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export const config = { schedule: '*/5 * * * *' };
