import { runMarketContextRetention } from './_market-context-retention.mjs';

function response(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Hourly retention sweep. Flag-gated (MARKET_CONTEXT_RETENTION_ENABLED, default
// off) so every invocation is a no-op until retention is explicitly enabled.
export default async function handler() {
  const result = await runMarketContextRetention();
  return response(result.body, result.status);
}

export const config = { schedule: '17 * * * *' };
