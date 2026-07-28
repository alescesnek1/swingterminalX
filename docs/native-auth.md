# Native auth — own-database accounts

Moving login off Supabase and into the Netlify/Neon database, so the owner can
add and manage users directly.

**Status: complete and tested end to end (backend + browser), disabled by
default and NOT yet deployed.** Nothing here is active until
`NATIVE_AUTH_ENABLED` is set and the branch is deployed.

Already done, so it is not on the owner's list:

- `AUTH_JWT_SECRET` is **set in Netlify for all contexts** (64 chars). Verified by
  length only; the value was never printed.
- `BOT_ADMIN_EMAILS` was already set in the production context
  (`ales.cesnek@thevld.com, vld@thevld.com`), which is what the admin endpoint
  authorizes against.
- `NATIVE_AUTH_ENABLED` is deliberately **left unset**.

⚠️ **Read this before deploying.** Netlify applies migrations in
`netlify/database/migrations/` automatically on deploy, and only ONE of the ten
is currently applied in production (`20260720081238_init-observability-tables`).
**The next deploy therefore applies nine migrations at once**, including
`20260724190000_replace_context_snapshots_with_atomic_market_records`, which runs
six `DROP TABLE IF EXISTS` statements.

That is safe *in this specific case*: every table it drops is created by
`20260724150000_add_market_context_revision_store`, which is also pending, so on
production those tables do not exist yet and the drops are no-ops. But it is a
pre-existing condition of this repo, not something native auth introduced, and it
deserves a deliberate look rather than being discovered mid-deploy.

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

## Rollout order

Steps 1 and 2 are already done (see Status above). What remains:

1. ~~Set `AUTH_JWT_SECRET`.~~ **Done** — all contexts, 64 chars.

2. ~~Create the tables.~~ **Nothing to run.** Netlify applies migrations on
   deploy, so `app_users` and `app_user_audit` appear as part of step 3. (Read
   the migration warning in Status first.)

3. **Deploy the branch.** This is the one step that cannot be delegated —
   `AGENTS.md` requires explicit owner approval for any deploy, and a push to the
   deploy branch *is* a deploy. Nothing changes for users: with
   `NATIVE_AUTH_ENABLED` unset, the login form still authenticates through
   Supabase exactly as before, and `/api/auth-login` answers
   `503 NATIVE_AUTH_DISABLED`.

4. **Create the accounts, still signed in through Supabase.** The 👤 UŽIVATELÉ
   button appears in the header for admin emails. Create your own account
   **first** and copy the generated password immediately — it is shown exactly
   once and is never stored in plaintext, logged, or written to the audit table.

   This works before the flag is on because `/api/admin-users` authorizes off
   `BOT_ADMIN_EMAILS`, which is auth-source-agnostic. That is what avoids the
   chicken-and-egg problem, with no bootstrap secret.

5. **Set `NATIVE_AUTH_ENABLED=true` and redeploy.** Both token kinds are now
   accepted, so your Supabase session keeps working. Sign in with the native
   credentials in a private window; the terminal should force a password change
   on first use, then load normally.

6. **Only then** consider removing the Supabase path. Until that point both
   sources work.

To roll back at any point: unset `NATIVE_AUTH_ENABLED` and redeploy. Native
tokens are refused again and Supabase is untouched.

---

## The browser side

`apps/edge/public/js/auth-client.js` is the façade (`window.AuthClient`), loaded
before `terminal.js`. Everything that needs a token goes through
`AuthClient.getAccessToken()`, so `_getAuthHeaders()` in `terminal.js` is
identical for both identity sources.

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
