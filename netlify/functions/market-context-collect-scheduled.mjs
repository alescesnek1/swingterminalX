import { runMarketContextCollector } from './_market-context-collector.mjs';

function response(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Netlify invokes this on its own schedule. No `path` is configured, no public
// POST writer exists, and the default collector flag makes every invocation a
// no-op without database/network access.
export default async function handler() {
  const result = await runMarketContextCollector();
  return response(result.body, result.status);
}

export const config = { schedule: '*/3 * * * *' };
