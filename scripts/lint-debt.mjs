// Prints the error-observability debt that `eslint-suppressions.json` is
// currently holding back, grouped so it can actually be worked down.
//
// Why this exists: the suppressions baseline is what lets `npm run lint` gate
// NEW code without the 240-odd pre-existing violations making the gate
// permanently red. That is only honest if the debt stays visible and countable
// — a baseline nobody can see is just a switched-off rule.
//
// Usage:  npm run lint:debt
//         npm run lint:debt -- --rule repo-contract/no-silent-catch
//
// Exits 0 always: this is a report, not a gate. The gate is `npm run lint`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suppressionsPath = path.join(repoRoot, 'eslint-suppressions.json');

const ruleFilterIndex = process.argv.indexOf('--rule');
const ruleFilter = ruleFilterIndex > -1 ? process.argv[ruleFilterIndex + 1] : null;

let raw;
try {
  raw = fs.readFileSync(suppressionsPath, 'utf8');
} catch (err) {
  console.error(
    `[lint:debt] Could not read ${path.relative(repoRoot, suppressionsPath)} (${err.code || err.name}).\n`
    + '           If it is genuinely missing, recreate it with: npm run lint:baseline',
  );
  process.exit(1);
}

let suppressions;
try {
  suppressions = JSON.parse(raw);
} catch (err) {
  console.error(`[lint:debt] ${path.relative(repoRoot, suppressionsPath)} is not valid JSON (${err.name}).`);
  process.exit(1);
}

const byRule = new Map();
const byFile = new Map();
let total = 0;

for (const [file, rules] of Object.entries(suppressions)) {
  for (const [rule, entry] of Object.entries(rules)) {
    const count = Number(entry && entry.count) || 0;
    if (ruleFilter && rule !== ruleFilter) continue;
    total += count;
    byRule.set(rule, (byRule.get(rule) || 0) + count);
    byFile.set(file, (byFile.get(file) || 0) + count);
  }
}

const desc = (a, b) => b[1] - a[1];
const pad = (n) => String(n).padStart(5);

if (total === 0) {
  console.log(ruleFilter
    ? `[lint:debt] No suppressed violations left for ${ruleFilter}. 🎉`
    : '[lint:debt] No suppressed violations left at all. 🎉 Delete eslint-suppressions.json.');
  process.exit(0);
}

console.log(`\n[lint:debt] ${total} suppressed violation(s) across ${byFile.size} file(s)`);
if (ruleFilter) console.log(`            filtered to rule: ${ruleFilter}`);

console.log('\nBy rule:');
for (const [rule, count] of [...byRule].sort(desc)) console.log(`${pad(count)}  ${rule}`);

console.log('\nWorst files:');
for (const [file, count] of [...byFile].sort(desc).slice(0, 15)) console.log(`${pad(count)}  ${file}`);

console.log(`
How to work this down:
  1. Fix violations in one file (see them with:  npx eslint <file>  after
     temporarily removing that file's entry from eslint-suppressions.json).
  2. Run  npm run lint:prune  to drop the suppressions that no longer apply.
  3. Commit the shrunken eslint-suppressions.json alongside the fix.

\`npm run lint\` fails (exit 2) if a suppression is left behind for a violation
that no longer exists, so the baseline cannot silently drift upward.
`);
