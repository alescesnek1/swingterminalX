// Tests for the browser auth façade (apps/edge/public/js/auth-client.js).
//
// The behaviours that matter operationally:
//   • the SAME login form works before and after the server flag flips
//     (503 NATIVE_AUTH_DISABLED → transparent Supabase fallback)
//   • a 503 on refresh must NOT sign a healthy user out
//   • a 401 on refresh MUST sign them out and clear the stored token
//   • a disabled account discovered on restore does not let the app open
//   • no token is left in storage once the server has rejected it
//
// auth-client.js is a classic <script> IIFE, so it is executed against a mock
// window rather than imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../apps/edge/public/js/auth-client.js', import.meta.url), 'utf8');

const TOKEN = 'header.payload.signature';
const FUTURE = () => new Date(Date.now() + 3600_000).toISOString();
const PAST = () => new Date(Date.now() - 1000).toISOString();

function makeHarness({ routes = {}, storage = {}, supabase = null } = {}) {
  const store = new Map(Object.entries(storage));
  const fetchCalls = [];
  const timers = [];

  const win = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    __supabase: supabase,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      const route = routes[url];
      if (!route) throw new TypeError(`no route for ${url}`);
      const spec = typeof route === 'function' ? route(fetchCalls.length) : route;
      if (spec instanceof Error) throw spec;
      return {
        ok: spec.status >= 200 && spec.status < 300,
        status: spec.status,
        json: async () => spec.body ?? {},
      };
    },
  };

  const noopConsole = { log() {}, warn() {}, error() {} };
  // Capture scheduled refreshes instead of letting them fire, so tests stay
  // deterministic and the process does not hang on a pending timer.
  const setTimeoutStub = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  const clearTimeoutStub = () => {};

  new Function('window', 'console', 'setTimeout', 'clearTimeout', 'fetch', source)(
    win, noopConsole, setTimeoutStub, clearTimeoutStub, win.fetch,
  );

  return { win, store, fetchCalls, timers, AuthClient: win.AuthClient };
}

const LOGIN = '/api/auth-login';
const REFRESH = '/api/auth-refresh';
const CHANGE = '/api/auth-change-password';

function loginOk(over = {}) {
  return {
    status: 200,
    body: {
      ok: true,
      token: TOKEN,
      expiresAt: FUTURE(),
      expiresInSeconds: 3600,
      mustChangePassword: false,
      user: { id: 'u-1', email: 'owner@example.com', role: 'admin' },
      ...over,
    },
  };
}

test('the façade is installed with the documented API', () => {
  const { AuthClient } = makeHarness();
  for (const fn of ['init', 'signIn', 'signOut', 'getAccessToken', 'changePassword', 'mode', 'session', 'onChange']) {
    assert.equal(typeof AuthClient[fn], 'function', `AuthClient.${fn}() must exist`);
  }
});

// ── native sign-in ──

test('a native sign-in stores the token and reports native mode', async () => {
  const { AuthClient, store } = makeHarness({ routes: { [LOGIN]: loginOk() } });
  const result = await AuthClient.signIn('owner@example.com', 'a-good-long-password');

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'native');
  assert.equal(AuthClient.mode(), 'native');
  assert.equal(AuthClient.session().email, 'owner@example.com');
  assert.equal(await AuthClient.getAccessToken(), TOKEN);
  assert.ok(store.get('swing.nativeAuth.v1')?.includes(TOKEN), 'the token must survive a reload');
});

test('mustChangePassword is surfaced to the caller', async () => {
  const { AuthClient } = makeHarness({ routes: { [LOGIN]: loginOk({ mustChangePassword: true }) } });
  const result = await AuthClient.signIn('owner@example.com', 'pw');
  assert.equal(result.mustChangePassword, true);
});

test('a rejected native login reports the reason and stores nothing', async () => {
  const { AuthClient, store } = makeHarness({
    routes: { [LOGIN]: { status: 401, body: { ok: false, reason: 'INVALID_CREDENTIALS', error: 'Invalid email or password.' } } },
  });
  const result = await AuthClient.signIn('owner@example.com', 'wrong');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INVALID_CREDENTIALS');
  assert.equal(AuthClient.mode(), null);
  assert.equal(store.size, 0, 'a failed login must not persist anything');
});

// ── the cutover: the same form works both sides of the flag ──

test('503 NATIVE_AUTH_DISABLED falls back to Supabase transparently', async () => {
  let supabaseCalled = false;
  const supabase = {
    auth: {
      signInWithPassword: async () => { supabaseCalled = true; return { error: null }; },
      getSession: async () => ({ data: { session: { access_token: 'sb-token' } } }),
    },
  };
  const { AuthClient } = makeHarness({
    routes: { [LOGIN]: { status: 503, body: { ok: false, reason: 'NATIVE_AUTH_DISABLED' } } },
    supabase,
  });

  const result = await AuthClient.signIn('owner@example.com', 'pw');
  assert.equal(result.ok, true, 'login must still succeed before the cutover');
  assert.equal(result.mode, 'supabase');
  assert.equal(supabaseCalled, true);
  assert.equal(await AuthClient.getAccessToken(), 'sb-token', 'and the Supabase token must be what gets sent');
});

test('a Supabase rejection during fallback is reported, not swallowed', async () => {
  const supabase = {
    auth: {
      signInWithPassword: async () => ({ error: { message: 'Invalid login credentials' } }),
      getSession: async () => ({ data: { session: null } }),
    },
  };
  const { AuthClient } = makeHarness({
    routes: { [LOGIN]: { status: 503, body: { ok: false, reason: 'NATIVE_AUTH_DISABLED' } } },
    supabase,
  });
  const result = await AuthClient.signIn('owner@example.com', 'pw');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'SUPABASE_REJECTED');
  assert.match(result.message, /Invalid login credentials/);
});

test('a misconfigured server is NOT reported as a bad password', async () => {
  // Otherwise the owner hunts a password problem that does not exist.
  const { AuthClient } = makeHarness({
    routes: { [LOGIN]: { status: 503, body: { ok: false, reason: 'AUTH_JWT_SECRET_TOO_SHORT', error: 'Login is misconfigured on the server.' } } },
  });
  const result = await AuthClient.signIn('owner@example.com', 'pw');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'AUTH_JWT_SECRET_TOO_SHORT');
});

test('with neither source available the failure is explicit', async () => {
  const { AuthClient } = makeHarness({
    routes: { [LOGIN]: { status: 503, body: { ok: false, reason: 'NATIVE_AUTH_DISABLED' } } },
    supabase: null,
  });
  const result = await AuthClient.signIn('owner@example.com', 'pw');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_AUTH_SOURCE');
});

test('a network failure during login is reported as NETWORK', async () => {
  const { AuthClient } = makeHarness({ routes: { [LOGIN]: new TypeError('Failed to fetch') } });
  const result = await AuthClient.signIn('owner@example.com', 'pw');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NETWORK');
});

// ── refresh behaviour ──

test('a 503 refresh keeps the session and schedules a retry', async () => {
  // The whole point: a database blip must not sign a healthy user out.
  const stored = JSON.stringify({
    token: TOKEN,
    session: { userId: 'u-1', email: 'owner@example.com', role: 'admin', expiresAt: FUTURE() },
  });
  const { AuthClient, timers } = makeHarness({
    routes: { [REFRESH]: { status: 503, body: { ok: false, reason: 'DB_UNAVAILABLE' } } },
    storage: { 'swing.nativeAuth.v1': stored },
  });

  await AuthClient.init();
  assert.equal(AuthClient.mode(), 'native', 'the user must stay signed in');
  assert.equal(await AuthClient.getAccessToken(), TOKEN);
  assert.ok(timers.length > 0, 'a retry must be scheduled');
});

test('a 401 refresh signs the user out and clears storage', async () => {
  const stored = JSON.stringify({
    token: TOKEN,
    session: { userId: 'u-1', email: 'owner@example.com', role: 'admin', expiresAt: FUTURE() },
  });
  const { AuthClient, store } = makeHarness({
    routes: { [REFRESH]: { status: 401, body: { ok: false, reason: 'ACCOUNT_DISABLED' } } },
    storage: { 'swing.nativeAuth.v1': stored },
  });

  await AuthClient.init();
  assert.equal(AuthClient.mode(), null, 'a disabled account must not stay signed in');
  assert.equal(await AuthClient.getAccessToken(), null);
  assert.equal(store.size, 0, 'the rejected token must not be left in storage');
});

test('a successful refresh adopts the NEW token', async () => {
  const stored = JSON.stringify({
    token: TOKEN,
    session: { userId: 'u-1', email: 'owner@example.com', role: 'admin', expiresAt: FUTURE() },
  });
  const { AuthClient } = makeHarness({
    routes: { [REFRESH]: loginOk({ token: 'rotated.token.value' }) },
    storage: { 'swing.nativeAuth.v1': stored },
  });

  await AuthClient.init();
  assert.equal(await AuthClient.getAccessToken(), 'rotated.token.value');
});

test('an expired stored token is discarded without even calling refresh', async () => {
  const stored = JSON.stringify({
    token: TOKEN,
    session: { userId: 'u-1', email: 'owner@example.com', expiresAt: PAST() },
  });
  const { AuthClient, fetchCalls, store } = makeHarness({
    routes: { [REFRESH]: loginOk() },
    storage: { 'swing.nativeAuth.v1': stored },
  });

  const mode = await AuthClient.init();
  assert.equal(mode, null);
  assert.equal(fetchCalls.length, 0, 'no point asking the server about a token we know is dead');
  assert.equal(store.size, 0);
});

test('corrupt stored session data is discarded, not fatal', async () => {
  const { AuthClient } = makeHarness({ storage: { 'swing.nativeAuth.v1': '{not json' } });
  const mode = await AuthClient.init();
  assert.equal(mode, null);
});

test('init with no stored session is a no-op', async () => {
  const { AuthClient, fetchCalls } = makeHarness();
  assert.equal(await AuthClient.init(), null);
  assert.equal(fetchCalls.length, 0);
});

// ── change password ──

test('changing the password adopts the replacement token', async () => {
  const { AuthClient } = makeHarness({
    routes: {
      [LOGIN]: loginOk(),
      [CHANGE]: { status: 200, body: { ok: true, passwordChanged: true, token: 'fresh.token.value', expiresAt: FUTURE(), user: { id: 'u-1', email: 'owner@example.com', role: 'admin' }, mustChangePassword: false } },
    },
  });
  await AuthClient.signIn('owner@example.com', 'old-password-long');

  const result = await AuthClient.changePassword('old-password-long', 'new-password-long');
  assert.equal(result.ok, true);
  assert.equal(result.reSignInRequired, false);
  assert.equal(await AuthClient.getAccessToken(), 'fresh.token.value', 'or the next refresh would sign the user out');
});

test('a password change with no replacement token requires re-sign-in', async () => {
  const { AuthClient, store } = makeHarness({
    routes: {
      [LOGIN]: loginOk(),
      [CHANGE]: { status: 200, body: { ok: true, passwordChanged: true, token: null, reason: 'AUTH_JWT_SECRET_MISSING' } },
    },
  });
  await AuthClient.signIn('owner@example.com', 'old-password-long');

  const result = await AuthClient.changePassword('old-password-long', 'new-password-long');
  assert.equal(result.ok, true);
  assert.equal(result.reSignInRequired, true);
  assert.equal(store.size, 0, 'the stale token must not linger');
});

test('a rejected password change reports the reason and keeps the session', async () => {
  const { AuthClient } = makeHarness({
    routes: {
      [LOGIN]: loginOk(),
      [CHANGE]: { status: 401, body: { ok: false, reason: 'CURRENT_PASSWORD_INCORRECT', error: 'The current password is not correct.' } },
    },
  });
  await AuthClient.signIn('owner@example.com', 'pw');

  const result = await AuthClient.changePassword('wrong', 'new-password-long');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CURRENT_PASSWORD_INCORRECT');
  assert.equal(AuthClient.mode(), 'native', 'a failed change must not sign the user out');
});

test('changePassword refuses on a Supabase session', async () => {
  const supabase = {
    auth: {
      signInWithPassword: async () => ({ error: null }),
      getSession: async () => ({ data: { session: { access_token: 'sb' } } }),
    },
  };
  const { AuthClient } = makeHarness({
    routes: { [LOGIN]: { status: 503, body: { ok: false, reason: 'NATIVE_AUTH_DISABLED' } } },
    supabase,
  });
  await AuthClient.signIn('owner@example.com', 'pw');

  const result = await AuthClient.changePassword('a', 'b-long-enough-password');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NOT_A_NATIVE_SESSION');
});

// ── sign out ──

test('signing out clears the native token and calls Supabase too', async () => {
  let supabaseSignedOut = false;
  const supabase = {
    auth: {
      signOut: async () => { supabaseSignedOut = true; },
      getSession: async () => ({ data: { session: null } }),
    },
  };
  const { AuthClient, store } = makeHarness({ routes: { [LOGIN]: loginOk() }, supabase });
  await AuthClient.signIn('owner@example.com', 'pw');

  await AuthClient.signOut();
  assert.equal(AuthClient.mode(), null);
  assert.equal(await AuthClient.getAccessToken(), null);
  assert.equal(store.size, 0);
  assert.equal(supabaseSignedOut, true, 'both sources must be cleared');
});

// ── onChange ──

test('onChange fires for sign-in and sign-out', async () => {
  const { AuthClient } = makeHarness({ routes: { [LOGIN]: loginOk() } });
  const events = [];
  AuthClient.onChange((session, mode) => events.push({ signedIn: Boolean(session), mode }));

  await AuthClient.signIn('owner@example.com', 'pw');
  await AuthClient.signOut();

  assert.ok(events.some((e) => e.signedIn && e.mode === 'native'), 'a sign-in must be announced');
  assert.ok(events.some((e) => !e.signedIn), 'a sign-out must be announced');
});

test('a throwing onChange listener does not break the state machine', async () => {
  const { AuthClient } = makeHarness({ routes: { [LOGIN]: loginOk() } });
  AuthClient.onChange(() => { throw new Error('listener bug'); });

  const result = await AuthClient.signIn('owner@example.com', 'pw');
  assert.equal(result.ok, true);
  assert.equal(AuthClient.mode(), 'native');
});
