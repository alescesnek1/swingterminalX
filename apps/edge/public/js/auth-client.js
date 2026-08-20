// ─────────────────────────────────────────────────────────────
// Swing Terminal — client auth façade (native accounts + Supabase)
//
// One place that answers "who is signed in and what token do I send",
// so the rest of the app never has to know which identity source is
// active. Loaded as a classic <script> before terminal.js.
//
// SELF-CONFIGURING, on purpose. There is no build-time or env-driven
// switch in the browser: signIn() posts to /api/auth-login, and if that
// answers 503 NATIVE_AUTH_DISABLED it transparently falls back to
// Supabase. So this same file works before AND after the server flag is
// flipped, and flipping it back does not require a frontend change. A
// config flag here would be a second source of truth that could disagree
// with the server.
//
// TOKEN STORAGE: localStorage, matching what the Supabase SDK already
// does in this app — so this is not a new exposure. The tradeoff is
// explicit: an XSS on this origin can read the token either way, and the
// mitigation that actually matters is the short token lifetime (60 min)
// plus refresh being database-checked. A native token is removed from
// storage the moment the server says it is invalid.
//
// DEVICE SESSIONS (why a reload does not ask for a password):
// login opens a session with an ABSOLUTE deadline the server puts in the
// token (`sxp`, 8h by default) and reports as `sessionExpiresAt`. Inside
// that window this client silently re-mints the short access token —
// including after a reload where the stored token has ALREADY expired,
// which /api/auth-refresh accepts precisely for this case. Once the
// deadline passes, the session is dropped locally with no request and the
// login gate comes back. So: one password per device per 8 hours, and
// never a password on an ordinary page refresh.
//
// API (window.AuthClient):
//   await AuthClient.init()                  → restore + verify a stored session
//   await AuthClient.signIn(email, password) → { ok, mode, mustChangePassword, reason }
//   await AuthClient.signOut()
//   await AuthClient.getAccessToken()        → string | null
//   await AuthClient.changePassword(cur,new) → { ok, reason }
//   AuthClient.mode()                        → 'native' | 'supabase' | null
//   AuthClient.session()                     → { email, userId, role, expiresAt } | null
//   AuthClient.onChange(fn)                  → fn(session|null, mode)
// ─────────────────────────────────────────────────────────────

(function () {
  const STORAGE_KEY = 'swing.nativeAuth.v1';
  // Refresh at 75% of the token's life: early enough that a failed attempt can
  // be retried before expiry, late enough not to hammer the endpoint.
  const REFRESH_AT_FRACTION = 0.75;
  // A refresh can legitimately fail with 503 (database briefly unreachable).
  // That must NOT sign the user out, so we retry on this interval while the
  // current token is still valid.
  const REFRESH_RETRY_MS = 60 * 1000;
  // On page load a stored token that is still comfortably valid is adopted
  // WITHOUT calling /api/auth-refresh, as long as the server confirmed it this
  // recently. Reason: that endpoint reads Postgres, and Netlify bills database
  // compute per hour AWAKE — confirming on every single reload wakes the
  // database over and over for no new information.
  //
  // This does not loosen revocation beyond what the design already accepts: a
  // running tab only re-confirms at 75% of a 60-minute token (≈45 min), so a
  // 15-minute confirm window is strictly TIGHTER than the existing worst case.
  // A disabled account or changed password still lands within one token TTL.
  const CONFIRM_MIN_INTERVAL_MS = 15 * 60 * 1000;

  let _mode = null;          // 'native' | 'supabase' | null
  let _session = null;       // native session descriptor
  let _token = null;         // native access token
  let _confirmedAt = 0;      // ms epoch of the last server confirmation
  let _refreshTimer = null;
  const _listeners = [];

  function log(message, meta) {
    console.warn(`[AUTH] ${message}`, meta || {});
  }

  function report(title, reason, extra) {
    // Route through the central error log so an auth failure is visible in
    // errors() with its reason, like every other failure in the app.
    if (window.ErrorLog) {
      window.ErrorLog.record({
        level: 'error', kind: 'auth', title, reason, endpoint: '/api/auth', ...(extra || {}),
      });
    } else {
      log(`${title}: ${reason}`);
    }
  }

  // ── storage ──
  function persist() {
    if (!window.localStorage) return;
    try {
      if (_token && _session) {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ token: _token, session: _session, confirmedAt: _confirmedAt }),
        );
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch (err) {
      // Storage full or blocked. The session still works in memory for this tab,
      // but it will not survive a reload — worth knowing, not worth blocking.
      log('could not persist the session', { name: err && err.name });
    }
  }

  function restore() {
    if (!window.localStorage) return null;
    let raw;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      log('could not read the stored session', { name: err && err.name });
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.token === 'string' && parsed.session) return parsed;
      return null;
    } catch (err) {
      log('stored session was not valid JSON; discarding', { name: err && err.name });
      try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { void e; }
      return null;
    }
  }

  function clearNative(reason) {
    const had = Boolean(_token);
    // The mode is nulled below, but listeners must still be told WHICH source
    // just ended. terminal.js only applies the signed-out UI for `mode ===
    // 'native'`, so emitting the already-nulled mode meant a session that ended
    // mid-use (expired token, disabled account, rotated secret) left the app
    // looking signed in while every request came back 401 — the failure was
    // invisible exactly where the user was looking.
    const endedMode = _mode === 'native' ? 'native' : _mode;
    _token = null;
    _session = null;
    _confirmedAt = 0;
    if (_mode === 'native') _mode = null;
    stopRefreshTimer();
    persist();
    if (had) {
      log('native session cleared', { reason: reason || 'unspecified' });
      emit(endedMode);
    }
  }

  function emit(modeOverride) {
    const mode = modeOverride === undefined ? _mode : modeOverride;
    for (const fn of _listeners) {
      try {
        fn(_session, mode);
      } catch (err) {
        // A broken listener must not take the auth state machine down with it.
        log('an onChange listener threw', { name: err && err.name });
      }
    }
  }

  // ── native token lifecycle ──
  function expiresInMs() {
    if (!_session || !_session.expiresAt) return 0;
    const at = Date.parse(_session.expiresAt);
    if (!Number.isFinite(at)) return 0;
    return at - Date.now();
  }

  /**
   * Milliseconds left in the DEVICE SESSION (the absolute 8h deadline), or null
   * when the server did not report one — a legacy token from before device
   * sessions existed. Null must never be read as "expired" or as "unlimited":
   * callers below branch on it explicitly.
   */
  function sessionRemainingMs() {
    if (!_session || !_session.sessionExpiresAt) return null;
    const at = Date.parse(_session.sessionExpiresAt);
    if (!Number.isFinite(at)) return null;
    return at - Date.now();
  }

  function sessionEnded() {
    const remaining = sessionRemainingMs();
    return remaining !== null && remaining <= 0;
  }

  function stopRefreshTimer() {
    if (_refreshTimer) {
      clearTimeout(_refreshTimer);
      _refreshTimer = null;
    }
  }

  function scheduleRefresh() {
    stopRefreshTimer();
    if (!_token) return;

    if (sessionEnded()) {
      endSessionLocally();
      return;
    }

    const remaining = expiresInMs();
    if (remaining <= 0) {
      // Expired access token, but the device session may still be open — in that
      // case refresh CAN re-mint it, so try instead of signing out.
      if (sessionRemainingMs() > 0) {
        _refreshTimer = setTimeout(onRefreshTimer, 5000);
        return;
      }
      clearNative('token already expired');
      return;
    }

    // When the session ends before the token does, a refresh buys nothing: the
    // replacement token cannot outlive `sxp` either. So sleep until the deadline
    // and end the session locally instead of spending a shrinking series of
    // refreshes — each one a Postgres wake-up — on tokens that all expire
    // together. This is also what makes the app show the login gate the moment
    // the window closes rather than on the next failed request.
    const sessionLeft = sessionRemainingMs();
    if (sessionLeft !== null && sessionLeft <= remaining) {
      _refreshTimer = setTimeout(onRefreshTimer, Math.max(1000, sessionLeft));
      return;
    }

    // Never schedule further out than 75% of what is left, and never sooner
    // than 5s (which would spin if the clock is skewed).
    const delay = Math.max(5000, Math.floor(remaining * REFRESH_AT_FRACTION));
    _refreshTimer = setTimeout(onRefreshTimer, delay);
  }

  // Single timer entry point: decide at FIRE time whether this wake-up is a
  // refresh or the end of the device session. Deciding here (not when the timer
  // was set) is what makes a suspended laptop behave correctly.
  function onRefreshTimer() {
    if (sessionEnded()) {
      endSessionLocally();
      return;
    }
    runRefresh();
  }

  // The 8h deadline passed. No request is made: the server would refuse it, and
  // the point of the local check is to avoid both the round trip and a spurious
  // "database unreachable" story on the way out.
  function endSessionLocally() {
    report('Session ended', 'SESSION_EXPIRED');
    if (window.Toast) {
      window.Toast.warn('Signed out', reasonToMessage('SESSION_EXPIRED'), { endpoint: '/api/auth-refresh' });
    }
    clearNative('device session reached its 8h deadline');
  }

  // One place that turns a login/refresh/change-password body into the session
  // descriptor, so a field added on the server cannot be picked up by one path
  // and missed by another.
  function sessionFromBody(body) {
    return {
      userId: body.user && body.user.id,
      email: body.user && body.user.email,
      role: body.user && body.user.role,
      mustChangePassword: body.mustChangePassword === true,
      expiresAt: body.expiresAt,
      // Absent from a server that predates device sessions: stored as null so
      // sessionRemainingMs() reports "unknown" rather than "already over".
      sessionExpiresAt: typeof body.sessionExpiresAt === 'string' ? body.sessionExpiresAt : null,
    };
  }

  async function runRefresh() {
    if (!_token) return;
    // Cheap guard: never spend a request (and a database wake-up) on a session
    // that has already passed its deadline.
    if (sessionEnded()) {
      endSessionLocally();
      return;
    }
    let res;
    try {
      res = await fetch('/api/auth-refresh', {
        method: 'POST',
        headers: { Authorization: `Bearer ${_token}`, Accept: 'application/json' },
      });
    } catch (err) {
      // Network failure. Keep the current token and try again — the fetch
      // interceptor in error-log.js has already recorded the failure.
      log('refresh request failed; keeping the current token', { name: err && err.name });
      _refreshTimer = setTimeout(onRefreshTimer, REFRESH_RETRY_MS);
      return;
    }

    const body = await res.json().catch(() => ({}));

    if (res.ok && body.token) {
      _token = body.token;
      _session = sessionFromBody(body);
      _confirmedAt = Date.now();
      persist();
      scheduleRefresh();
      emit();
      return;
    }

    if (res.status === 503) {
      // Server-side/transient: the token we hold is still valid, so stay signed
      // in and retry. Signing out here would log the user out over a blip.
      log('refresh temporarily unavailable; keeping the current token', { reason: body.reason || res.status });
      _refreshTimer = setTimeout(onRefreshTimer, REFRESH_RETRY_MS);
      return;
    }

    // 401 and anything else: the session is genuinely over (expired, account
    // disabled, password reset, secret rotated). Sign out visibly.
    report('Session ended', body.reason || `HTTP ${res.status}`);
    if (window.Toast) {
      window.Toast.warn('Signed out', reasonToMessage(body.reason), { endpoint: '/api/auth-refresh', code: res.status });
    }
    clearNative(body.reason || `HTTP ${res.status}`);
  }

  function reasonToMessage(reason) {
    switch (reason) {
      case 'SESSION_EXPIRED': return 'This device session reached its 8-hour limit. Please sign in again.';
      case 'ACCOUNT_DISABLED': return 'This account has been disabled.';
      case 'TOKEN_VERSION_STALE': return 'Your password was changed, so this session ended.';
      case 'ACCOUNT_NOT_FOUND': return 'This account no longer exists.';
      case 'TOKEN_EXPIRED': return 'Your session expired. Please sign in again.';
      default: return 'Please sign in again.';
    }
  }

  function adoptNativeSession(body) {
    _token = body.token;
    _mode = 'native';
    _session = sessionFromBody(body);
    _confirmedAt = Date.now();
    persist();
    scheduleRefresh();
    emit();
  }

  // ── Supabase delegation ──
  // Read lazily every time: terminal.js creates the client asynchronously after
  // /api/config resolves, so capturing it once at load would capture null.
  function supabase() {
    return window.__supabase || null;
  }

  async function supabaseToken() {
    const sb = supabase();
    if (!sb) return null;
    try {
      const { data } = await sb.auth.getSession();
      return (data && data.session && data.session.access_token) || null;
    } catch (err) {
      report('Could not read the Supabase session', (err && err.message) || 'unknown');
      return null;
    }
  }

  // ── public API ──

  /**
   * Restore a stored native session, if any, and confirm it is still valid.
   * Returns the active mode. Safe to call more than once.
   */
  async function init() {
    const stored = restore();
    if (!stored) return _mode;

    _token = stored.token;
    _session = stored.session;
    _confirmedAt = Number.isFinite(stored.confirmedAt) ? stored.confirmedAt : 0;
    _mode = 'native';

    // 1. The 8h device session is over. Local decision, no request: the server
    //    would only refuse, and asking would wake the database to be told so.
    if (sessionEnded()) {
      clearNative('stored device session had reached its deadline');
      return null;
    }

    const sessionLeft = sessionRemainingMs();

    // 2. The access token lapsed while the tab was closed. Inside a live device
    //    session this is the ORDINARY case — a reload after lunch — and
    //    /api/auth-refresh re-mints it without a password. Only a token from
    //    before device sessions existed (no deadline reported) is dropped here,
    //    because refresh will not extend it.
    if (expiresInMs() <= 0) {
      if (sessionLeft === null) {
        clearNative('stored token had expired');
        return null;
      }
      await runRefresh();
      return _mode;
    }

    // 3. The token is still valid AND the server confirmed it recently enough.
    //    Adopt it as-is: the app opens instantly and Postgres stays asleep. The
    //    scheduled refresh still re-confirms within one token lifetime, so
    //    revocation is not weakened past what the design already accepts.
    if (Date.now() - _confirmedAt < CONFIRM_MIN_INTERVAL_MS) {
      scheduleRefresh();
      emit();
      return _mode;
    }

    // 4. Valid but not confirmed recently: confirm with the server. This is what
    //    catches an account disabled while the tab was closed.
    await runRefresh();
    return _mode;
  }

  async function signIn(email, password) {
    let res;
    try {
      res = await fetch('/api/auth-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch (err) {
      return { ok: false, reason: 'NETWORK', message: (err && err.message) || 'Network error' };
    }

    const body = await res.json().catch(() => ({}));

    if (res.ok && body.token) {
      adoptNativeSession(body);
      return { ok: true, mode: 'native', mustChangePassword: body.mustChangePassword === true };
    }

    // The server has not been switched over yet — use Supabase, transparently.
    if (res.status === 503 && body.reason === 'NATIVE_AUTH_DISABLED') {
      const sb = supabase();
      if (!sb) {
        return { ok: false, reason: 'NO_AUTH_SOURCE', message: 'Neither native login nor Supabase is available.' };
      }
      try {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) return { ok: false, reason: 'SUPABASE_REJECTED', message: error.message || 'Invalid email or password.' };
        _mode = 'supabase';
        return { ok: true, mode: 'supabase', mustChangePassword: false };
      } catch (err) {
        return { ok: false, reason: 'SUPABASE_ERROR', message: (err && err.message) || 'Network or auth error' };
      }
    }

    // A misconfigured server (missing/short secret) must not read as a bad
    // password — the owner would hunt the wrong problem.
    if (res.status === 503) {
      report('Login unavailable', body.reason || 'server not ready');
      return { ok: false, reason: body.reason || 'UNAVAILABLE', message: body.error || 'Login is temporarily unavailable.' };
    }

    return { ok: false, reason: body.reason || `HTTP ${res.status}`, message: body.error || 'Invalid email or password.' };
  }

  async function signOut() {
    // There is no server-side session to destroy (tokens are stateless), so
    // signing out is local: drop the token and let it expire on its own.
    clearNative('user signed out');
    const sb = supabase();
    if (sb) {
      try {
        await sb.auth.signOut();
      } catch (err) {
        report('Supabase sign-out failed', (err && err.message) || 'unknown');
      }
    }
    _mode = null;
    emit();
  }

  async function getAccessToken() {
    if (_mode === 'native') {
      if (!_token) return null;
      if (sessionEnded()) {
        // The 8h deadline passed. Returning the dead token would produce a 401
        // the caller cannot explain; ending the session here makes the reason
        // visible where the user is looking.
        endSessionLocally();
        return null;
      }
      if (expiresInMs() <= 0) {
        // Expired between scheduled refreshes (e.g. laptop was asleep). Try once
        // now so a request does not fail for a recoverable reason — inside a live
        // device session this succeeds without a password.
        await runRefresh();
        return _token;
      }
      return _token;
    }
    return await supabaseToken();
  }

  async function changePassword(currentPassword, newPassword) {
    if (_mode !== 'native') {
      return { ok: false, reason: 'NOT_A_NATIVE_SESSION', message: 'This session has no native password to change.' };
    }
    let res;
    try {
      res = await fetch('/api/auth-change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${_token}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    } catch (err) {
      return { ok: false, reason: 'NETWORK', message: (err && err.message) || 'Network error' };
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      return { ok: false, reason: body.reason || `HTTP ${res.status}`, message: body.error || 'Could not change the password.' };
    }

    if (body.token) {
      // The change bumped token_version, so adopt the replacement token or the
      // next refresh would sign the user out.
      adoptNativeSession(body);
    } else {
      // Password changed but no token was issued — the user must sign in again.
      clearNative('password changed, no replacement token');
    }
    return { ok: true, reSignInRequired: !body.token, message: body.notice || 'Password changed.' };
  }

  window.AuthClient = {
    init,
    signIn,
    signOut,
    getAccessToken,
    changePassword,
    mode: () => _mode,
    session: () => (_session ? { ..._session } : null),
    // Set by terminal.js once Supabase reports a session, so `mode()` is
    // accurate for a Supabase-authenticated user too.
    noteSupabaseSession: (active) => {
      if (active && _mode !== 'native') _mode = 'supabase';
      else if (!active && _mode === 'supabase') _mode = null;
    },
    onChange: (fn) => { if (typeof fn === 'function') _listeners.push(fn); },
    // Test seam only — never called by app code.
    _reset: () => { clearNative('test reset'); _mode = null; _listeners.length = 0; },
  };
})();
