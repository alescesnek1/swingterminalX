# Price-history analytics (local, admin-only)

`/api/admin-price-history-signals` is a read-only admin diagnostic over stored
`market_price_points`. It calls pure reclaim and absorption helpers; it does
not write data, score RADAR, change `ENTRY_READY`, trade, or alert.

## Collector: `/api/admin-price-history-collect`

Admin-only, POST-only. Disabled by default behind
`PRICE_HISTORY_COLLECT_ENABLED=true`:

- Flag absent/false: no fetch, no DB — returns
  `{ ok:true, collected:false, skipped:true, reason:'COLLECT_DISABLED' }`.
- Flag enabled: fetches same-origin `/api/markets` (static path only, no
  forwarded query string or auth header) and passes the rows to
  `writeMarketSnapshotIfEnabled` (`_price-history-writer.mjs`), which still
  requires `PRICE_HISTORY_WRITE_ENABLED=true` to actually persist.

So collect-enabled + write-disabled fetches rows but never writes; both
flags must be `true` for a DB write to happen.

## Orderbook bridge: `_orderbook-client.mjs`

The existing authenticated `/api/orderbook` route is a Deno Edge Function.
`_orderbook-client.mjs` is a pure Node wrapper that calls it same-origin with
a sanitized `pair`/`market` only (no forwarded query string), forwarding the
caller's `Authorization` header only (never cookies or other headers, never
logged).

`admin-price-history-signals` now uses this bridge as best-effort context:
on success `orderbookUsed:true` / `orderbookReason:'OK'` and the summarized
book feeds `analyzeAbsorptionFromPointsAndOrderbook`; on any failure
(unauthenticated, upstream down, invalid pair) the endpoint still returns
200 with `orderbookUsed:false` and a stable reason, falling back to a
history-only read. Orderbook values never affect RADAR gates or alerts.

## Signal availability states

`/api/admin-price-history-signals` keeps a real price-history store failure as HTTP 503 with `reason:'DB_UNAVAILABLE'`; the RADAR panel renders this as `Status: unavailable`, shows the database-environment reason, and keeps reclaim, absorption, and orderbook as `Unknown`. A valid admin read with no rows returns HTTP 200 `status:'NO_HISTORY'`; a valid read with too few points returns HTTP 200 `status:'INSUFFICIENT_HISTORY'`. Both are waiting/degraded states, not transport errors. Generic 5xx/network failures remain `FETCH_ERROR`, while malformed bodies remain `MALFORMED_RESPONSE`.
