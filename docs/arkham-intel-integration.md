# Arkham Intel integration — research + design (DISABLED SKELETON)

Status: **disabled-by-default skeleton committed locally. Not enabled, not deployed,
no API key requested, no env var set.** Nothing in this document authorises turning
the feature on; the "Before enabling" checklist at the end is the gate for that.

Purpose: add an **advisory on-chain intelligence layer** for coin analysis — entity
labels, holder concentration, exchange in/outflows, whale transfers, counterparties,
risk context — without creating a second credit drain and without ever becoming a
trading signal.

---

## 1. Non-negotiable boundary

Arkham data is **context a human reads**. It is never an input to a gate.

Nothing in this feature may affect, or be read by:

RADAR evaluation · `ENTRY_READY` · strict Absorb · Reclaim · Telegram · alerts ·
trading / order paths · Scanner ranking · Scanner Lead Score · default sorting ·
RADAR/Value valuation · the gate checklist · live execution.

This is enforced, not just asserted: `tests/arkham.safety.test.mjs` walks
`netlify/functions`, `scripts`, `apps/edge/netlify/edge-functions`,
`apps/edge/public/js` and `apps/ingest` and fails if any file outside the three
Arkham-owned files mentions Arkham at all, and separately fails if any named
gate/alert/publisher module references it.

Per the Arkham API Terms (§4), the data is explicitly not investment advice — which
matches how it is presented here.

---

## 2. Research findings (public sources, August 2026)

### 2.1 Access model — request/trial-based, not self-serve

Arkham describes two paths: complete the short form at
[`arkm.com/api`](https://arkm.com/api) and the team returns **either trial access or
a tailored proposal**, or contact the team directly for a custom use case. The
marketing page's call to action is "Start free trial". So: **not self-serve** — you
cannot swipe a card and get a key. Once approved, keys are created in the API
Dashboard (`arkm.com/api-dashboard`) or under account settings → API / Developer,
with a default limit of **5 keys per account**.

Source: [Getting access guide](https://arkm.com/llms/guides/getting-access.md),
[arkm.com/api](https://arkm.com/api).

### 2.2 Pricing — partially public

There **is** a public price anchor, so the "pricing not found" wording does not
apply in full: the access guide states subscriptions are **usage-based (credits per
month) and start at $100**, with custom plans, bespoke arrangements and
pay-as-you-go also offered.

What is **not** public: any per-tier price table, the $/credit rate, and the cost of
the Risk Scoring add-on. The dedicated credit-pricing guide contains **no USD
figures at all** — it quantifies everything in monthly credit allowances only.

> Exact per-tier and per-credit pricing not found in public docs; requires Arkham
> API access request / commercial contact (`api@arkm.com`).

Sources: [Getting access](https://arkm.com/llms/guides/getting-access.md),
[Credit pricing](https://arkm.com/llms/guides/credit-pricing.md).

### 2.3 Credit model — this is the cost risk

Two billing shapes, and the second is the dangerous one:

| Shape | Behaviour |
| --- | --- |
| **Per-call** | Fixed cost regardless of data volume. `/intelligence/address/{address}` = 1 credit. |
| **Per-row** | *Total credits = rows returned × the endpoint's credit value.* |

Documented allowances and representative costs:

| Item | Value |
| --- | --- |
| Individual trial | 1,000,000 credits/month |
| Organization trial | 10,000,000 credits/month |
| Paid subscriptions | Unlimited credits (rate limits still apply) |
| Intelligence endpoints | 1–1,000 credits (single → batch) |
| Transfers / swaps | 1–4 per call, or 1–2 **per row** |
| Token endpoints | 1–30 per call |
| Risk scoring (paid add-on) | 5–20 credits per call |
| WebSocket v2 | stream creation free; **2 credits per transfer delivered** |
| Failed requests (4xx/5xx) | **not charged** |

Two facts drive the whole design below:

1. **Per-row billing means an unbounded query is an unbounded bill.** A transfers
   query with a loose filter can return thousands of rows.
2. **WebSocket bills per delivered transfer** — an idle-looking stream on a busy
   token is a meter running unattended. Hence: no WebSocket in this skeleton, and
   none without a separate approval.

Source: [Credit pricing](https://arkm.com/llms/guides/credit-pricing.md).

### 2.4 Rate limits

| Limit | Value |
| --- | --- |
| Standard endpoints | 100 requests/second (small burst allowance) |
| **Heavy** endpoints | **1 request/second** |
| Over limit | HTTP 429 + `Retry-After` header, rejected immediately |
| Label lookups — trial | 10,000 per period |
| Label lookups — individual | 1,000,000 per period |
| Label lookups — organization | 10,000,000 per period **per seat** |
| Usage headers | `X-Intel-Datapoints-Usage` / `-Limit` / `-Remaining` |
| Usage endpoint | `GET /subscription/intel-usage` |

"Heavy" explicitly includes **transfers, swaps, token data, intelligence search,
counterparty lookups, flow analytics, and batch intelligence** — i.e. almost
everything this feature would want. 1 req/s is a hard architectural constraint: it
rules out any fan-out over a coin list.

Arkham recommends exponential backoff **with jitter**. This skeleton takes the
stricter line and does **no retry at all** — on a metered API a retry storm is a
cost incident, not resilience. Backoff can be added later, deliberately, with the
credit guard in front of it.

Source: [Rate limits](https://arkm.com/llms/guides/rate-limits.md).

### 2.5 Authentication

Base URL `https://api.arkm.com`. Auth is a plain request header:

```
API-Key: <YOUR_API_KEY>
```

The key is shown once at creation and cannot be retrieved again. Arkham recommends
separate keys per environment and per service, and rotation by create → deploy →
verify → revoke.

Source: [API keys & authentication](https://arkm.com/llms/guides/api-keys-authentication.md).

### 2.6 Endpoint categories (from the published OpenAPI index)

Full list at [`arkm.com/llms.txt`](https://arkm.com/llms.txt) /
[`arkm.com/openapi.json`](https://arkm.com/openapi.json). The parts relevant to coin
analysis:

| Need | Endpoints |
| --- | --- |
| **Token / entity lookup** | `GET /intelligence/token/{id}`, `GET /intelligence/token/{chain}/{address}`, `GET /intelligence/entity/{entity}`, `GET /intelligence/entity/{entity}/summary`, `GET /intelligence/search`, `GET /intelligence/contract/{chain}/{address}` |
| **Top holders / concentration** | `GET /token/holders/{id}`, `GET /token/holders/{chain}/{address}` |
| **Transfers / whale moves** | `GET /transfers`, `GET /transfers/histogram`, `GET /transfers/tx/{hash}`, `GET /tx/{hash}` |
| **Exchange in/outflows, token flow** | `GET /flow/entity/{entity}`, `GET /flow/address/{address}`, `GET /token/top_flow/{id}`, `GET /token/volume/{id}`, `GET /volume/entity/{entity}` |
| **Counterparties** | `GET /counterparties/entity/{entity}`, `GET /counterparties/address/{address}` |
| **Portfolio / balances** | `GET /portfolio/entity/{entity}`, `GET /portfolio/address/{address}`, `GET /portfolio/timeSeries/entity/{entity}`, `GET /balances/entity/{entity}`, `GET /balances/address/{address}` |
| **Labels / entities / tags** | `GET /intelligence/entity_types`, `GET /intelligence/entities/updates`, `GET /intelligence/tags/updates`, `GET /intelligence/address_tags/updates`, `GET /tag/{id}/summary`, `GET /tag/{id}/params`, `GET /intelligence/entity_predictions/{entity}`, `GET /cluster/{id}/summary` |
| **Risk score** | `GET /risk/address/{address}`, `GET /risk/address/{address}/paths`, `GET /risk/entity/{entity_id}`, `POST /risk/address/batch`, `POST /risk/entity/batch` |
| **WebSocket streams** | v2: `GET/POST /ws/v2/streams`, `DELETE /ws/v2/streams/{id}`, `GET /ws/v2/transfers` (v1 `/ws/*` is deprecated) |
| **Market / other** | `GET /token/top`, `GET /token/trending`, `GET /token/market/{id}`, `GET /token/price/history/{id}`, `GET /marketdata/altcoin_index`, `GET /swaps`, `GET /loans/entity/{entity}`, `GET /hypercore/*` (Hyperliquid perps), `GET /polymarket/*` |
| **Own usage / accounting** | `GET /subscription/intel-usage`, `GET /analytics/credit-periods`, `GET /analytics/endpoint-calls` |

`GET /transfers` query surface: `base, chains, flow, from, to, tokens, usdGte,
usdLte, valueGte, valueLte, limit, offset, sortKey, sortDir, timeGte, timeLte,
timeLast`. `usdGte` + `limit` + `timeLast` are the three parameters that keep a
per-row bill bounded, and **all three must always be set**.

`GET /intelligence/search` query surface: `query, arkhamEntities, arkhamAddresses,
userEntities, tokens, pools`.

### 2.7 Risk scoring — a separate paid add-on

Scores 0–100 across 12 risk categories; the overall level is the **highest**
category, banded `NONE 0–9 / LOW 10–39 / MEDIUM 40–59 / HIGH 60–79 / SEVERE 80–100`.
It is an **optional paid add-on**, not part of a standard tier — a Custom
subscription or a trial evaluation is required, and a trial gets **10,000 risk
scores total** across all risk endpoints, after which the API returns 429.

Design consequence: risk data must be treated as **possibly unavailable at any
time** and render as `UNKNOWN`, never as a clean "no risk" (which is exactly the
`catch { return 0 }` failure mode `AGENTS.md` forbids).

Source: [Risk scoring (beta)](https://arkm.com/llms/guides/risk-scoring-beta.md).

### 2.8 Data model — entities, labels, tags

- **Address** — one on-chain location (wallet or contract).
- **Entity** — a set of addresses attributed to one real-world actor (Binance,
  BlackRock, Uniswap). "Entities are the *who*. Addresses are the *where*."
- **Label** — identity metadata, in two confidence classes: **Arkham Verified**
  (≥98% confidence) and **Entity Predictions** (≥80% confidence).
- **Tag** — qualitative descriptor: `Fund`, `BTC Whale`, `OFAC Sanctioned`,
  `Hacker`, and similar.

So the "smart money / fund / market maker" style labels the request asked about are
supported **as entity types and tags**, not as a single ready-made "smart money"
score. `GET /intelligence/entity_types` enumerates the available types, and
`GET /tag/{id}/summary` describes a tag — both should be read once during
integration rather than hard-coded from guesswork.

**The verified/predicted split must reach the UI.** A ≥80%-confidence *prediction*
rendered identically to a ≥98% *verified* label would be the same class of dishonesty
as showing a stale verdict as current. `labelConfidence` exists in the panel shape
for exactly this.

Source: [Addresses, entities & labels](https://arkm.com/llms/guides/addresses-entities-labels.md).

### 2.9 API Terms — the real constraints

From the [Arkham API Terms of Service](https://arkm.com/api-terms-of-service):

| Question asked | What the terms say |
| --- | --- |
| **May responses be cached?** | Caching is **not explicitly addressed**. §8.2 limits use to "requesting and receiving Company Data" for internal business purposes. A short-lived server-side cache that only serves the same authenticated operator is consistent with that; a public cache would not be. |
| **May responses be displayed to users?** | The licence is **internal business purposes** only. Terminal-X is a single-owner terminal behind verified auth, which is the internal case. It would **not** cover showing Arkham data to third parties or subscribers. |
| **Redistribution / resale** | Prohibited. §2.2: no right to "grant a sublicense, sell, resell, transfer, distribute or otherwise make available to any third-parties". §8.2: no disclosure to any third party without prior written consent. |
| **May entity labels be shown in our UI?** | Yes for internal display under the above licence — no attribution requirement appears in the document. **Not** for any onward publication (public dashboard, Telegram broadcast, shared artifact, screenshot posted publicly). |
| **Attribution** | **No attribution requirement found** in the terms. Attribution is added below anyway, because a reader must know which source a claim came from. |
| **Commercial use** | Internal business purposes only. §3.4(f) prohibits use to develop or enhance a **competing** product or service. |
| **Investment advice** | §4: the Services and content "is not intended to and does not provide tax, legal, insurance or investment advice"; a reference to an investment is not a recommendation. |
| **Scraping / abuse** | §3.4(g) prohibits "data mining, robots, scraping, or similar data gathering" and "overloading the Services with API requests". |
| **Overage** | §5.3 covers usage limits and overage billing. |

**Compliance consequences, applied in this skeleton:**

1. **No Telegram, no broadcast, no public artifact carrying Arkham data.** That
   would be third-party distribution under §2.2/§8.2. This reinforces the
   advisory-only boundary for a second, independent reason.
2. **Auth-gated only.** `/api/arkham-token-intel` requires a cryptographically
   verified identity, so no anonymous caller can reach Arkham-derived data.
3. **Cache is a cost/latency control, not a redistribution mechanism** — server-side,
   short-lived, single-tenant, never a public CDN cache (`Cache-Control: no-store`
   on the route).
4. **Attribution in the UI** — the panel is titled "Arkham Intel" and carries a
   "not investment advice" line.
5. **No scraping.** Only the documented REST API with a key. `intel.arkm.com`
   HTML/undocumented endpoints and the various "unofficial Arkham API" community
   wrappers are **out of bounds** — using them would breach §3.4(g).

> These are read from public terms as an engineering input, not a legal opinion. The
> owner should confirm the display/caching reading with Arkham (`api@arkm.com`) when
> requesting access — it is a one-line question on the access form.

---

## 3. Identifier requirements and the Terminal-X mapping problem

### 3.1 What Arkham needs

| Lookup | Minimum identifier |
| --- | --- |
| `/intelligence/token/{id}`, `/token/holders/{id}`, `/token/top_flow/{id}`, `/token/market/{id}` | **CoinGecko pricing ID** (`solana`, `wrapped-bitcoin`) — the docs say so verbatim: *"Get intelligence on a token by CoinGecko pricing ID"* |
| `/intelligence/token/{chain}/{address}`, `/token/holders/{chain}/{address}` | **chain slug + contract address** |
| `/intelligence/entity/{entity}`, `/counterparties/entity/{entity}`, `/flow/entity/{entity}`, `/portfolio/entity/{entity}` | **Arkham entity id** |
| `/risk/address/{address}` | address |
| `/intelligence/search` | free-text `query` — the resolver of last resort |

A **bare ticker is never a valid identifier.** Nothing in the API accepts `SOL`.
Exchange symbols (`SOLUSDT`) are not Arkham inputs at all.

### 3.2 Can Terminal-X map its coins to Arkham tokens today? Partly — and the gap matters

`/api/markets` rows already carry an `id` field
([`markets.js:581`](../apps/edge/netlify/edge-functions/markets.js)):

```js
id: String(cg.id || sym.toLowerCase()),
```

**That field is a real CoinGecko id only when the row came from CoinGecko.** Two
synthesis paths fabricate it from the ticker instead:

- `_makeBinanceSpotRow` — `id: sym.toLowerCase()` for a Binance spot pair with no
  CoinGecko match (tagged `BIN`, `market_cap: 0`).
- the Binance-only fallback stub — `id: base.toLowerCase()`.

So `row.id` is **not trustworthy** as an Arkham identifier. Sending
`arbitrarytoken` to `/intelligence/token/{id}` either 404s (cost: nothing, Arkham
does not bill 4xx) or — the real hazard — **collides with an unrelated CoinGecko
slug and returns intelligence about the wrong token.** Silently showing another
token's holder concentration next to a trade setup is precisely the class of
dishonesty `AGENTS.md` forbids.

**Therefore the skeleton refuses to guess.** `resolveArkhamTokenIdentity()` ranks
identity as `coingecko_id` (strong) → `chain_contract` (strong) → `symbol` (weak,
flagged), and the endpoint answers `IDENTITY_UNRESOLVED` — a named status, never
"no data" — when no strong identifier is supplied.

Three ways to close the gap, in preference order:

1. **Provenance flag on the row (best, cheap, no new upstream call).** `markets.js`
   already knows whether `id` came from `cg.id` or was synthesized. Emitting an
   explicit `coingecko_id_verified: true|false` (or reusing the existing `exchange`
   badge + `market_cap === 0` heuristic, which is weaker) lets the client pass a
   trustworthy id and omit it otherwise. **This is a change to `markets.js` and is
   deliberately out of scope for this commit.**
2. **Owner-curated allowlist** for the coins actually traded — a small
   `symbol → coingecko id` map reviewed by hand. Zero API cost, zero ambiguity, and
   sufficient for a terminal that works one focused coin at a time.
3. **`GET /intelligence/search`** as a resolver. Correct but it is a *heavy*
   (1 req/s) endpoint, costs credits, and returns candidates that still need
   disambiguation — so it is a fallback, cached hard by symbol, never the default.

`GET /token/addresses/{id}` is also worth reading once during integration: it maps a
CoinGecko id to its per-chain contract addresses, which would let the terminal build
a durable `symbol → {chain, contract}` table and stop depending on slug matching.

---

## 4. Implemented architecture (what is in this commit)

```
apps/edge/public/js/terminal.js         disabled placeholder panel + ONE manual button
                │  (no fetch on render, no interval, no auto-refresh)
                ▼
GET /api/arkham-token-intel?symbol=…    netlify/functions/arkham-token-intel.mjs
                │  auth → validate → DISABLED/NOT_CONFIGURED/COST_CAPPED → (maybe) fetch
                ▼
netlify/functions/_arkham-client.mjs    host allowlist · header auth · timeout ·
                │                       credit guard · redaction · no retry
                ▼
        https://api.arkm.com            NEVER REACHED while ARKHAM_ENABLED !== 'true'
```

### 4.1 Guard ladder in the endpoint (the order *is* the safety argument)

| # | Guard | Result |
| --- | --- | --- |
| 1 | Method | GET/OPTIONS only, else 405 |
| 2 | **Auth** | verified identity required (same bar as `/api/cockpit-radar-state`), else 401. A disabled feature must not become a config probe for anonymous callers. |
| 3 | **Request validation** | symbol must match `^[A-Z0-9]{2,32}$`; a comma/space list is `ARKHAM_TOO_MANY_SYMBOLS`; a *present-but-invalid* `coingeckoId`/`chain`/`contract` is a 400, never a silent downgrade. Runs **before** the enable check so a cache key can never be derived from unvalidated input. |
| 4 | **Enable / key / cap** | `DISABLED` → `NOT_CONFIGURED` → `COST_CAPPED`, all **HTTP 200**, all with **no external call**. A missing key is a config gap, not a 500, and the message names the env var without echoing a value. |
| 5 | Identity strength | no confirmed CoinGecko id → `IDENTITY_UNRESOLVED`, no call made |
| 6 | Upstream | one call, one coin, bounded by timeout, no retry, credit-metered |

Every response carries `ARKHAM_ADVISORY_CONTRACT`: `advisoryOnly: true`,
`affectsTrading: false`, an `affects` map that names each gate as `false`, and the
"not investment advice" disclaimer.

### 4.2 Failure semantics

| Situation | Reported as |
| --- | --- |
| Feature off | `status: DISABLED` (200) — a real answer, not an error |
| Enabled, no key | `status: NOT_CONFIGURED` (200) — never a 500, never a secret |
| Cap 0 | `status: COST_CAPPED` (200) |
| No strong id | `status: IDENTITY_UNRESOLVED` (200) |
| Upstream 401/403 | `ARKHAM_AUTH_REJECTED` |
| Upstream 404 | `ARKHAM_NOT_FOUND` |
| Upstream 429 | `ARKHAM_RATE_LIMITED` |
| Other non-2xx | `ARKHAM_HTTP_<status>` |
| Timeout | `ARKHAM_TIMEOUT` |
| Thrown fetch | `ARKHAM_FETCH_FAILED` |
| Unusable body | `ARKHAM_INVALID_RESPONSE` |

Raw upstream bodies are never read into a response. `scrubSecret()` is applied to
any message that could conceivably have captured the key, so a leak requires two
independent mistakes. Every failure is `console.warn`-logged with a stable code and
rendered visibly in the panel — a failed read is never shown as "no on-chain
activity".

Missing figures stay `null` → rendered `UNKNOWN`. Netflow is only computed when
**both** inflow and outflow are present, because a one-sided read would render as a
directional claim the data does not support. Nulls are rejected *before* `Number()`,
so a missing value can never become a real `0`.

---

## 5. Cache model

| Property | Value | Why |
| --- | --- | --- |
| TTL | **24h default**, 6h floor, 168h ceiling (`ARKHAM_CACHE_TTL_HOURS`) | On-chain entity structure — holders, labels, counterparties — moves on a scale of days. Nothing here is a live tape. |
| Key | `arkham:v1:cg:<coingecko-id>` → `arkham:v1:chain:<chain>:<address>` → `arkham:v1:sym:<SYMBOL>` | Keyed on **stable token identity**, symbol only as the last resort and flagged weak |
| Key derivation | normalized values **only** | A hostile symbol can neither poison a neighbouring key nor smuggle characters into a store path; a value that does not normalize yields `null` and the request is refused |
| Scope | server-side, single-tenant | Terms §2.2/§8.2: never a public/CDN cache. Route sends `Cache-Control: no-store`. |
| Version prefix | `v1` | A shape change bumps the prefix instead of serving a stale schema |
| Backing store | **not implemented** — reported as `store: "none_yet"` | Netlify Blobs is the intended home (same pattern as the fleet blob), but a cache that is not wired must say so rather than implying a hit |
| Warming | **none** | No full-market polling, no top-N sweep, no prefetch. Manual/on-demand only. |

Later, top-N enrichment is permitted **only** with: an explicit credit cap, a
durable spend counter, `N` bounded and logged, and the 1 req/s heavy-endpoint limit
respected — i.e. a top-20 refresh takes ≥20 seconds by construction, which is itself
a useful brake.

---

## 6. Cost guards

| Env var | Default | Effect |
| --- | --- | --- |
| `ARKHAM_ENABLED` | *(unset → false)* | Only the exact string `"true"` enables. `1`, `TRUE`, `yes` do not. |
| `ARKHAM_API_KEY` | *(unset)* | Read from `process.env` only. Never logged, never returned, never in a URL. |
| `ARKHAM_DAILY_CREDIT_CAP` | `0` | `0` = nothing may be spent. Hard max 5000. |
| `ARKHAM_CACHE_TTL_HOURS` | `24` | Bounded 6–168 |
| `ARKHAM_MAX_SYMBOLS_PER_REQUEST` | `1` | Hard max 5. A batch request is refused, not truncated. |
| `ARKHAM_REQUEST_TIMEOUT_MS` | `8000` | Bounded 1000–20000 |

Structural guards, on top of the flags:

- **No scheduler, no cron, no background collector.** No `config.schedule`, no
  GitHub Actions workflow, no `setInterval`. Test-enforced.
- **No WebSocket.** It bills 2 credits per delivered transfer — an unattended meter.
  Requires separate approval.
- **No retry, no backoff loop.** Test-enforced.
- **Single-host allowlist** (`api.arkm.com`, HTTPS only), enforced before any fetch.
- **Path allowlist** — only `/intelligence/token` is constructible today, and each
  allowed path carries its credit cost next to it, so a new call cannot be added
  without stating what it costs.
- **Never called from Scanner refresh or RADAR evaluation.**

### Known limitation of the credit guard — read this before enabling

`createArkhamCreditGuard()` counts spend **per warm function instance per UTC day**.
Serverless runs many instances, so the real global ceiling is
`cap × instances`. That is acceptable *only* while the cap is `0`.

**Before Arkham may be enabled in production, the guard must be replaced with a
durable counter** — a single Netlify Blobs key holding `{ day, creditsSpent }`,
read-modify-written per call, with the request refused when the write fails
(fail-closed). Do not enable Arkham on the strength of the in-memory guard.

---

## 7. UI — now and later

### 7.1 Now (in this commit)

An "Arkham Intel" card in the Cockpit RADAR focus panel, next to the existing
server-verdict block. It:

- paints a **static placeholder** and never fetches on render;
- says exactly: *"Arkham Intel disabled — on-chain entity intelligence can be
  enabled after API access and cost caps are configured."*;
- shows the future field structure with every value `UNKNOWN`, so the shape is
  reviewable before a single credit is spent;
- offers **one** button — "Check Arkham Intel status" — which performs a **single**
  on-demand request. No polling, no auto-refresh, no retry;
- carries the advisory line: *"Advisory only — does not affect ENTRY_READY, RADAR,
  strict Absorb, Reclaim, Telegram, alerts, Scanner ranking, or any order path. Not
  investment advice."*;
- logs every failure to the console **and** `window.ErrorLog`, and renders a failed
  read as a failed read.

It is **not** in the Scanner table, and it touches no Lead Score, no valuation, no
gate checklist, and no sort.

### 7.2 Later (design, not built)

Panel sections, in reading order:

1. **Entity summary** — primary labelled entity, entity type/tags (fund, CEX, market
   maker, whale), and the **Verified (≥98%) vs Predicted (≥80%) confidence class**,
   which must be visually distinct.
   `/intelligence/token/{id}`, `/intelligence/entity/{entity}/summary`
2. **Holder concentration** — top-10 / top-N share, holder count, labelled vs
   unlabelled split. `/token/holders/{id}`
3. **Exchange netflow** — inflow / outflow / net over an explicit window, with the
   **window length always on screen**. Computed only when both sides are present.
   `/flow/entity/{entity}`, `/token/top_flow/{id}`
4. **Whale transfers** — recent large moves above a `usdGte` floor, with
   from/to labels. **Always** `usdGte` + `limit` + `timeLast` (per-row billing).
   `/transfers`
5. **Top counterparties** — who this entity trades with.
   `/counterparties/entity/{entity}`
6. **Risk flags** — level + score + triggered categories, `UNKNOWN` when the add-on
   is unavailable (never a clean "no risk"). `/risk/entity/{entity_id}`
7. **Token flow summary** — net direction over the window, as a *description*, never
   a score. `/token/volume/{id}`, `/token/top_flow/{id}`
8. **Last updated** — upstream read time + cache age, so staleness is stated.
9. **Missing data** — which sections could not be read, named individually.
10. **Advisory footer** — the disclaimer above, always visible.

Explicitly **not** planned: any numeric "Arkham score" folded into Lead Score,
valuation, or a gate; any Arkham field in a Telegram message; any Arkham column in
the Scanner table's default view.

---

## 8. Files

| File | Role |
| --- | --- |
| `docs/arkham-intel-integration.md` | this document |
| `netlify/functions/_arkham-client.mjs` | pure adapter: config, status ladder, normalization, cache key, URL/host allowlist, credit guard, bounded fetch, redaction, presenter |
| `netlify/functions/arkham-token-intel.mjs` | `/api/arkham-token-intel` — auth-gated, disabled-by-default read |
| `apps/edge/public/js/terminal.js` | disabled placeholder panel + one manual status button |
| `apps/edge/public/css/terminal.css` | card tint + the manual button (4 rules) |
| `apps/edge/public/index.html` | cache-bust token `6l2 → 6l3` only |
| `tests/arkham.client.test.mjs` | adapter guards (23 tests) |
| `tests/arkham.token-intel-endpoint.test.mjs` | endpoint guards (18 tests) |
| `tests/arkham.safety.test.mjs` | containment: no gate module may reference Arkham; no scheduler; no WebSocket |
| `tests/frontend.arkham-intel-panel.test.mjs` | the placeholder renders, never auto-fetches, and cannot break coin detail |

No new package dependency (built-in `fetch`). No migration. No `netlify.toml`
change — the route is declared by `export const config = { path: … }`, matching
`cockpit-radar-state.mjs`.

---

## 9. Before enabling (owner checklist — none of this has been done)

1. Request access at [`arkm.com/api`](https://arkm.com/api); ask on the form whether
   internal display + short-lived server-side caching for a single-operator
   terminal is in scope, and get the answer in writing.
2. Get real pricing (`api@arkm.com`) — the public docs stop at "usage-based, starts
   at $100". Decide a monthly credit ceiling **before** any key exists.
3. Create a dedicated key (name it for this service). Store it in Netlify env only.
   Never in the repo, a doc, a log, or chat.
4. **Replace the in-memory credit guard with the durable Netlify Blobs counter**
   (§6). This is the blocking item.
5. Wire the cache to Netlify Blobs and flip `store: "none_yet"` to the real store.
6. Fix the identity gap (§3.2, option 1 or 2) so lookups use a *verified* CoinGecko
   id. Until then the feature answers `IDENTITY_UNRESOLVED` for most coins — which
   is the correct, honest behaviour, not a bug.
7. Re-verify `presentArkhamTokenIntel()` against a real trial response. It is a
   shape contract today, not a proven parser; the upstream response schema for
   `/intelligence/token/{id}` is not fully public.
8. Enable in this order, verifying at each step: `ARKHAM_API_KEY` →
   `ARKHAM_ENABLED=true` (cap still 0, expect `COST_CAPPED`) → raise
   `ARKHAM_DAILY_CREDIT_CAP` to a small number → watch
   `GET /subscription/intel-usage` and `/analytics/endpoint-calls`.
9. Keep it out of Telegram, out of any public artifact, and out of every gate —
   permanently, for both safety and licence reasons.

## Sources

- [Arkham API docs](https://arkm.com/api/docs) · [`llms.txt` endpoint index](https://arkm.com/llms.txt) · [`openapi.json`](https://arkm.com/openapi.json)
- [Blockchain Data API (product page)](https://arkm.com/api)
- [Getting access](https://arkm.com/llms/guides/getting-access.md)
- [API keys & authentication](https://arkm.com/llms/guides/api-keys-authentication.md)
- [Rate limits](https://arkm.com/llms/guides/rate-limits.md)
- [Credit pricing](https://arkm.com/llms/guides/credit-pricing.md)
- [Addresses, entities & labels](https://arkm.com/llms/guides/addresses-entities-labels.md)
- [Risk scoring (beta)](https://arkm.com/llms/guides/risk-scoring-beta.md)
- [Arkham API Terms of Service](https://arkm.com/api-terms-of-service)
