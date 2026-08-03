# Native auth — own-database accounts

Moving login off Supabase and into the Netlify/Neon database, so the owner can
add and manage users directly.

**Status: LIVE in production as of 2026-07-28.** Both identity sources are
accepted: existing Supabase sessions keep working, and native accounts work as
soon as they exist.

- Deployed on `main` (merge `e08fd63`), site `swingterminalx`.
- `AUTH_JWT_SECRET` set for all contexts (64 chars; verified by length only, the
  value was never printed).
- `NATIVE_AUTH_ENABLED=true`, all contexts.
- All 10 DB migrations applied, 0 pending — including `20260727160000_add_app_users`.
- `BOT_ADMIN_EMAILS` was already set in production
  (`ales.cesnek@thevld.com, vld@thevld.com`); that is what the admin endpoint
  authorizes against.

Verified from production after the deploy:

| Probe | Result | What it proves |
| --- | --- | --- |
| `POST /api/auth-login`, unknown account | `401 INVALID_CREDENTIALS` | `app_users` exists and was queried (a missing table would be `503 DB_UNAVAILABLE`) |
| `GET /api/admin-users`, no token | `401` | the admin gate is on |
| `index.html` | serves `?v=6k2` + `auth-client.js`, `admin-users-panel.js` | the browser switch shipped |

**To roll back:** `npx netlify env:unset NATIVE_AUTH_ENABLED` and redeploy. Native
tokens are refused again and Supabase is untouched.

### Migrations are NOT applied by a deploy — verified the hard way

The Netlify CLI's own help text claims migration files "are automatically applied
when deploying to Netlify". **That did not happen.** After a successful
production deploy of this work, `netlify database status` still reported nine
pending migrations. They were applied by running the command explicitly:

```bash
npx netlify database migrations apply
```

That command's help text says it targets "the local database", which is also
misleading: with the site linked it applied to the same ledger that already
showed `20260720081238_init-observability-tables` as applied — i.e. the real
production database. Confirmed afterwards end to end, from production: a login
attempt for a non-existent account returned `401 INVALID_CREDENTIALS` rather than
`503 DB_UNAVAILABLE`, which is only possible if `app_users` exists and was
queried.

**So: after adding a migration, run `npx netlify database migrations apply`
yourself and check `netlify database status` shows 0 pending. Do not assume the
deploy did it.**

That batch included
`20260724190000_replace_context_snapshots_with_atomic_market_records`, which runs
six `DROP TABLE IF EXISTS` statements. It was safe here because every table it
drops is created by `20260724150000_add_market_context_revision_store`, which was
pending in the same batch, so those tables did not exist yet and the drops were
no-ops. That was a pre-existing condition of this repo, not something native auth
introduced.

---

## Why

Three reasons, in order of weight:

1. **The owner needs to add users.** Supabase accounts are managed in Supabase's
   dashboard, not in the terminal.
2. **The Deno edge called Supabase's API on every single request** just to verify
   a token (`verifyAuth` → `supabase.auth.getUser`). That is a third party in the
   latency and availability path of every authenticated read. A native token is
   verified locally with one HMAC.
3. Supabase was wired into three separate places, so nobody could answer "how
   does auth work here" from one file.

## Why passwords are not migrated

Supabase stores **bcrypt** hashes in its own `auth.users`. Node has no native
bcrypt, so importing them would mean adding a hashing dependency to a
real-money-adjacent codebase. With only a handful of users, the owner sets fresh
passwords through the admin page instead, and hashing uses Node's built-in
**scrypt**.

---

## The pieces

| File | Role |
| --- | --- |
| `netlify/database/migrations/20260727160000_add_app_users/` | `app_users` + `app_user_audit` |
| `netlify/functions/_password.mjs` | scrypt hash / verify / policy |
| `netlify/functions/_native-jwt.mjs` | mint + verify access tokens (Node) |
| `netlify/functions/_user-store.mjs` | all `app_users` reads/writes |
| `netlify/functions/auth-login.mjs` | `POST /api/auth-login` |
| `netlify/functions/auth-refresh.mjs` | `POST /api/auth-refresh` |
| `netlify/functions/admin-users.mjs` | `GET/POST /api/admin-users` |
| `apps/edge/netlify/edge-functions/lib/native-jwt.js` | the same verify, for Deno |
| `apps/edge/netlify/edge-functions/lib/security.js` | dispatches native vs Supabase |
| `netlify/functions/_auth.mjs` | dispatches native vs Supabase |

There are **two independent verifier implementations** because the edge runtime
is Deno and cannot use `node:crypto`. They must stay byte-compatible;
`tests/auth.edge-native-jwt.test.mjs` mints with the Node module and verifies
with the edge one, so a drift fails the suite instead of half the API accepting a
token the other half rejects.

---

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `NATIVE_AUTH_ENABLED` | *(off)* | Must be exactly `"true"`. Anything else (`TRUE`, `1`, `yes`) leaves native auth off — tested. |
| `AUTH_JWT_SECRET` | *(none)* | HS256 signing secret, **≥ 32 characters**. Must be identical for Node functions and the edge. |
| `ACCESS_TOKEN_TTL_SECONDS` | `3600` | Clamped to 60 … 86400. |
| `BOT_ADMIN_EMAILS` | *(existing)* | **Unchanged.** Still the only source of admin authority. |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## Authorization did not change

`app_users.role` **grants nothing.** Admin access still comes exclusively from
the `BOT_ADMIN_EMAILS` env allowlist via `_auth.mjs` `isAdmin()`, and
`/api/admin-users` additionally requires `identity.verified === true`, so
`AUTH_DECODE_ONLY` can never reach account management.

This is deliberate: letting a database column grant admin would mean anyone who
can write a row can grant themselves admin, which `AGENTS.md` forbids as relaxing
an auth gate. The `role` column is for UI labelling only.

A `role` claim inside a token the user holds is likewise ignored — tested.

---

## Revocation: the tradeoff, stated plainly

Token verification is **stateless**. No database read happens on the request hot
path, so auth keeps working when the DB is unreachable and the trading control
plane gains no new hard dependency.

The cost is that a token stays valid until it expires. So:

| Need | Mechanism | Effect |
| --- | --- | --- |
| Disable a user | Admin page → disable. Bumps `token_version`. | Their next **refresh** fails → out within one TTL (≤ 60 min). |
| Reset a password | Admin page → reset. Bumps `token_version`. | Same: existing sessions die at next refresh. |
| **Revoke everyone NOW** | Rotate `AUTH_JWT_SECRET`. | Every outstanding token stops verifying immediately. |

`/api/auth-refresh` is the one database-checked endpoint (status +
`token_version`), which is exactly what makes stateless verification acceptable
everywhere else. It returns **503, not 401**, on a DB outage — a transient blip
must not sign a healthy user out, but it still hands out no new token.

---

## Login behaviour worth knowing

**Every failed login returns the same thing.** Unknown email, wrong password,
disabled account, and locked-out account all produce a byte-identical 401
(`INVALID_CREDENTIALS`), and the unknown-email branch spends the same scrypt work
so response time reveals nothing. That is what keeps the endpoint from being an
email-enumeration oracle.

**Consequence for you:** if you are locked out, the response will not say so.
Lockout is 8 failed attempts → 15 minutes. Check the real state on the admin page
(it shows `lockedUntil` and `failedLoginCount`) or in `app_user_audit`, which
records `login_failed` / `login_locked` / `login_ok`.

**A database outage is a 503 with its reason**, never "invalid credentials" —
hiding an outage behind a login failure is exactly what `CLAUDE.md` forbids.

**A corrupt stored hash is a 500**, distinguishable from a wrong password, and
deliberately does **not** count as a failed attempt (that would lock a user out
of an account they cannot fix).

Rate limiting is **per account** (DB lockout), not per IP. A serverless function
has no shared state to count IPs with and a per-instance counter would be
bypassed by concurrency, so rather than ship something that looks like a limiter
and is not, the defense is account lockout plus the platform's own protections.

---

## Day-to-day operation

### Signing in

The login form is unchanged. It tries the native account first and falls back to
Supabase automatically, so:

- **Your existing Supabase credentials keep working**, exactly as before.
- **A native account works too**, once it exists.

Nothing to choose, and no separate login page.

### Adding a user

1. Sign in (either way) with an email that is in `BOT_ADMIN_EMAILS`.
2. Click **👤 UŽIVATELÉ** in the header — it only appears for admins.
3. Enter their email, leave the role as `user`, press **Vytvořit účet**.
4. A password appears **once**. Copy it with the button and send it to the person.
   It is not stored in readable form, not logged, and not in the audit table — if
   it is lost, do a password reset instead.
5. They sign in with that email + password and are **forced to choose their own
   password** before the terminal opens, so the admin-known password stops being
   valid.

### Resetting a forgotten password

Same panel → **Reset hesla** on the row. A new one-time password appears, and
their other sessions stop working at the next token refresh (≤ 1 hour).

### Removing access

**Zakázat** on the row. They cannot sign in again, and any live session dies at
its next refresh (≤ 1 hour). To cut every session off **immediately**, rotate the
signing secret instead:

```bash
npx netlify env:set AUTH_JWT_SECRET "$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"
```

Then redeploy. That signs everyone out, including you.

### A lockout is not shown on the login screen

8 failed attempts locks the account for 15 minutes, and the login endpoint
deliberately does **not** say so — telling the caller "this account is locked"
confirms the address exists. The panel shows the real state (`LOCKED`, plus the
failed-attempt count), and `app_user_audit` records every
`login_ok` / `login_failed` / `login_locked`.

### Roles

The `admin` option in the panel is a **label only**. Real admin rights come
exclusively from `BOT_ADMIN_EMAILS` in Netlify — to make someone an admin, add
their email there and redeploy.

---

## The browser side

`apps/edge/public/js/auth-client.js` is the façade (`window.AuthClient`), loaded
before `terminal.js`. Everything that needs a token goes through
`AuthClient.getAccessToken()`, so `_getAuthHeaders()` in `terminal.js` is
identical for both identity sources.

> **Every** module must resolve its token this way — no exceptions.
> `js/ai-analysis.js` was missed in the original cutover and read
> `window.__supabase.auth.getSession()` directly. A native-only account has no
> Supabase session, so all three AI entry points failed with a client-side
> `401` and then reloaded the page, which read as "the terminal keeps logging me
> out". Fixed 2026-08-03; guarded by
> `tests/ai.frontend-diagnostics.test.mjs`. If you add a module that calls an
> authenticated endpoint, go through `AuthClient` — reading Supabase directly is
> a bug even while Supabase is still accepted.
>
> Related: `clearNative()` announces the mode that *ended* (`'native'`), because
> `terminal.js`'s `AuthClient.onChange` handler ignores any transition whose mode
> is not `'native'`. Emitting the already-nulled mode left the app open with a
> dead token instead of showing the login gate.

**It is self-configuring, deliberately.** There is no flag in the browser:
`signIn()` posts to `/api/auth-login` and, if that answers
`503 NATIVE_AUTH_DISABLED`, falls back to Supabase transparently. So the same
build works on both sides of the cutover and reverting needs no frontend change.
A config flag in the browser would be a second source of truth that could
disagree with the server.

Token handling:

- Stored in `localStorage`, matching what the Supabase SDK already does here — so
  this is not a new exposure. The mitigation that actually matters is the short
  lifetime plus database-checked refresh, not the storage choice.
- Refreshed at 75% of the token's life. A **503** keeps the current token and
  retries; a **401** signs the user out and clears storage. That asymmetry is the
  point: a database blip must not log a healthy user out, but a genuinely revoked
  session must not linger.
- A restored session is confirmed against the server before the app opens, which
  is what catches an account disabled while the tab was closed.

`apps/edge/public/js/admin-users-panel.js` is the 👤 UŽIVATELÉ panel and the
forced-password-change dialog. It is visible only when `window.__isAdmin`, which
is a UI convenience, **not** the security boundary — unhiding it in devtools
reveals nothing, because every request still has to pass the server-side check.

## Still to do

- **Tier for native users.** `getTier()` resolves a native non-admin to `free`,
  exactly as it does a Supabase user with no tier metadata. `app_users` has no
  tier column — a product decision, not an oversight. Admin emails are `pro` via
  the hardcoded allowlist in `lib/tier.js`, so the owner is unaffected.
- **Removing Supabase entirely.** Once native auth is proven in production:
  delete the CDN `<script>` for `supabase-js`, the `_FALLBACK_SUPABASE` hardcoded
  anon key in `terminal.js`, and the Supabase branch in both verifiers. Not done
  yet on purpose — keeping both paths is what makes the cutover reversible.
- **Per-IP rate limiting** on `/api/auth-login`, if it ever becomes public-facing.
  Today the defense is per-account lockout (see above).
