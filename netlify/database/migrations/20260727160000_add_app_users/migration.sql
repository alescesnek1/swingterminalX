-- Native (own-database) user accounts, replacing Supabase as the auth source.
--
-- WHY: auth currently lives in Supabase and is wired into three separate places
-- (the browser SDK, the Deno edge `verifyAuth`, and the Node `verifyJwt`). The
-- owner wants to add and manage the handful of real users directly, and the edge
-- path currently makes a network call to Supabase on EVERY request just to
-- verify a token. Owning the accounts removes that dependency.
--
-- PASSWORDS ARE NOT MIGRATED. Supabase stores bcrypt hashes in its own
-- `auth.users`, and Node has no native bcrypt — importing them would mean a new
-- dependency in a real-money-adjacent codebase. Since there are only a few
-- users, the owner sets fresh passwords through the admin page instead. Hashes
-- here are scrypt (Node built-in) — see netlify/functions/_password.mjs for the
-- stored format.
--
-- NOTHING IN THIS MIGRATION ENABLES ANYTHING. Creating these tables does not
-- change how a single request is authenticated; the native verification path is
-- gated behind NATIVE_AUTH_ENABLED and defaults off.

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stored as entered for display; uniqueness and lookup are case-insensitive
  -- via the lower(email) index below. A separate normalized column would just be
  -- a second source of truth to keep in sync.
  email text NOT NULL,

  -- Self-describing, versioned hash string (algorithm + parameters + salt +
  -- digest). Never a bare digest: the parameters must travel WITH the hash so
  -- the cost can be raised later without invalidating existing passwords.
  password_hash text NOT NULL,

  -- 'disabled' is a full block: login refuses, and a token refresh refuses, so
  -- an already-issued token dies at its next refresh (see token TTL note below).
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),

  -- Informational / UI only, deliberately NOT an authorization source.
  -- Privileged access still comes exclusively from the BOT_ADMIN_EMAILS env
  -- allowlist (netlify/functions/_auth.mjs isAdmin). Making a DB column grant
  -- admin would widen who can grant admin, which AGENTS.md forbids as a
  -- relaxation of an auth gate.
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),

  -- Set when an admin creates the account or resets the password, so the UI can
  -- force a change on first use.
  must_change_password boolean NOT NULL DEFAULT false,

  -- Bumped on password change / disable. Carried in the token as `tv` and
  -- checked on REFRESH (not on every request — verification stays stateless so
  -- the auth hot path never depends on the database being reachable).
  token_version int NOT NULL DEFAULT 1,

  -- Brute-force resistance. `locked_until` is authoritative; the counter is
  -- what drives it.
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until timestamptz NULL,

  last_login_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: Alice@x.com and alice@x.com are one account.
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_key ON app_users (lower(email));

-- The admin page lists accounts newest-first.
CREATE INDEX IF NOT EXISTS app_users_created_idx ON app_users (created_at DESC);

-- Append-only audit of who did what to which account. Kept separate from
-- app_users so a row here survives the account being deleted, and so the audit
-- can never be silently rewritten by an UPDATE to the user row.
--
-- No password, hash, token, or IP address is ever stored here (AGENTS.md: never
-- log secrets or PII). `actor_email` and `target_email` are the operator-facing
-- record the owner needs to answer "who added this account".
CREATE TABLE IF NOT EXISTS app_user_audit (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL CHECK (action IN (
    'created', 'password_reset', 'disabled', 'enabled', 'role_changed',
    'login_ok', 'login_failed', 'login_locked', 'unlocked'
  )),
  actor_email text NULL,
  target_email text NULL,
  target_user_id uuid NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS app_user_audit_ts_idx ON app_user_audit (ts DESC);
CREATE INDEX IF NOT EXISTS app_user_audit_target_idx ON app_user_audit (target_user_id, ts DESC);
