// ─────────────────────────────────────────────────────────────
// Static analysis for swing-terminal-workspace.
//
// This repo runs three different runtimes with three different global
// sets, all in plain .js/.mjs with no build step:
//
//   1. Deno edge functions   apps/edge/netlify/edge-functions/**  → Deno.env, web globals
//   2. Node functions/scripts netlify/functions/**, scripts/**    → process, Buffer
//   3. Browser SPA            apps/edge/public/js/**              → window, document
//
// A single flat config with per-area blocks keeps `no-undef` honest in
// all three instead of being switched off globally.
//
// The browser area is itself split, because index.html loads it two ways:
// `toast.js` and `terminal.js` are classic <script> tags (IIFE, no
// import/export), everything else is `<script type="module">`. Parsing a
// classic script as a module — or vice versa — is a hard parse error, so
// the split is load-order fact, not preference. If a new file is added to
// index.html, put it in the matching block.
//
// SEVERITY POLICY
//   • `repo-contract/*` rules are ERRORS. They encode CLAUDE.md's
//     non-negotiable error-observability and secret-logging rules, so
//     they must be able to fail a build.
//   • General hygiene inherited from @eslint/js recommended is mostly
//     kept at its default (error), except the few that fire in bulk on
//     pre-existing legacy code, which are WARN so they inform without
//     blocking. `npm run lint` shows both; `npm run lint:ci` fails on
//     errors only.
//
// No dependency on `globals` — the lists below are explicit so the
// devDependency surface stays at eslint + @eslint/js.
// ─────────────────────────────────────────────────────────────

import js from '@eslint/js';
import repoContract from './tools/eslint/repo-contract-plugin.mjs';

// Globals available in every runtime here (modern web-standard APIs that
// Deno, Node 18+, and browsers all ship).
const UNIVERSAL_GLOBALS = {
  console: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  crypto: 'readonly',
  performance: 'readonly',
  structuredClone: 'readonly',
  queueMicrotask: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  Blob: 'readonly',
  FormData: 'readonly',
  ReadableStream: 'readonly',
  WritableStream: 'readonly',
  TransformStream: 'readonly',
  WebSocket: 'readonly',
  Event: 'readonly',
  EventTarget: 'readonly',
  CustomEvent: 'readonly',
  DOMException: 'readonly',
  globalThis: 'readonly',
};

const NODE_GLOBALS = {
  ...UNIVERSAL_GLOBALS,
  process: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
};

const DENO_GLOBALS = {
  ...UNIVERSAL_GLOBALS,
  Deno: 'readonly',
};

const BROWSER_GLOBALS = {
  ...UNIVERSAL_GLOBALS,
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  self: 'readonly',
  screen: 'readonly',
  devicePixelRatio: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
  matchMedia: 'readonly',
  getComputedStyle: 'readonly',
  Notification: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  requestIdleCallback: 'readonly',
  XMLHttpRequest: 'readonly',
  EventSource: 'readonly',
  Worker: 'readonly',
  FileReader: 'readonly',
  Image: 'readonly',
  Option: 'readonly',
  DOMParser: 'readonly',
  MutationObserver: 'readonly',
  ResizeObserver: 'readonly',
  IntersectionObserver: 'readonly',
  HTMLElement: 'readonly',
  HTMLCanvasElement: 'readonly',
  Element: 'readonly',
  Node: 'readonly',
  NodeList: 'readonly',
  CanvasRenderingContext2D: 'readonly',
  Path2D: 'readonly',
  CSS: 'readonly',
  ClipboardItem: 'readonly',
  IDBRequest: 'readonly',
  indexedDB: 'readonly',
};

// Rules that fire in bulk on pre-existing code and would drown the
// signal from the contract rules. Kept visible as warnings rather than
// switched off, so the debt stays countable.
const LEGACY_HYGIENE_WARNINGS = {
  'no-unused-vars': ['warn', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'none', // `catch (e)` where e is unused is a separate concern (see no-silent-catch)
  }],
  'no-empty': ['warn', { allowEmptyCatch: true }], // catch specifically is repo-contract/no-silent-catch's job
};

const CONTRACT_RULES = {
  'repo-contract/no-silent-catch': 'error',
  'repo-contract/no-indistinguishable-catch-return': 'error',
  'repo-contract/no-sensitive-log': 'error',

  // Not part of the written contract, but this repo verifies HMAC signatures and
  // handles order payloads: building code from strings has no legitimate use in
  // PRODUCT code. It is switched back off for tests/** further down, where
  // `new Function(...)` is the established way to execute a classic <script>
  // (terminal.js, toast.js, error-log.js) under node:test without a DOM.
  'no-new-func': 'error',
};

export default [
  {
    // Generated, vendored, and local-only output. `.netlify/` holds a full
    // copy of bundled functions plus their node_modules — linting it would
    // double-report every real finding.
    ignores: [
      '**/node_modules/**',
      '.netlify/**',
      'apps/edge/.netlify/**',
      'apps/ingest/node_modules/**',
      'artifacts/**',
      'logs/**',
      'deno.lock',
    ],
  },

  // ── 1. Node: serverless functions, scripts, tests ──
  {
    files: ['netlify/functions/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'apps/ingest/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    plugins: { 'repo-contract': repoContract },
    rules: {
      ...js.configs.recommended.rules,
      ...LEGACY_HYGIENE_WARNINGS,
      ...CONTRACT_RULES,
    },
  },
  {
    // apps/ingest declares "type": "module", so its .js files are ESM.
    files: ['apps/ingest/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    plugins: { 'repo-contract': repoContract },
    rules: {
      ...js.configs.recommended.rules,
      ...LEGACY_HYGIENE_WARNINGS,
      ...CONTRACT_RULES,
    },
  },
  {
    // Root-level CommonJS one-off helpers (do_copy.js, _git.js).
    files: ['*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...NODE_GLOBALS, require: 'readonly', module: 'writable', exports: 'writable' },
    },
    plugins: { 'repo-contract': repoContract },
    rules: {
      ...js.configs.recommended.rules,
      ...LEGACY_HYGIENE_WARNINGS,
      ...CONTRACT_RULES,
    },
  },

  // ── 2. Deno edge functions ──
  {
    files: ['apps/edge/netlify/edge-functions/**/*.js', 'apps/edge/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: DENO_GLOBALS,
    },
    plugins: { 'repo-contract': repoContract },
    rules: {
      ...js.configs.recommended.rules,
      ...LEGACY_HYGIENE_WARNINGS,
      ...CONTRACT_RULES,
    },
  },

  // ── 3a. Browser SPA — ES modules (<script type="module">) ──
  {
    files: ['apps/edge/public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: BROWSER_GLOBALS,
    },
    plugins: { 'repo-contract': repoContract },
    rules: {
      ...js.configs.recommended.rules,
      ...LEGACY_HYGIENE_WARNINGS,
      ...CONTRACT_RULES,
    },
  },

  // ── 3b. Browser SPA — classic scripts (plain <script>, IIFE, no imports) ──
  // These are loaded without `type="module"` in index.html, so they run as
  // sloppy-mode global scripts. Parsing them as modules would wrongly apply
  // strict mode and hide the fact that they share one global scope.
  {
    files: [
      'apps/edge/public/js/error-log.js',
      'apps/edge/public/js/toast.js',
      'apps/edge/public/js/auth-client.js',
      'apps/edge/public/js/admin-users-panel.js',
      'apps/edge/public/js/terminal.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: BROWSER_GLOBALS,
    },
  },

  // ── Test-only relaxations ──
  // `no-sensitive-log`: a test whose whole job is proving we DON'T leak a token
  //   has to be able to name one.
  // `no-new-func`: the frontend suites execute classic <script> files
  //   (terminal.js, toast.js, error-log.js) against a mock window via
  //   `new Function(...)`, because those files touch `window` at load and
  //   cannot be imported. That is the harness, not a security smell.
  // Both rules stay on for all product code.
  {
    files: ['tests/**/*.mjs'],
    rules: {
      'repo-contract/no-sensitive-log': 'off',
      'no-new-func': 'off',
    },
  },

  // ── The lint tooling itself ──
  {
    files: ['tools/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...LEGACY_HYGIENE_WARNINGS,
    },
  },
];
