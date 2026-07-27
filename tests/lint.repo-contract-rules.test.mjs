// Tests for the repo's own ESLint rules (tools/eslint/repo-contract-plugin.mjs).
//
// These rules gate every commit, so a false positive is expensive (it pushes
// people toward blanket disables) and a false negative silently lets the
// error-observability contract rot. Both directions are covered here.
//
// Uses ESLint's own RuleTester. Run: `npm test`.
import test from 'node:test';
import { RuleTester } from 'eslint';
import plugin from '../tools/eslint/repo-contract-plugin.mjs';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

test('no-silent-catch', () => {
  ruleTester.run('no-silent-catch', plugin.rules['no-silent-catch'], {
    valid: [
      'try { f(); } catch (e) { console.warn("f failed", { name: e.name }); }',
      'function h() { try { f(); } catch (e) { return { ok: false, reason: "F_FAILED" }; } }',
      'try { f(); } catch (e) { throw e; }',
      // A rethrow-with-context is handling, not silence.
      'try { f(); } catch (e) { throw new Error("wrapped", { cause: e }); }',
    ],
    invalid: [
      { code: 'try { f(); } catch {}', errors: [{ messageId: 'silent' }] },
      { code: 'try { f(); } catch (e) {}', errors: [{ messageId: 'silent' }] },
      // A comment explains the silence to a reader but leaves the runtime
      // failure just as invisible — this is the pattern the repo had 100+ of.
      { code: 'try { f(); } catch { /* ignore */ }', errors: [{ messageId: 'silent' }] },
      { code: 'try { f(); } catch { /* */ }', errors: [{ messageId: 'silent' }] },
      { code: 'try { f(); } catch (e) { // malformed\n }', errors: [{ messageId: 'silent' }] },
    ],
  });
});

test('no-indistinguishable-catch-return', () => {
  ruleTester.run('no-indistinguishable-catch-return', plugin.rules['no-indistinguishable-catch-return'], {
    valid: [
      // The repo's good pattern: a discriminated result.
      'function f() { try { g(); } catch (e) { return { ok: false, reason: "G_FAILED" }; } }',
      'function f() { try { g(); } catch (e) { return { value: null, error: e.name }; } }',
      'function f() { try { g(); } catch (e) { return "UNKNOWN"; } }',
      // More than a bare return means the failure was handled somehow.
      'function f() { try { g(); } catch (e) { console.warn(e.name); return 0; } }',
      'function f() { try { g(); } catch (e) { throw e; } }',
    ],
    invalid: [
      {
        code: 'function f() { try { g(); } catch { return 0; } }',
        errors: [{ messageId: 'indistinguishable', data: { what: '0' } }],
      },
      {
        code: 'function f() { try { g(); } catch { return null; } }',
        errors: [{ messageId: 'indistinguishable', data: { what: 'null' } }],
      },
      {
        code: 'function f() { try { g(); } catch { return false; } }',
        errors: [{ messageId: 'indistinguishable', data: { what: 'false' } }],
      },
      {
        code: 'function f() { try { g(); } catch { return []; } }',
        errors: [{ messageId: 'indistinguishable', data: { what: 'an empty array' } }],
      },
      {
        code: 'function f() { try { g(); } catch { return {}; } }',
        errors: [{ messageId: 'indistinguishable', data: { what: 'an empty object' } }],
      },
      {
        code: 'function f() { try { g(); } catch { return ""; } }',
        errors: [{ messageId: 'indistinguishable', data: { what: 'an empty string' } }],
      },
      {
        code: 'function f() { try { g(); } catch { return -1; } }',
        errors: [{ messageId: 'indistinguishable', data: { what: '-1' } }],
      },
      {
        code: 'function f() { try { g(); } catch { return undefined; } }',
        errors: [{ messageId: 'indistinguishable', data: { what: 'undefined' } }],
      },
      {
        // A bare `return` is exactly as invisible as `return undefined`.
        code: 'function f() { try { g(); } catch { return; } }',
        errors: [{ messageId: 'indistinguishable', data: { what: 'nothing (implicit undefined)' } }],
      },
    ],
  });
});

test('no-sensitive-log', () => {
  ruleTester.run('no-sensitive-log', plugin.rules['no-sensitive-log'], {
    valid: [
      // A hardcoded string DESCRIBES a failure, it does not leak one.
      'console.warn("[AUTH] missing bearer token");',
      'console.error("token expired", { reason: "TOKEN_EXPIRED" });',
      // Boolean / count / masked derivatives are what AGENTS.md asks for.
      'console.warn("misconfigured", { hasBaseUrl: !!base, hasToken: !!token });',
      'console.log("auth debug", { token_present: !!token, token_len: token.length });',
      'console.log("auth", { token_parts: tokenParts });',
      'console.warn("recipients", { allowedRecipientsConfigured: n });',
      'console.log("check", { tokenMissing: token == null });',
      'console.log("state", { hasSecret: Boolean(secret) });',
      'console.log("count", { recipientCount: ids.length });',
      'console.log("id", { userIdMasked: mask(userId) });',
      // Reading a NAMED sub-field: the field is what gets logged, so a
      // sensitive-sounding receiver is irrelevant.
      'console.warn("[ANALYZE] Auth rejected:", auth.reason);',
      'console.warn("rejected", identity.orgId, identity.authMode);',
      // A named constant / stable error code is not a value.
      'console.warn(`[cron] ${TELEGRAM_CODES.MISSING_CREDENTIALS}: not sent.`);',
      // Not a console call at all.
      'logger.info({ token });',
    ],
    invalid: [
      { code: 'console.log(token);', errors: [{ messageId: 'sensitive' }] },
      { code: 'console.error("failed", { token });', errors: [{ messageId: 'sensitive' }] },
      { code: 'console.warn("user", { userId });', errors: [{ messageId: 'sensitive' }] },
      { code: 'console.log("chat", { chatId: rec.chatId });', errors: [{ messageId: 'sensitive' }] },
      { code: 'console.log(`bearer ${accessToken}`);', errors: [{ messageId: 'sensitive' }] },
      { code: 'console.log("db", { databaseUrl: cfg.databaseUrl });', errors: [{ messageId: 'sensitive' }] },
      { code: 'console.error(err.apiKey);', errors: [{ messageId: 'sensitive' }] },
      // A "masked" prefix still hands over real characters of the secret.
      { code: 'console.log("t", token.slice(0, 8));', errors: [{ messageId: 'sensitive' }] },
      { code: 'console.log("pw", { password: body.password });', errors: [{ messageId: 'sensitive' }] },
      // Generic wrapper keys must NOT buy trust — only keys that actively
      // claim redaction/aggregation do (see DECLARED_REDACTION_RE).
      { code: 'console.log("m", { mode: rawToken });', errors: [{ messageId: 'sensitive' }] },
      { code: 'console.log("s", { status: apiKey });', errors: [{ messageId: 'sensitive' }] },
      // The SCREAMING_SNAKE constant allowance must NOT extend to env bags —
      // that is where the real secrets live.
      { code: 'console.log(process.env.SUPABASE_JWT_SECRET);', errors: [{ messageId: 'sensitive' }] },
      { code: 'console.log(Deno.env.get("SUPABASE_ANON_KEY"), env.BOT_WORKER_TOKEN);', errors: [{ messageId: 'sensitive' }] },
      // A sub-field that is itself sensitive is still caught.
      { code: 'console.warn("who", identity.userId);', errors: [{ messageId: 'sensitive' }] },
      { code: 'console.warn("who", auth.accessToken);', errors: [{ messageId: 'sensitive' }] },
    ],
  });
});
