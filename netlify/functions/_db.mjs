// Postgres connection helper — Phase 2B infrastructure only.
//
// This module is NOT wired into any product function yet. It exists so a
// future observability/data function can call getDb() instead of each
// hand-rolling its own @netlify/database setup. Importing this file has
// zero side effects: no query runs, no connection opens, and nothing is
// read from the environment until getDb() is actually called.
//
// SECURITY: never log the connection string or any value returned by
// @netlify/database's getConnectionString(). The connection string is
// read from the NETLIFY_DB_URL env var by the SDK itself — this module
// never reads or prints that value directly.

import { getDatabase } from '@netlify/database';

let _cached = null;

// Returns the shared { sql, pool, driver, connectionString } connection
// object from @netlify/database, creating it lazily on first call. Callers
// that only need to run SQL should use the returned `sql` tag; `pool` is
// exposed for callers that need raw pg.Pool access.
//
// Throws MissingDatabaseConnectionError (from @netlify/database) if
// NETLIFY_DB_URL is not configured in the current environment. Callers are
// responsible for catching this and surfacing a DEGRADED/FAILED state —
// per this repo's error-observability rules, never swallow it silently.
export function getDb() {
  if (!_cached) {
    _cached = getDatabase();
  }
  return _cached;
}

// Test-only teardown: closes the cached pool and clears the cache so a
// `node --test` process doesn't hang for ~10s on an open pg.Pool handle at
// exit. Product code (serverless function invocations) never calls this —
// the pool is meant to live for the lifetime of the process there.
export async function closeDbForTests() {
  if (_cached) {
    await _cached.pool.end();
    _cached = null;
  }
}
