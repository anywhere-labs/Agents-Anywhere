/**
 * Proves a check can fail, without ever touching the live sources.
 *
 *     node tools/logic-checks/mutate.mjs <module.ets> <check.mjs> "<find>" "<replace>"
 *
 * The source tree is copied to a temp directory, the edit is applied **to the
 * copy**, and the check runs against it through `AA_CHECK_SRC_ROOT`. The live
 * tree is never written — a deliberate mutation once sat in the working tree long
 * enough to be committed, and this removes that whole class of accident.
 *
 * Exit code is 0 when the mutant check failed (i.e. the check discriminates) and
 * 1 when the check still passed (i.e. it is a rubber stamp).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..', 'entry', 'src', 'main', 'ets');

const [modulePath, checkFile, find, replace] = process.argv.slice(2);
if (!modulePath || !checkFile || find === undefined || replace === undefined) {
  console.error('usage: node mutate.mjs <module.ets> <check.mjs> "<find>" "<replace>"');
  process.exit(2);
}

const copy = mkdtempSync(join(tmpdir(), 'aa-mutant-'));
const copiedRoot = join(copy, 'ets');
cpSync(SRC_ROOT, copiedRoot, { recursive: true });

const target = join(copiedRoot, modulePath);
const original = readFileSync(target, 'utf8');
if (!original.includes(find)) {
  console.error(`the mutation does not apply: "${find}" is not in ${modulePath}`);
  rmSync(copy, { recursive: true, force: true });
  process.exit(2);
}
writeFileSync(target, original.replace(find, replace), 'utf8');
console.log(`mutated a copy of ${modulePath} (live tree untouched):`);
console.log(`  - ${find.replace(/\n/g, '\n    ')}`);
console.log(`  + ${replace.replace(/\n/g, '\n    ')}`);

const result = spawnSync(process.execPath, [join(HERE, checkFile)], {
  stdio: 'inherit',
  env: { ...process.env, AA_CHECK_SRC_ROOT: copiedRoot },
});
rmSync(copy, { recursive: true, force: true });

if (result.status === 0) {
  console.error(`\nRUBBER STAMP: ${checkFile} passed against the mutated source.`);
  process.exit(1);
}
console.log(`\n${checkFile} rejected the mutation — the check discriminates.`);
