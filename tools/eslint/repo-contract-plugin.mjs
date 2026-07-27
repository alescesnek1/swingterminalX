// ─────────────────────────────────────────────────────────────
// ESLint plugin: the repo's own non-negotiable contract, enforced
// mechanically instead of by review memory.
//
// These rules exist because `CLAUDE.md` / `AGENTS.md` →
// "Error observability (non-negotiable)" and "Safety rules" are
// prose, and prose does not fail a build. Each rule below maps 1:1
// to a written rule:
//
//   no-silent-catch                     ← "No empty `catch {}` that hides the failure."
//   no-indistinguishable-catch-return   ← "No `catch { return 0 }` (or `false`/`[]`/`null`)
//                                          where that value is indistinguishable from a
//                                          genuinely valid result."
//   no-sensitive-log                    ← "never log secrets, tokens, chat/user IDs, or PII"
//
// ESCAPE HATCH — every rule is intentionally overridable, because a
// few catches genuinely are "this input is invalid, fail closed" and
// a few logs genuinely carry only a masked/boolean derivative. Use an
// eslint-disable comment WITH a written reason after `--`:
//
//   // eslint-disable-next-line repo-contract/no-indistinguishable-catch-return -- URL
//   // predicate: a malformed URL genuinely is not allowed (fail-closed), and the
//   // caller treats false as "reject", never as data.
//
// A disable without a reason is a review failure even though ESLint
// itself cannot enforce that. Silence must always be argued for.
// ─────────────────────────────────────────────────────────────

// ── no-indistinguishable-catch-return ──
// Return values that a caller cannot tell apart from a real result.
// `undefined` is included because an implicit-`undefined` fallback is
// exactly as invisible as `0`. Deliberately NOT included: object
// literals like `{ ok: false, reason }` — that is the repo's *good*
// pattern and the rule must not push people away from it.
function classifyIndistinguishableReturn(argument) {
  if (argument === null || argument === undefined) return 'nothing';
  if (argument.type === 'Literal') {
    const { value } = argument;
    if (value === null) return 'null';
    if (value === 0) return '0';
    if (value === false) return 'false';
    if (value === true) return 'true';
    if (value === '') return 'an empty string';
    if (value === -1) return '-1';
    return null;
  }
  if (argument.type === 'Identifier') {
    if (argument.name === 'undefined') return 'undefined';
    if (argument.name === 'NaN') return 'NaN';
    return null;
  }
  if (argument.type === 'ArrayExpression' && argument.elements.length === 0) return 'an empty array';
  if (argument.type === 'ObjectExpression' && argument.properties.length === 0) return 'an empty object';
  // `-1` parses as a unary expression, not a negative literal.
  if (
    argument.type === 'UnaryExpression'
    && argument.operator === '-'
    && argument.argument.type === 'Literal'
    && argument.argument.value === 1
  ) {
    return '-1';
  }
  return null;
}

// ── no-sensitive-log ──
// Identifier / property names whose *value* must never reach a log.
//
// Matching normalizes the name first (lowercase, strip separators) and then
// looks for substrings — the same approach `netlify/functions/_observability.mjs`
// already uses for its stored-payload key filter. A word-boundary regex was
// tried first and silently missed the most common real names: in `accessToken`
// the "token" is preceded by a letter, so nothing matched.
const SENSITIVE_SUBSTRINGS = [
  'token', 'secret', 'password', 'passwd', 'jwt', 'apikey', 'privatekey',
  'authorization', 'bearer', 'credential', 'chatid', 'userid',
  'email', 'connectionstring', 'databaseurl', 'dburl',
];

// Matched only as the WHOLE normalized name. As substrings these would swallow
// innocuous words ('sub' → subscription/submit/substring, 'auth' → authMode/author).
const SENSITIVE_EXACT = new Set(['sub', 'auth', 'cookie']);

function normalizeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveName(name) {
  const normalized = normalizeName(name);
  if (SENSITIVE_EXACT.has(normalized)) return true;
  return SENSITIVE_SUBSTRINGS.some((needle) => normalized.includes(needle));
}

// Derivatives that are safe by construction: booleans, counts, lengths,
// and explicitly masked values carry no secret. Without this allowlist the
// rule would fight the repo's own good practice — `personal-alerts.mjs`
// deliberately logs `allowedRecipientsConfigured` instead of raw ids.
const SAFE_DERIVATIVE_RE = /^(has|is|any|with|should|can|allow|require)[A-Z_]/;
const SAFE_SUFFIX_RE = /(masked|present|count|counts|length|len|parts|segments|chars|bytes|configured|set|enabled|disabled|ok|valid|kind|mode|status|hash|redacted)$/i;

function isSafeDerivativeName(name) {
  return SAFE_DERIVATIVE_RE.test(name) || SAFE_SUFFIX_RE.test(name);
}

// A NARROWER list than SAFE_SUFFIX_RE, used only to decide whether to stop
// walking into a property's value. These names actively claim the value has
// been redacted or aggregated, so `{ userIdMasked: mask(userId) }` is trusted
// even though the rule cannot verify that `mask()` masks.
//
// Deliberately excludes the generic wrappers SAFE_SUFFIX_RE allows
// (`mode`, `status`, `kind`, `ok`, `set`, `valid`, `enabled`): those are far
// too common as ordinary keys, and trusting them would blind the rule to a
// real `{ mode: rawToken }`.
const DECLARED_REDACTION_RE = /(masked|redacted|hash|count|counts|length|len|parts|segments|chars|bytes|present|absent|missing|empty|configured)$/i;

function declaresRedactedValue(name) {
  return SAFE_DERIVATIVE_RE.test(name) || DECLARED_REDACTION_RE.test(name);
}

// Expressions that reduce a sensitive value to something unrecoverable — a
// boolean or a count. `!!token`, `token == null`, `token.length`,
// `Boolean(secret)` are all exactly what AGENTS.md asks people to log instead
// of the raw value, so the walk must stop rather than flag the identifier
// inside. Anything that returns a *substring* (`token.slice(0, 8)`) is NOT
// listed here on purpose: that still leaks characters of the secret.
const BOOLEAN_COERCING_UNARY = new Set(['!', 'typeof', 'void', 'delete']);
const COMPARISON_OPERATORS = new Set(['==', '===', '!=', '!==', '>', '<', '>=', '<=', 'in', 'instanceof']);
const SAFE_PROJECTION_PROPERTIES = new Set(['length', 'size', 'byteLength']);

// SCREAMING_SNAKE_CASE reads are almost always a named constant — a stable
// error code like `TELEGRAM_CODES.MISSING_CREDENTIALS`, not a value. The one
// place that is emphatically NOT true is an env container, where
// `process.env.SUPABASE_JWT_SECRET` is the real secret, so those are excluded.
const CONSTANT_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function isEnvContainer(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return normalizeName(node.name) === 'env';
  if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
    return normalizeName(node.property.name) === 'env';
  }
  return false;
}

function isSafeProjection(node) {
  if (!node) return false;
  if (node.type === 'UnaryExpression' && BOOLEAN_COERCING_UNARY.has(node.operator)) return true;
  if (node.type === 'BinaryExpression' && COMPARISON_OPERATORS.has(node.operator)) return true;
  if (
    node.type === 'MemberExpression'
    && !node.computed
    && node.property.type === 'Identifier'
    && SAFE_PROJECTION_PROPERTIES.has(node.property.name)
  ) {
    return true;
  }
  if (
    node.type === 'CallExpression'
    && node.callee.type === 'Identifier'
    && (node.callee.name === 'Boolean' || node.callee.name === 'isFinite')
  ) {
    return true;
  }
  return false;
}

// Walks one console argument looking for an identifier/property whose value
// would be interpolated into the log. String literals are skipped on
// purpose: `console.warn('missing bearer token')` describes a failure, it
// does not leak one — only real values matter.
function findSensitiveReference(node, sourceCode) {
  const found = [];

  function nameOf(n) {
    if (n.type === 'Identifier') return n.name;
    if (n.type === 'PrivateIdentifier') return n.name;
    return null;
  }

  function visit(n) {
    if (!n || typeof n.type !== 'string' || found.length) return;

    // A boolean/count projection is the recommended thing to log — stop here
    // instead of reporting the sensitive identifier it was derived from.
    if (isSafeProjection(n)) return;

    switch (n.type) {
      case 'Literal':
      case 'TemplateElement':
        return; // a hardcoded string is a description, not a value
      case 'Identifier': {
        if (!isSafeDerivativeName(n.name) && isSensitiveName(n.name)) found.push(n.name);
        return;
      }
      case 'MemberExpression': {
        const prop = nameOf(n.property)
          ?? (n.property.type === 'Literal' ? String(n.property.value) : null);
        if (prop) {
          // A named constant, not a value — unless it comes out of an env bag.
          if (CONSTANT_NAME_RE.test(prop) && !isEnvContainer(n.object)) return;
          if (!isSafeDerivativeName(prop) && isSensitiveName(prop)) {
            found.push(sourceCode.getText(n));
            return;
          }
          // Reading a NAMED sub-field: the value logged is that field, so the
          // receiver's own name says nothing. `auth.reason` and
          // `identity.orgId` are safe even though `auth` is a sensitive name.
          // A method CALL on a sensitive receiver is different and is handled
          // by the CallExpression case below.
          return;
        }
        // Computed key (`bag[k]`) — the read is unknowable, so judge the
        // receiver itself.
        visit(n.object);
        visit(n.property);
        return;
      }
      case 'CallExpression': {
        // A method invoked ON a sensitive value can hand back part of it:
        // `token.slice(0, 8)` leaks eight real characters of the secret.
        if (n.callee.type === 'MemberExpression') {
          const receiver = n.callee.object;
          const receiverName = receiver.type === 'Identifier'
            ? receiver.name
            : (receiver.type === 'MemberExpression' && receiver.property.type === 'Identifier'
              ? receiver.property.name
              : null);
          if (receiverName && !isSafeDerivativeName(receiverName) && isSensitiveName(receiverName)) {
            found.push(sourceCode.getText(n));
            return;
          }
        }
        n.arguments.forEach(visit);
        return;
      }
      case 'Property': {
        // `{ userId }` and `{ userId: x }` both leak; `{ ok: token != null }`
        // does not — so judge the key first, then walk the value.
        const key = nameOf(n.key) ?? (n.key.type === 'Literal' ? String(n.key.value) : null);
        if (key) {
          // A key that claims redaction/aggregation (`userIdMasked`,
          // `recipientCount`, `hasToken`) documents that the value is already a
          // derivative. The rule cannot verify that `mask(userId)` really
          // masks, so it takes the declared intent — a narrow, self-documenting
          // escape hatch, and a better outcome than pushing people toward a
          // blanket eslint-disable over the whole call.
          if (declaresRedactedValue(key)) return;
          if (!isSafeDerivativeName(key) && isSensitiveName(key)) {
            found.push(key);
            return;
          }
        }
        visit(n.value);
        return;
      }
      default: {
        for (const key of Object.keys(n)) {
          if (key === 'parent' || key === 'loc' || key === 'range') continue;
          const child = n[key];
          if (Array.isArray(child)) child.forEach(visit);
          else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
        }
      }
    }
  }

  visit(node);
  return found[0] ?? null;
}

const CONSOLE_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']);

function isConsoleCall(node) {
  const callee = node.callee;
  if (callee?.type !== 'MemberExpression') return false;
  if (callee.object?.type !== 'Identifier' || callee.object.name !== 'console') return false;
  const method = callee.property?.type === 'Identifier' ? callee.property.name : null;
  return method !== null && CONSOLE_METHODS.has(method);
}

const rules = {
  'no-silent-catch': {
    meta: {
      type: 'problem',
      docs: {
        description:
          'A catch block must do something observable — log it, report it, or surface it. '
          + 'An empty (or comment-only) catch hides a failure the owner can never see.',
      },
      schema: [],
      messages: {
        silent:
          'Silent catch: this failure is invisible. Log it (console.warn/error with context) '
          + 'or surface it to the user. See CLAUDE.md → Error observability.',
      },
    },
    create(context) {
      return {
        CatchClause(node) {
          // Comments are not statements, so a `catch { /* ignore */ }` lands
          // here too — which is the point. A comment explains the silence to
          // a reader; it does not make the failure observable at runtime.
          if (node.body.body.length > 0) return;
          context.report({ node: node.body, messageId: 'silent' });
        },
      };
    },
  },

  'no-indistinguishable-catch-return': {
    meta: {
      type: 'problem',
      docs: {
        description:
          'A catch block must not return a value the caller cannot tell apart from real data. '
          + 'Return a discriminated result ({ ok:false, reason }) or a sentinel like UNKNOWN.',
      },
      schema: [],
      messages: {
        indistinguishable:
          'Catch returns {{what}}, which is indistinguishable from a real result. '
          + 'Return a discriminated value ({ ok:false, reason }) instead, and log the cause. '
          + 'See CLAUDE.md → Error observability.',
      },
    },
    create(context) {
      return {
        CatchClause(node) {
          const body = node.body.body;
          if (body.length !== 1) return;
          const stmt = body[0];
          if (stmt.type !== 'ReturnStatement') return;
          const what = classifyIndistinguishableReturn(stmt.argument);
          if (!what) return;
          context.report({
            node: stmt,
            messageId: 'indistinguishable',
            data: { what: what === 'nothing' ? 'nothing (implicit undefined)' : what },
          });
        },
      };
    },
  },

  'no-sensitive-log': {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Never log secrets, tokens, JWTs, connection strings, or chat/user identifiers. '
          + 'Log a masked, boolean, or counted derivative instead.',
      },
      schema: [],
      messages: {
        sensitive:
          'Logging `{{name}}` risks writing a secret or an identifier to a log. '
          + 'Log a boolean/count/masked derivative instead (e.g. hasToken, recipientCount). '
          + 'See AGENTS.md → Safety rules.',
      },
    },
    create(context) {
      const sourceCode = context.sourceCode;
      return {
        CallExpression(node) {
          if (!isConsoleCall(node)) return;
          for (const arg of node.arguments) {
            const name = findSensitiveReference(arg, sourceCode);
            if (name) {
              context.report({ node: arg, messageId: 'sensitive', data: { name } });
              return; // one report per console call is enough to act on
            }
          }
        },
      };
    },
  },
};

export default {
  meta: { name: 'eslint-plugin-repo-contract', version: '1.0.0' },
  rules,
};
