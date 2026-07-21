import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Source guards for
// netlify/database/migrations/20260721090000_add-price-history-schedule-guard/
// migration.sql — text-level checks only, not a live-DB migration runner
// (same style as the workflow source-guard tests). This migration has not
// been deployed yet, so these checks are what stand between an unreviewed
// SQL change and a production deploy that auto-applies it.
//
// WHY THIS MUST STAY A PARTIAL INDEX: an unscoped
// `(source, minute)` unique index would apply to every existing row in
// market_price_snapshots, including the manual admin collector's
// ('admin_price_history_collect') snapshots — constraining a tool that
// must stay unconstrained, and requiring a production collision pre-check
// before every future deploy. Scoping the index to
// `WHERE source = 'scheduled_price_history'` (a source value no existing
// row uses) means the index matches zero current rows by construction, so
// it can never collide with existing data and never touches the manual
// collector's behavior.

const MIGRATION_PATH = new URL(
  '../netlify/database/migrations/20260721090000_add-price-history-schedule-guard/migration.sql',
  import.meta.url,
);

function readMigration() {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

test('migration file exists', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), 'expected the schedule-guard migration.sql to exist');
});

test('creates a unique index (not a plain index)', () => {
  const source = readMigration();
  assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS/);
});

test('the index is a PARTIAL index scoped to source = scheduled_price_history', () => {
  const source = readMigration();
  assert.match(source, /WHERE\s+source\s*=\s*'scheduled_price_history'/);
});

test('the index is keyed on (source, UTC-minute-truncated sampled_at)', () => {
  const source = readMigration();
  assert.match(source, /market_price_snapshots\s*\(\s*\n?\s*source\s*,\s*\n?\s*date_trunc\('minute',\s*sampled_at AT TIME ZONE 'UTC'\)/);
});

test('does NOT create an unscoped global (source, minute) uniqueness constraint', () => {
  const source = readMigration();
  // Strip the one intentional partial-index statement, then confirm no
  // second CREATE UNIQUE INDEX ... (source, ...) statement exists without
  // a WHERE clause restricting it to the scheduler's source value.
  const createIndexStatements = source.match(/CREATE UNIQUE INDEX[\s\S]*?;/g) || [];
  assert.equal(createIndexStatements.length, 1, 'expected exactly one CREATE UNIQUE INDEX statement in this migration');
  assert.match(createIndexStatements[0], /WHERE/, 'the single unique index must be partial (carry a WHERE clause)');
});

test('does not reference or constrain the manual admin collector source in actual SQL', () => {
  const source = readMigration();
  // The header comment legitimately *names* 'admin_price_history_collect'
  // to explain why it is deliberately excluded from the partial index's
  // WHERE clause — what must be absent is that source value appearing in
  // an executable SQL statement (which would mean it's being constrained).
  const sqlOnly = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.doesNotMatch(sqlOnly, /'admin_price_history_collect'/);
});

test('the migration is additive and non-destructive', () => {
  const source = readMigration();
  assert.doesNotMatch(source, /\bDROP\s+(TABLE|INDEX|COLUMN)\b/i);
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(source, /\bTRUNCATE\b/i);
  assert.doesNotMatch(source, /\bALTER\s+TABLE\b.*\bDROP\b/i);
});

test('does not touch the base market-price-history migration or any other table', () => {
  const source = readMigration();
  // Strip `--` comment lines first — the header comment legitimately
  // *mentions* market_price_points/market_price_snapshots as context (it
  // cites the sibling migration that created them); what must be absent is
  // any actual SQL statement operating on a table other than the one
  // partial index this migration creates.
  const sqlOnly = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.doesNotMatch(sqlOnly, /CREATE TABLE/i);
  assert.doesNotMatch(sqlOnly, /market_price_points/);
});

test('the guard rationale (duplicate scheduled snapshots, spacing-guard race) remains documented', () => {
  const source = readMigration();
  assert.match(source, /duplicate/i);
  assert.match(source, /race/i);
  assert.match(source, /scheduled_price_history/);
});

test('migration contains no secrets, DB URLs, or credential-shaped values', () => {
  const source = readMigration();
  assert.doesNotMatch(source, /postgres:\/\//);
  assert.doesNotMatch(source, /password/i);
  assert.doesNotMatch(source, /NETLIFY_DB_URL|DATABASE_URL/);
});
