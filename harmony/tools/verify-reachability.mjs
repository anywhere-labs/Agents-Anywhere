// Reports ETS sources that the ArkTS compiler never sees.
//
// hvigor only compiles what `pages/Index` can reach, so a file that was written
// but never wired in is never type-checked: it can drift, or reference something
// that no longer exists, without failing the build. The build's `sourceMaps.map`
// lists exactly what went into the output, so every `.ets` file under
// `entry/src/main/ets` must appear there.
//
// Run it after a build (`hvigorw assembleHap`); without a build output it says so
// and exits 0, because there is nothing to compare against.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SOURCE_ROOT = join(ROOT, 'entry', 'src', 'main', 'ets');
const SOURCE_MAP = join(
  ROOT, 'entry', 'build', 'default', 'intermediates', 'loader_out', 'default', 'ets', 'sourceMaps.map',
);

if (!existsSync(SOURCE_MAP)) {
  console.log('no build output found; run `hvigorw assembleHap` first');
  process.exit(0);
}

function collect(directory, found) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      collect(path, found);
    } else if (entry.endsWith('.ets')) {
      found.push(relative(SOURCE_ROOT, path).split('\\').join('/'));
    }
  }
  return found;
}

const sources = collect(SOURCE_ROOT, []).sort();
const map = readFileSync(SOURCE_MAP, 'utf8');
const compiled = new Set();
for (const match of map.matchAll(/src\/main\/ets\/([^"]+?)\.ets"/g)) {
  compiled.add(match[1]);
}

const orphans = sources.filter((path) => !compiled.has(path.replace(/\.ets$/, '')));
for (const path of orphans) {
  console.error(`not compiled (unreachable from pages/Index): ${path}`);
}
console.log(`scanned ${sources.length} ETS file(s); unreachable=${orphans.length}`);
process.exitCode = orphans.length === 0 ? 0 : 1;
