# Native auth — own-database accounts

Moving login off Supabase and into the Netlify/Neon database, so the owner can
add and manage users directly.

**Status: backend complete and tested, disabled by default. The browser still
signs in through Supabase — the terminal UI switch is the remaining piece.**
Nothing in this document is active until the env flags below are set.

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

Each step is separately reversible. **Do not skip step 4** — it is what prevents
locking yourself out.

1. **Apply the migration.**
   ```bash
   npm run db:migrate:apply
   ```
   Creates the two tables. Changes no behaviour: nothing reads them yet.

2. **Set `AUTH_JWT_SECRET` in Netlify** (≥ 32 chars, same value for functions and
   edge). Leave `NATIVE_AUTH_ENABLED` unset. Still no behaviour change.

3. **Create the accounts while still signed in through Supabase.** This is what
   avoids the chicken-and-egg problem: `/api/admin-users` authorizes off
   `BOT_ADMIN_EMAILS`, which is auth-source-agnostic, so your existing Supabase
   session can create the first native accounts. No bootstrap secret exists,
   deliberately.

   Create your own account **first**, and copy the generated password
   immediately — it is shown exactly once and is never stored in plaintext,
   logged, or written to the audit table.

4. **Verify a native login works BEFORE enabling anything.** With
   `NATIVE_AUTH_ENABLED` still unset, `/api/auth-login` returns
   `503 NATIVE_AUTH_DISABLED` — that is the expected answer and confirms the
   endpoint is deployed and gated. Confirm the account exists in the admin list.

5. **Set `NATIVE_AUTH_ENABLED=true`.** Both token kinds are now accepted, so your
   Supabase session keeps working. Sign in with the native credentials in a
   private window and confirm the terminal loads.

6. **Only then** consider removing the Supabase path. Until that step both
   sources work, and reverting is `NATIVE_AUTH_ENABLED=false` plus a redeploy.

To roll back at any point: unset `NATIVE_AUTH_ENABLED`. Native tokens are
immediately refused again and Supabase is untouched.

---

## Still to do

- **The browser UI.** `terminal.js` still signs in via
  `supabaseCl.auth.signInWithPassword` and builds its `Authorization` header from
  `sb.auth.getSession()`. Switching it needs: a login form that posts to
  `/api/auth-login`, token storage, a background call to `/api/auth-refresh`
  before expiry, a forced password change when `mustChangePassword` is true, and
  the admin users panel.
- **A "change my own password" endpoint.** Today only an admin can reset a
  password, so `mustChangePassword` cannot yet be satisfied by the user.
- **Tier for native users.** `getTier()` resolves a native non-admin to `free`,
  exactly as it does a Supabase user with no tier metadata. `app_users` has no
  tier column — a product decision, not an oversight.
- Removing the hardcoded Supabase anon key fallback in `terminal.js`
  (`_FALLBACK_SUPABASE`) once the browser no longer needs Supabase at all.
