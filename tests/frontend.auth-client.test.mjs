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
// The device-session deadline: 8h from login by default, reported by the server
// as `sessionExpiresAt` and what decides when a password is asked for again.
const SESSION_FUTURE = () => new Date(Date.now() + 8 * 3600_000).toISOString();
const STORAGE_KEY = 'swing.nativeAuth.v1';

function storedSession({ token = TOKEN, expiresAt = FUTURE(), sessionExpiresAt = SESSION_FUTURE(), confirmedAt } = {}) {
  return JSON.stringify({
    token,
    session: { userId: 'u-1', email: 'owner@example.com', role: 'admin', expiresAt, sessionExpiresAt },
    confirmedAt,
  });
}

function makeHarness({ routes = {}, storage = {}, supabase = null, toast = null } = {}) {
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
    // Only installed when a test cares: the client must work whether or not the
    // toast module loaded, so most tests leave it undefined on purpose.
    ...(toast ? { Toast: toast } : {}),
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
      sessionExpiresAt: SESSION_FUTURE(),
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

// ── the end of a native session must be VISIBLE ──
//
// terminal.js applies the signed-out UI only for `mode === 'native'`
// (Supabase transitions arrive through onAuthStateChange instead). Emitting the
// already-nulled mode meant a native session that ended mid-use left the
// terminal looking signed in while every request came back 401 — the exact
// failure the owner reported as "AI analysis says 401 but I look logged in".
test('a 401 refresh announces the end WITH the native mode', async () => {
  const { AuthClient } = makeHarness({
    routes: { [REFRESH]: { status: 401, body: { ok: false, reason: 'TOKEN_VERSION_STALE' } } },
    storage: {
      'swing.nativeAuth.v1': JSON.stringify({
        token: TOKEN,
        session: { userId: 'u-1', email: 'owner@example.com', role: 'admin', expiresAt: FUTURE() },
      }),
    },
  });
  const events = [];
  AuthClient.onChange((session, mode) => events.push({ signedIn: Boolean(session), mode }));

  await AuthClient.init();

  const ended = events.filter((e) => !e.signedIn);
  assert.ok(ended.length > 0, 'the end of the session must be announced');
  assert.ok(
    ended.some((e) => e.mode === 'native'),
    'the listener must be told the NATIVE session ended, or terminal.js keeps the app open with a dead token',
  );
});

test('an expired stored session is announced with the native mode on restore', async () => {
  const { AuthClient } = makeHarness({
    storage: {
      'swing.nativeAuth.v1': JSON.stringify({
        token: TOKEN,
        session: { userId: 'u-1', email: 'owner@example.com', role: 'admin', expiresAt: PAST() },
      }),
    },
  });
  const events = [];
  AuthClient.onChange((session, mode) => events.push({ signedIn: Boolean(session), mode }));

  await AuthClient.init();

  assert.deepEqual(events, [{ signedIn: false, mode: 'native' }]);
  assert.equal(AuthClient.mode(), null, 'and the mode itself is cleared');
});


// ── device sessions: one password per device per 8 hours ──
// The user-visible contract. A page refresh must never ask for a password
// inside the window; the window ending must be a clean, visible sign-out; and
// none of it may cost a database round trip it does not need.

test('a reload with an EXPIRED token inside a live session refreshes silently', async () => {
  // The case that used to bounce the user to the login gate: the tab was closed
  // for over an hour, so the access token lapsed, but the 8h window is open.
  const { AuthClient, fetchCalls } = makeHarness({
    routes: { [REFRESH]: loginOk({ token: 'rotated.token.value' }) },
    storage: { [STORAGE_KEY]: storedSession({ expiresAt: PAST() }) },
  });

  const mode = await AuthClient.init();
  assert.equal(mode, 'native', 'no password may be asked for inside the window');
  assert.equal(await AuthClient.getAccessToken(), 'rotated.token.value');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, REFRESH);
});

test('a reload past the 8h deadline signs out WITHOUT a request', async () => {
  const { AuthClient, fetchCalls, store } = makeHarness({
    routes: { [REFRESH]: loginOk() },
    storage: { [STORAGE_KEY]: storedSession({ sessionExpiresAt: PAST() }) },
  });

  const mode = await AuthClient.init();
  assert.equal(mode, null);
  assert.equal(fetchCalls.length, 0, 'the server would only refuse — do not wake the database to be told so');
  assert.equal(store.size, 0, 'and the dead session must not be left in storage');
});

test('a recently confirmed token opens the app without waking the database', async () => {
  // Netlify bills database compute per hour AWAKE, and /api/auth-refresh reads
  // Postgres. Re-confirming on every single reload buys no new information.
  const { AuthClient, fetchCalls } = makeHarness({
    routes: { [REFRESH]: loginOk() },
    storage: { [STORAGE_KEY]: storedSession({ confirmedAt: Date.now() - 60_000 }) },
  });

  const seen = [];
  AuthClient.onChange((session, mode) => seen.push({ session, mode }));

  const mode = await AuthClient.init();
  assert.equal(mode, 'native');
  assert.equal(fetchCalls.length, 0, 'no refresh call for a token confirmed a minute ago');
  assert.equal(await AuthClient.getAccessToken(), TOKEN);
  assert.equal(seen.length, 1, 'the app must still be told to open');
  assert.equal(seen[0].mode, 'native');
  assert.equal(seen[0].session.email, 'owner@example.com');
});

test('a stale confirmation still re-checks with the server', async () => {
  // Revocation stays real: past the confirm window, a reload asks again, so a
  // disabled account cannot keep the terminal open indefinitely.
  const { AuthClient, fetchCalls } = makeHarness({
    routes: { [REFRESH]: { status: 401, body: { ok: false, reason: 'ACCOUNT_DISABLED' } } },
    storage: { [STORAGE_KEY]: storedSession({ confirmedAt: Date.now() - 30 * 60_000 }) },
  });

  const mode = await AuthClient.init();
  assert.equal(fetchCalls.length, 1, 'a 30-minute-old confirmation is not good enough');
  assert.equal(mode, null, 'and the disabled account is signed out');
});

test('a 401 SESSION_EXPIRED from refresh ends the session cleanly', async () => {
  const warnings = [];
  const { AuthClient, store } = makeHarness({
    routes: { [REFRESH]: { status: 401, body: { ok: false, reason: 'SESSION_EXPIRED' } } },
    storage: { [STORAGE_KEY]: storedSession({ confirmedAt: 0 }) },
    toast: { warn: (title, message) => warnings.push({ title, message }) },
  });

  await AuthClient.init();
  assert.equal(AuthClient.mode(), null);
  assert.equal(store.size, 0);
  assert.equal(warnings.length, 1, 'the user must be told why they are back at the login form');
  assert.match(warnings[0].message, /8-hour/, 'and the reason must name the real cause');
});

test('getAccessToken refuses a token whose session window has closed', async () => {
  // Handing back a dead token would produce a 401 the caller cannot explain.
  const { AuthClient, fetchCalls } = makeHarness({
    routes: { [LOGIN]: loginOk({ sessionExpiresAt: PAST() }) },
  });
  await AuthClient.signIn('owner@example.com', 'a-good-long-password');
  fetchCalls.length = 0;

  assert.equal(await AuthClient.getAccessToken(), null);
  assert.equal(AuthClient.mode(), null, 'and the app must show the login gate');
  assert.equal(fetchCalls.length, 0);
});

test('the session deadline is exposed so the UI can show it', async () => {
  const { AuthClient } = makeHarness({ routes: { [LOGIN]: loginOk() } });
  await AuthClient.signIn('owner@example.com', 'a-good-long-password');
  assert.ok(AuthClient.session().sessionExpiresAt, 'sessionExpiresAt must reach the UI layer');
});

test('a server with no device sessions yet is not treated as expired', async () => {
  // Backwards compatibility: an older deploy answers without sessionExpiresAt.
  // That must mean "unknown", never "already over" — otherwise a rollback would
  // lock everyone out.
  const { AuthClient } = makeHarness({
    routes: { [LOGIN]: loginOk({ sessionExpiresAt: undefined }) },
  });
  await AuthClient.signIn('owner@example.com', 'a-good-long-password');
  assert.equal(AuthClient.mode(), 'native');
  assert.equal(await AuthClient.getAccessToken(), TOKEN);
  assert.equal(AuthClient.session().sessionExpiresAt, null);
});

test('the last stretch of a session sleeps to the deadline instead of refreshing', async () => {
  // A replacement token cannot outlive `sxp`, so refreshing in the final hour
  // would produce a shrinking series of calls — each one a Postgres wake-up —
  // for tokens that all expire together.
  const { AuthClient, timers, fetchCalls } = makeHarness({
    routes: { [LOGIN]: loginOk({ sessionExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }) },
  });
  await AuthClient.signIn('owner@example.com', 'a-good-long-password');

  assert.equal(fetchCalls.length, 1, 'only the login call');
  const last = timers[timers.length - 1];
  assert.ok(last, 'a wake-up must still be scheduled');
  assert.ok(last.delay > 9 * 60_000, `expected a wake-up at the deadline, got ${last.delay}ms`);

  // And that wake-up ends the session rather than calling the server.
  const { AuthClient: expired } = makeHarness({
    routes: { [LOGIN]: loginOk({ sessionExpiresAt: PAST() }) },
  });
  await expired.signIn('owner@example.com', 'a-good-long-password');
  assert.equal(expired.mode(), null, 'a session already past its deadline must not open the app');
});
