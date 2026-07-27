// Tests for scrypt password hashing (netlify/functions/_password.mjs).
//
// This is the module that decides whether a password is correct, so the tests
// lean on the failure directions: a corrupt stored hash must never read as a
// match, a tampered parameter must never be honoured, and "wrong password" must
// stay distinguishable from "this row is broken".
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  parseStoredHash,
  needsRehash,
  validatePasswordPolicy,
  getDummyHash,
  SCRYPT_PARAMS,
  MIN_PASSWORD_LENGTH,
} from '../netlify/functions/_password.mjs';

const GOOD = 'correct horse battery staple';

test('a hashed password verifies', async () => {
  const hashed = await hashPassword(GOOD);
  assert.equal(hashed.ok, true);
  const result = await verifyPassword(GOOD, hashed.hash);
  assert.equal(result.ok, true);
  assert.equal(result.matches, true);
  assert.equal(result.needsRehash, false);
});

test('a wrong password does not verify', async () => {
  const hashed = await hashPassword(GOOD);
  const result = await verifyPassword('correct horse battery stapl', hashed.hash);
  assert.equal(result.ok, true);
  assert.equal(result.matches, false);
});

test('the same password hashes differently every time (unique salt)', async () => {
  const a = await hashPassword(GOOD);
  const b = await hashPassword(GOOD);
  assert.notEqual(a.hash, b.hash, 'a shared salt would make the hashes rainbow-table-able');
  // ...and both still verify.
  assert.equal((await verifyPassword(GOOD, a.hash)).matches, true);
  assert.equal((await verifyPassword(GOOD, b.hash)).matches, true);
});

test('the stored format carries its own parameters', async () => {
  const hashed = await hashPassword(GOOD);
  const parts = hashed.hash.split('$');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts[1], `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`);

  const parsed = parseStoredHash(hashed.hash);
  assert.deepEqual(parsed.params, SCRYPT_PARAMS);
  assert.equal(parsed.salt.length, 16);
  assert.equal(parsed.digest.length, 64);
});

test('the plaintext password never appears in the stored hash', async () => {
  const hashed = await hashPassword(GOOD);
  assert.ok(!hashed.hash.includes(GOOD));
  assert.ok(!hashed.hash.toLowerCase().includes('horse'));
});

// ── policy ──

test('policy rejects short, blank, and non-string passwords', () => {
  assert.equal(validatePasswordPolicy('x'.repeat(MIN_PASSWORD_LENGTH - 1)).reason, 'PASSWORD_TOO_SHORT');
  assert.equal(validatePasswordPolicy('            ').reason, 'PASSWORD_BLANK');
  assert.equal(validatePasswordPolicy(null).reason, 'PASSWORD_NOT_A_STRING');
  assert.equal(validatePasswordPolicy(12345678901234).reason, 'PASSWORD_NOT_A_STRING');
  assert.equal(validatePasswordPolicy('x'.repeat(5000)).reason, 'PASSWORD_TOO_LONG');
  assert.equal(validatePasswordPolicy('x'.repeat(MIN_PASSWORD_LENGTH)).ok, true);
});

test('hashPassword refuses to hash a policy-violating password', async () => {
  const result = await hashPassword('short');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PASSWORD_TOO_SHORT');
  assert.equal(result.hash, undefined, 'no hash may be produced for a rejected password');
});

test('policy length counts code points, so an emoji counts once', () => {
  // 11 emoji = 11 code points but 22 UTF-16 units. Measuring .length would wrongly
  // accept this as long enough.
  assert.equal(validatePasswordPolicy('🔒'.repeat(11)).reason, 'PASSWORD_TOO_SHORT');
  assert.equal(validatePasswordPolicy('🔒'.repeat(12)).ok, true);
});

test('a password differing only in Unicode composition still verifies', async () => {
  // "é" as a single code point vs "e" + combining acute. The same typed password
  // must not lock the user out depending on their OS/keyboard.
  const composed = 'passéword-long-enough';
  const decomposed = 'passéword-long-enough';
  assert.notEqual(composed, decomposed, 'the two strings really are different byte-wise');

  const hashed = await hashPassword(composed);
  const result = await verifyPassword(decomposed, hashed.hash);
  assert.equal(result.matches, true, 'NFKC normalization must make these equivalent');
});

// ── malformed / hostile stored hashes ──

test('an unreadable stored hash is a distinct error, never a match', async () => {
  for (const bad of [
    '', 'garbage', 'scrypt$$$', 'scrypt$N=x,r=8,p=1$aaaa$bbbb',
    'bcrypt$N=32768,r=8,p=1$aaaa$bbbb', // wrong algorithm
    'scrypt$N=32768,r=8,p=1$aaaa',      // too few segments
    null, undefined, 42, {},
  ]) {
    const result = await verifyPassword(GOOD, bad);
    assert.equal(result.ok, false, `stored=${JSON.stringify(bad)} must be an error, not a verdict`);
    assert.equal(result.reason, 'STORED_HASH_UNREADABLE');
    assert.notEqual(result.matches, true, 'an unreadable hash must never report a match');
  }
});

test('parseStoredHash refuses absurd parameters from a tampered row', () => {
  // Without a ceiling, an attacker with row-write access could make every login
  // attempt exhaust memory or hang the function.
  assert.equal(parseStoredHash('scrypt$N=999999999,r=8,p=1$aaaa$bbbb'), null);
  assert.equal(parseStoredHash('scrypt$N=32768,r=9999,p=1$aaaa$bbbb'), null);
  assert.equal(parseStoredHash('scrypt$N=32768,r=8,p=9999$aaaa$bbbb'), null);
  assert.equal(parseStoredHash('scrypt$N=0,r=8,p=1$aaaa$bbbb'), null);
  assert.equal(parseStoredHash('scrypt$N=-1,r=8,p=1$aaaa$bbbb'), null);
});

test('an empty password never matches, whatever is stored', async () => {
  const hashed = await hashPassword(GOOD);
  const result = await verifyPassword('', hashed.hash);
  assert.equal(result.matches, false);
});

test('a digest of the wrong length is a non-match, not a crash', async () => {
  // timingSafeEqual throws on unequal lengths — the length check must come first.
  const truncated = `scrypt$N=${SCRYPT_PARAMS.N},r=8,p=1$${Buffer.from('0123456789abcdef').toString('base64')}$${Buffer.from('short').toString('base64')}`;
  const result = await verifyPassword(GOOD, truncated);
  assert.equal(result.ok, true);
  assert.equal(result.matches, false);
});

// ── rehash on policy upgrade ──

test('a hash made with weaker parameters is flagged for rehash but still verifies', async () => {
  // Simulate an older, cheaper hash by hashing at N=16384 directly.
  const crypto = await import('node:crypto');
  const salt = crypto.default.randomBytes(16);
  const weakParams = { N: 16384, r: 8, p: 1 };
  const digest = crypto.default.scryptSync(GOOD.normalize('NFKC'), salt, 64, { ...weakParams, maxmem: 96 * 1024 * 1024 });
  const weakHash = `scrypt$N=${weakParams.N},r=${weakParams.r},p=${weakParams.p}$${salt.toString('base64')}$${digest.toString('base64')}`;

  assert.equal(needsRehash(weakHash), true);
  const result = await verifyPassword(GOOD, weakHash);
  assert.equal(result.matches, true, 'raising the cost must not lock existing users out');
  assert.equal(result.needsRehash, true);
});

test('needsRehash is false for a current hash and for an unreadable one', async () => {
  const hashed = await hashPassword(GOOD);
  assert.equal(needsRehash(hashed.hash), false);
  // Unreadable is a verify-time problem; reporting it as "needs rehash" would
  // imply we could rehash it, which we cannot (there is no known password).
  assert.equal(needsRehash('garbage'), false);
});

test('needsRehash is only reported on a MATCHING password', async () => {
  const crypto = await import('node:crypto');
  const salt = crypto.default.randomBytes(16);
  const digest = crypto.default.scryptSync('other-password-here', salt, 64, { N: 16384, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
  const weakHash = `scrypt$N=16384,r=8,p=1$${salt.toString('base64')}$${digest.toString('base64')}`;

  const result = await verifyPassword(GOOD, weakHash);
  assert.equal(result.matches, false);
  assert.equal(result.needsRehash, false, 'rehashing on a failed login would be pointless work');
});

// ── login-timing dummy hash ──

test('the dummy hash is stable, valid, and matches nothing', async () => {
  const first = await getDummyHash();
  const second = await getDummyHash();
  assert.equal(first, second, 'it must be cached, or it adds a second scrypt per login');
  assert.ok(parseStoredHash(first), 'it must be parseable so the timing path really runs scrypt');

  const result = await verifyPassword(GOOD, first);
  assert.equal(result.ok, true);
  assert.equal(result.matches, false);
});
