// ─────────────────────────────────────────────────────────────
// Swing Terminal — central client error log
//
// `CLAUDE.md` → "Error observability (non-negotiable)" requires that every
// failure be BOTH visible in the UI and logged with enough context to
// diagnose. `toast.js` already covers the visible half. This file covers the
// other half properly: it keeps a queryable HISTORY of every failure with the
// reason attached, so the owner can ask "what broke, where, and why" after the
// fact instead of hoping a toast was still on screen.
//
// Two sources feed it:
//   1. `toast.js` forwards every warn/error toast (67 existing call sites get
//      history for free, with their `endpoint` / `code` metadata intact).
//   2. A `window.fetch` interceptor installed here records EVERY non-OK
//      response and EVERY network throw — including the ones no call site
//      currently reports. This is what closes the "silently never resolved"
//      gap the order book had.
//
// CONSOLE API (type these in devtools):
//   errors()                 → table of every recorded failure, with reasons
//   errors.summary()         → counts by endpoint / level / kind
//   errors.last(10)          → the 10 most recent entries
//   errors.forEndpoint('/api/markets')
//   errors.clear()
//   errors.json()            → JSON string, for pasting into a bug report
//
// SECURITY: URLs are redacted before they are stored — the query string is
// dropped except for an explicit safe allowlist, because request URLs in this
// app can carry tokens (see AGENTS.md → never log secrets/tokens/PII). No
// response BODY is ever read or stored here: reading it would consume the
// stream the caller is about to use, and bodies can contain user data.
//
// This file must load BEFORE toast.js and terminal.js so the fetch
// interceptor is in place before the first request goes out.
// ─────────────────────────────────────────────────────────────

(function () {
  const MAX_ENTRIES = 400;
  const STORAGE_KEY = 'swing.errorLog.v1';
  // Repeated failures are the norm here: the terminal polls, so a broken
  // endpoint fails every few seconds. Identical failures inside this window
  // increment a counter on one row instead of flooding the log — otherwise the
  // console dump is 400 copies of the same line and the earlier, different
  // failure that actually explains the problem has already scrolled out.
  const DEDUPE_WINDOW_MS = 30_000;

  // Query params that are safe to keep because they are what make an entry
  // diagnosable (which symbol / which market failed). Everything else in the
  // query string is dropped — tokens are never worth the risk.
  const SAFE_QUERY_KEYS = new Set([
    'symbol', 'symbols', 'pair', 'market', 'vs_currency', 'ids', 'interval',
    'timeframe', 'limit', 'sessionId', 'coin', 'id', 'source', 'provider',
  ]);

  const entries = [];
  let seq = 0;
  let installedFetch = false;

  // Always read the clock through `window` so this file has no hidden global
  // dependency and stays exercisable from a test harness.
  function nowMs() {
    return window.performance && typeof window.performance.now === 'function'
      ? window.performance.now()
      : Date.now();
  }

  // ── URL redaction ──
  function redactUrl(raw) {
    const asString = String(raw == null ? '' : raw);
    if (!asString) return '(no url)';
    let parsed;
    try {
      parsed = new URL(asString, window.location ? window.location.href : 'http://localhost');
    } catch (err) {
      // Not a parseable URL — keep the path-ish prefix only, never the tail
      // where a query string (and therefore a token) would live.
      console.warn('[ERRORLOG] could not parse url for redaction', { name: err && err.name });
      return asString.split('?')[0].slice(0, 200);
    }
    const kept = [];
    let dropped = 0;
    parsed.searchParams.forEach((value, key) => {
      if (SAFE_QUERY_KEYS.has(key)) kept.push(`${key}=${String(value).slice(0, 40)}`);
      else dropped += 1;
    });
    const sameOrigin = window.location && parsed.origin === window.location.origin;
    let out = (sameOrigin ? '' : parsed.origin) + parsed.pathname;
    if (kept.length) out += `?${kept.join('&')}`;
    if (dropped > 0) out += `${kept.length ? '&' : '?'}…${dropped} param(s) redacted`;
    return out.slice(0, 300);
  }

  // ── persistence (bounded, best-effort) ──
  function persist() {
    if (!window.sessionStorage) return;
    try {
      // Only the tail is persisted: sessionStorage has a hard quota and a
      // reload is mainly interesting for "what failed just before this".
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-120)));
    } catch (err) {
      // Quota exceeded / storage disabled. Not worth a user-facing error, but
      // it must not be silent either: it means the log won't survive a reload.
      console.warn('[ERRORLOG] could not persist log to sessionStorage', { name: err && err.name });
    }
  }

  function restore() {
    if (!window.sessionStorage) return;
    let raw;
    try {
      raw = window.sessionStorage.getItem(STORAGE_KEY);
    } catch (err) {
      console.warn('[ERRORLOG] could not read persisted log', { name: err && err.name });
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object') {
            entries.push({ ...item, restored: true });
            if (Number.isFinite(item.seq)) seq = Math.max(seq, item.seq);
          }
        }
      }
    } catch (err) {
      console.warn('[ERRORLOG] persisted log was not valid JSON; starting fresh', { name: err && err.name });
    }
  }

  // ── recording ──
  function dedupeKey(entry) {
    return [entry.level, entry.kind, entry.endpoint, entry.code, entry.title, entry.reason].join('|');
  }

  function record(input) {
    const now = new Date();
    const entry = {
      seq: ++seq,
      ts: now.toISOString(),
      level: input && input.level === 'warn' ? 'warn' : 'error',
      kind: (input && input.kind) || 'app',
      title: String((input && input.title) || 'Unknown failure').slice(0, 200),
      // `reason` is the whole point of this log: WHY it failed.
      reason: input && input.reason != null ? String(input.reason).slice(0, 500) : '(no reason given)',
      endpoint: input && input.endpoint ? redactUrl(input.endpoint) : null,
      code: input && input.code != null ? String(input.code).slice(0, 40) : null,
      source: (input && input.source) || 'app',
      ms: input && Number.isFinite(input.ms) ? Math.round(input.ms) : null,
      count: 1,
    };

    const key = dedupeKey(entry);
    for (let i = entries.length - 1; i >= 0 && i > entries.length - 12; i -= 1) {
      const prev = entries[i];
      if (prev && !prev.restored && prev._key === key) {
        const age = now.getTime() - new Date(prev.lastTs || prev.ts).getTime();
        if (age <= DEDUPE_WINDOW_MS) {
          prev.count += 1;
          prev.lastTs = entry.ts;
          persist();
          return prev;
        }
      }
    }

    entry._key = key;
    entries.push(entry);
    while (entries.length > MAX_ENTRIES) entries.shift();
    persist();

    // One structured console line per distinct failure, so devtools alone is
    // enough even without calling errors(). Repeats are folded above and do
    // not re-log.
    const line = `[ERR] ${entry.title} — ${entry.reason}`;
    const meta = { endpoint: entry.endpoint, code: entry.code, kind: entry.kind, source: entry.source };
    if (entry.level === 'warn') console.warn(line, meta);
    else console.error(line, meta);

    return entry;
  }

  // ── fetch interceptor ──
  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url; // Request
    if (input && typeof input.toString === 'function') return input.toString(); // URL
    return '';
  }

  // ── Server-declared EXPECTED degradation ────────────────────────────────
  //
  // This is NOT a way to hide failures, and it is deliberately not a generic
  // mute. It recognises exactly one thing: a response on which OUR OWN server
  // has stamped a header saying "this non-2xx is the designed answer, not a
  // fault". Today that is `/api/context` answering 503 STALE_EXPIRED because the
  // newest published canonical run is past its hard freshness budget — a state
  // the terminal handles by reading live /api/markets instead.
  //
  // WHY IT MUST NOT BE RECORDED HERE: this interceptor cannot see whether the
  // caller recovered. It fires on every 60-second tick, so recording it painted
  // a fresh red `errors()` entry once a minute for a condition that is expected
  // and already handled — burying the failures this log exists to surface.
  //
  // WHAT STILL REPORTS IT: the CONSUMER, which does know the outcome —
  // fetchData() emits an INFO notice when the live fallback succeeds, and a RED
  // error naming BOTH sources when the fallback also fails. So the honest-error
  // rule is satisfied by the layer that has the information; nothing is
  // swallowed. A header we do not set can never reach this branch.
  function serverDeclaredExpected(res) {
    try {
      const headers = res && res.headers && typeof res.headers.get === 'function' ? res.headers : null;
      if (!headers) return false;
      return headers.get('X-Context-Stale') === 'expired';
    } catch (err) {
      // A response whose headers cannot be read is treated as a NORMAL failure
      // and recorded — failing closed towards visibility, not towards silence.
      void err;
      return false;
    }
  }

  function installFetchInterceptor() {
    if (installedFetch || typeof window.fetch !== 'function') return;
    const original = window.fetch;
    installedFetch = true;

    window.fetch = function patchedFetch(...args) {
      const startedAt = nowMs();
      const url = urlOf(args[0]);
      let result;
      try {
        result = original.apply(this, args);
      } catch (err) {
        // A synchronous throw (bad arguments) — rethrow untouched after logging.
        record({
          level: 'error',
          kind: 'network',
          title: 'fetch() threw before sending',
          reason: (err && err.message) || String(err),
          endpoint: url,
          source: 'fetch',
        });
        throw err;
      }

      return Promise.resolve(result).then(
        (res) => {
          if (res && res.ok === false && !serverDeclaredExpected(res)) {
            record({
              level: res.status >= 500 ? 'error' : 'warn',
              kind: 'http',
              title: `HTTP ${res.status} from ${res.url ? redactUrl(res.url) : redactUrl(url)}`,
              // No body is read here: consuming the stream would break the
              // caller, which is about to read it itself.
              reason: res.statusText
                ? `${res.status} ${res.statusText}`
                : `Upstream returned ${res.status} (no status text)`,
              endpoint: url,
              code: res.status,
              source: 'fetch',
              ms: nowMs() - startedAt,
            });
          }
          return res;
        },
        (err) => {
          record({
            level: 'error',
            kind: 'network',
            title: 'Network request failed',
            // This is the case that used to show as an endless "loading…":
            // DNS failure, CORS block, offline, aborted.
            reason: (err && err.message) || String(err) || 'fetch rejected with no message',
            endpoint: url,
            source: 'fetch',
            ms: nowMs() - startedAt,
          });
          // Rethrow so every existing caller behaves exactly as before.
          throw err;
        },
      );
    };
  }

  // ── console-facing API ──
  function visible() {
    return entries.map((e) => ({
      seq: e.seq,
      time: String(e.lastTs || e.ts).slice(11, 19),
      level: e.level,
      kind: e.kind,
      endpoint: e.endpoint,
      code: e.code,
      title: e.title,
      reason: e.reason,
      x: e.count > 1 ? e.count : '',
      ms: e.ms,
      when: e.restored ? 'before reload' : 'this session',
    }));
  }

  function dump() {
    const rows = visible();
    if (!rows.length) {
      console.log('%c[ERRORLOG] no failures recorded in this session 🎉', 'color:#4ade80');
      return rows;
    }
    const distinct = rows.length;
    const total = entries.reduce((acc, e) => acc + (e.count || 1), 0);
    console.groupCollapsed(
      `%c[ERRORLOG] ${distinct} distinct failure(s), ${total} occurrence(s) — newest last`,
      'color:#f87171;font-weight:bold',
    );
    console.table(rows);
    console.log('Counts by endpoint:', summary().byEndpoint);
    console.log('Counts by kind:', summary().byKind);
    console.log('Tip: errors.json() gives a paste-ready report; errors.clear() resets.');
    console.groupEnd();
    return rows;
  }

  function summary() {
    const byEndpoint = {};
    const byLevel = {};
    const byKind = {};
    for (const e of entries) {
      const n = e.count || 1;
      const ep = e.endpoint || '(no endpoint)';
      byEndpoint[ep] = (byEndpoint[ep] || 0) + n;
      byLevel[e.level] = (byLevel[e.level] || 0) + n;
      byKind[e.kind] = (byKind[e.kind] || 0) + n;
    }
    return { distinct: entries.length, byEndpoint, byLevel, byKind };
  }

  function clear() {
    entries.length = 0;
    seq = 0;
    if (window.sessionStorage) {
      try {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } catch (err) {
        console.warn('[ERRORLOG] could not clear persisted log', { name: err && err.name });
      }
    }
    console.log('[ERRORLOG] cleared.');
  }

  const ErrorLog = {
    record,
    entries: () => entries.slice(),
    dump,
    summary,
    clear,
    last: (n) => visible().slice(-Math.max(1, Number(n) || 10)),
    forEndpoint: (needle) => visible().filter((e) => e.endpoint && e.endpoint.includes(String(needle))),
    json: () => JSON.stringify({ generatedAt: new Date().toISOString(), summary: summary(), entries: visible() }, null, 2),
  };

  // ── global capture ──
  // ErrorLog owns these two listeners. toast.js keeps its own listeners for the
  // VISUAL toast but passes `skipLog` so the same failure is not recorded twice.
  window.addEventListener('error', (e) => {
    if (e && e.message && /ResizeObserver loop/i.test(e.message)) return; // known-noisy, not a failure
    record({
      level: 'error',
      kind: 'uncaught',
      title: 'Uncaught error',
      reason: (e && e.message) || 'unknown',
      endpoint: e && e.filename ? `${e.filename}:${e.lineno || '?'}` : null,
      source: 'window',
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    record({
      level: 'error',
      kind: 'unhandled-rejection',
      title: 'Unhandled promise rejection',
      reason: (r && (r.message || r.error)) || String(r || 'unknown'),
      source: 'window',
    });
  });

  restore();
  installFetchInterceptor();

  window.ErrorLog = ErrorLog;
  // Short, memorable devtools entry point: `errors()`.
  const errorsFn = () => dump();
  errorsFn.summary = summary;
  errorsFn.clear = clear;
  errorsFn.last = ErrorLog.last;
  errorsFn.forEndpoint = ErrorLog.forEndpoint;
  errorsFn.json = ErrorLog.json;
  errorsFn.entries = ErrorLog.entries;
  window.errors = errorsFn;

  console.log('%c[ERRORLOG] active — type errors() to list every failure with its reason.', 'color:#60a5fa');
})();
