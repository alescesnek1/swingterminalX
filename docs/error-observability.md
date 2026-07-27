# Error observability & static analysis

How the repo makes failures **visible, explained, and impossible to
reintroduce silently**. This is the implementation of `CLAUDE.md` /
`AGENTS.md` → *"Error observability (non-negotiable)"*.

Three pieces, in the order a failure travels:

1. **`apps/edge/public/js/error-log.js`** — the client keeps a queryable
   history of every failure *with its reason*.
2. **`tools/eslint/repo-contract-plugin.mjs`** — the written rules become
   ESLint errors, so a new silent failure fails the build.
3. **`eslint-suppressions.json`** — the pre-existing debt, counted and
   burn-down-able, so the gate applies to new code without being permanently red.

---

## 1. Client error log (`errors()` in devtools)

The UI already surfaced failures as toasts, but a toast disappears after 7
seconds and carries no history. `error-log.js` keeps the *why*.

### Console API

Open devtools on the terminal and type:

| Command | What it gives you |
| --- | --- |
| `errors()` | Table of every recorded failure: time, level, endpoint, HTTP code, title, **reason**, repeat count |
| `errors.summary()` | Occurrence counts by endpoint / level / kind |
| `errors.last(10)` | The 10 most recent entries |
| `errors.forEndpoint('/api/markets')` | Only failures for one endpoint |
| `errors.json()` | Paste-ready JSON report (redacted) |
| `errors.clear()` | Reset the log |

`window.ErrorLog` is the same thing with a longer name, plus
`ErrorLog.record({ level, title, reason, endpoint, code })` for app code.

### What feeds it

- **A `window.fetch` interceptor.** Every non-OK response and every network
  rejection is recorded automatically — including the ones no call site
  reports. This is what closes the "order book box that loads forever and
  never explains itself" gap. `error-log.js` is loaded **first** in
  `index.html` so the interceptor is installed before the first request.
- **`toast.js`.** Every `Toast.error(...)` / `Toast.warn(...)` forwards its
  title, detail, `endpoint`, and `code`. The ~67 existing call sites gained
  history without being touched.
- **Uncaught errors and unhandled promise rejections**, via listeners owned by
  `error-log.js`. `toast.js` passes `skipLog: true` from its own global
  handlers so the same event is never recorded twice.

### Guarantees the tests hold in place

`tests/frontend.error-log.test.mjs` and
`tests/frontend.toast-error-log-wiring.test.mjs` cover:

- **The interceptor is transparent.** A successful response is returned as the
  exact same object; a non-OK response is still returned unchanged; a rejection
  is rethrown unchanged. Wrapping `fetch` must never alter behaviour.
- **The response body is never read.** Consuming the stream would break the
  caller that is about to read it, and bodies can hold user data.
- **URLs are redacted.** Request URLs here can carry tokens, so the query
  string is dropped except for an explicit diagnostic allowlist (`symbol`,
  `pair`, `market`, `limit`, …), and the entry states how many params were
  dropped. Same-origin URLs are stored as a bare path.
- **Repeats fold.** The terminal polls, so a broken endpoint fails every few
  seconds. Identical failures inside 30s increment one row's counter instead of
  flooding out the earlier, different failure that actually explains things.
- **A missing reason is explicit** (`(no reason given)`), never blank.
- **A dead `sessionStorage` is reported, not swallowed** — and never stops
  recording.
- **Toast survives without ErrorLog.** `error-log.js` failing to load must not
  take the visual toast down with it.

### Deliberate non-goals

- Nothing is sent anywhere. It is an in-memory ring buffer (400 entries) with
  the last 120 mirrored into `sessionStorage` so a reload keeps "what failed
  just before this".
- It does not replace the toast. Visible-in-the-UI and logged-with-context are
  both required; this file is the second half only.

---

## 2. The repo-contract ESLint rules

`tools/eslint/repo-contract-plugin.mjs`. Prose does not fail a build:

| Rule | Written rule it enforces |
| --- | --- |
| `repo-contract/no-silent-catch` | "No empty `catch {}` that hides the failure." Also fires on comment-only catches — a comment explains the silence to a reader but leaves the runtime failure just as invisible. |
| `repo-contract/no-indistinguishable-catch-return` | "No `catch { return 0 }` (or `false` / `[]` / `null`) where that value is indistinguishable from a genuinely valid result." Object literals like `{ ok: false, reason }` are the *good* pattern and are never flagged. |
| `repo-contract/no-sensitive-log` | "Never log secrets, tokens, chat/user IDs, or PII." |

`no-sensitive-log` is the fiddly one, and `tests/lint.repo-contract-rules.test.mjs`
pins both directions:

- **Names are matched after normalisation** (lowercase, separators stripped),
  the same approach `netlify/functions/_observability.mjs` uses. A
  word-boundary regex was tried first and silently missed `accessToken` — the
  most common real name — because the "token" is preceded by a letter.
- **String literals are never flagged.** `console.warn('missing bearer token')`
  describes a failure; it does not leak one.
- **Boolean/count projections are what you're supposed to log**, so `!!token`,
  `token == null`, `token.length`, and `Boolean(secret)` all pass.
  `token.slice(0, 8)` does **not** — that hands over eight real characters.
- **Reading a named sub-field judges the field, not the receiver.**
  `auth.reason` is fine even though `auth` is a sensitive name; `auth.userId`
  is not.
- **`SCREAMING_SNAKE_CASE` reads are treated as named constants**
  (`TELEGRAM_CODES.MISSING_CREDENTIALS`) — **except** out of an env bag, where
  `process.env.SUPABASE_JWT_SECRET` is the real secret.
- **Keys that claim redaction are trusted** (`userIdMasked`, `recipientCount`,
  `hasToken`), because the rule cannot verify that `mask()` masks. Generic
  wrappers (`mode`, `status`, `ok`) deliberately do **not** buy that trust, so
  a real `{ mode: rawToken }` is still caught.

### Escape hatch

All three rules are overridable, because a few catches genuinely are
"this input is invalid, fail closed". Use a disable **with a written reason**:

```js
// eslint-disable-next-line repo-contract/no-indistinguishable-catch-return -- URL
// predicate: a malformed URL genuinely is not allowed (fail-closed), and every
// caller treats false as "reject", never as data.
} catch { return false; }
```

A disable without a reason is a review failure. ESLint cannot enforce that;
reviewers must.

---

## 3. Commands

```bash
npm run lint
```

The gate. Two exit codes matter, and both are actionable:

- **exit 1** — a **new** violation was introduced. Fix it, or disable it with a
  written reason.
- **exit 2** — a suppressed violation **no longer exists**: someone fixed one
  and left a stale baseline entry. Run `npm run lint:prune` and commit the
  shrunken `eslint-suppressions.json`.

So the baseline cannot silently grow, and progress cannot be silently thrown away.

```bash
npm run lint:debt      # what the baseline is still holding back, by rule and by file
npm run lint:debt -- --rule repo-contract/no-silent-catch
npm run lint:fix       # autofixable hygiene only
npm run lint:prune     # drop suppressions whose violations are gone
npm run lint:baseline  # regenerate the whole baseline (rarely correct — it hides new debt)
```

`.github/workflows/static-analysis.yml` runs `npm run lint`, then `npm run
lint:debt` as a report, then `npm test`. It only reads the repo: no deploy, no
push, no secrets.

### Working the debt down

1. Remove one file's entry from `eslint-suppressions.json`.
2. `npx eslint <that file>` to see its real violations.
3. Fix them — a catch needs a `console.warn` with context, or a discriminated
   return, or a disable with a reason.
4. `npm run lint:prune`, then commit the fix and the shrunken baseline together.

### Three environments, one config

`eslint.config.mjs` has per-area blocks because this repo has no build step and
three global sets: Deno edge functions (`Deno.env`), Node functions/scripts
(`process`, `Buffer`), and the browser SPA (`window`, `document`).

The browser area is split again by **how `index.html` loads it**:
`error-log.js`, `toast.js`, and `terminal.js` are classic `<script>` tags
(sloppy-mode, shared global scope); everything else is
`<script type="module">`. Parsing one as the other is a hard parse error, so
**a new file added to `index.html` must go in the matching block.**

`no-new-func` is an error in product code and off in `tests/**`, where
`new Function(...)` is the established way to execute a classic script against
a mock window (those files touch `window` at load and cannot be imported).

### Known limitation

`terminal.js` publishes globals as `window.foo = ...` and then calls them as
bare `foo`. `no-undef` cannot see that, so one such reference
(`showHeatmapDetail`) sits in the baseline. The code guards it with
`typeof showHeatmapDetail === 'function'` and is correct — it is a limit of
static analysis on a window-global monolith, not a bug.
