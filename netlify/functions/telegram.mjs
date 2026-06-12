// Disabled legacy Telegram relay.
//
// Trading RADAR alerts are sent only from cron-alerts.mjs after a confirmed
// ENTRY_READY candidate and per-symbol cooldown. This endpoint intentionally
// refuses scanner/live-feed/generic payloads.

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  return new Response(JSON.stringify({
    ok: false,
    error: 'Legacy Telegram relay disabled. Trading RADAR sends only confirmed ENTRY_READY alerts from cron.',
  }), {
    status: 410,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
};

export const config = {
  path: '/api/telegram',
};
