/**
 * Runs every `*-check.mjs` in this directory and reports a single verdict.
 *
 * Each check imports the real `.ets` sources through `lib.mjs`, so the suite
 * tests the shipped code rather than a re-typed copy. Exit code is non-zero when
 * any check fails, which is what the per-batch gate expects.
 */
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
// Start from a clean mirror: a previous run may have mirrored a mutated *copy*
// (see `mutate.mjs`), and mixing those with the live sources would be confusing.
rmSync(join(HERE, '.generated'), { recursive: true, force: true });
const checks = readdirSync(HERE)
  .filter((name) => name.endsWith('-check.mjs'))
  .sort();

if (checks.length === 0) {
  console.error('no checks found');
  process.exit(1);
}

const failed = [];
for (const name of checks) {
  console.log(`\n### ${name}`);
  const result = spawnSync(process.execPath, [join(HERE, name)], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed.push(name);
  }
}

console.log(`\n==== ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
