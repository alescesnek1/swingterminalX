# Price-history analytics (local, admin-only)

`/api/admin-price-history-signals` is a read-only admin diagnostic over stored
`market_price_points`. It calls pure reclaim and absorption helpers; it does
not write data, score RADAR, change `ENTRY_READY`, trade, or alert.

The existing authenticated `/api/orderbook` route is a Deno Edge Function.
This Node diagnostic does not import it or make a second upstream request, so
normal responses honestly report `orderbookUsed:false` and
`orderbookReason:"NOT_WIRED_THIS_PHASE"`. Wiring a safe shared reader is a
later reviewed phase; orderbook values do not affect RADAR gates or alerts.
