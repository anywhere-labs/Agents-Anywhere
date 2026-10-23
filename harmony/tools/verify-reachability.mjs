// Reports ETS sources that are neither compiled nor statically imported.
//
// hvigor only type-checks what the registered pages and their imports can
// reach, so a file that was written but never wired in is never compiled: it
// can drift, or reference something that no longer exists, without failing
// the build.
//
// This is a six-module project (HAR: common/network, HSP: session/terminal/
// files, HAP: entry); every module's sources are covered:
//   - source ids are `<module>:<path from module root, no extension>`, e.g.
//     `session:src/main/ets/pages/HomePage` or `common:Index`;
//   - cross-module imports use the bare module name (useNormalizedOHMUrl),
//     which resolves to the module-root `Index.ets`;
//   - roots are the union of every module's `loader_out/.../sourceMaps.map`
//     (HAR code shows up in the maps of its consumers), or, without a build,
//     every page in `main_pages.json` / `router_map.json` plus each module's
//     root `Index.ets`.
//
// Run it after a build; the fallback path is only a coarse approximation.
//
// Usage (from the harmony project root):
//   node tools/verify-reachability.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MODULES = ['common', 'network', 'session', 'terminal', 'files', 'entry'];
const MODULE_NAMES = new Set(MODULES);

/** Every `.ets` under `<module>/Index.ets` + `<module>/src/main/ets/**`, as ids. */
function collectModuleSources(moduleName) {
  const moduleRoot = join(ROOT, moduleName);
  const out = [];
  const add = (abs) => {
    out.push(`${moduleName}:${relative(moduleRoot, abs).split('\\').join('/').replace(/\.ets$/, '')}`);
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith('.ets')) {
        add(path);
      }
    }
  };
  const rootIndex = join(moduleRoot, 'Index.ets');
  if (existsSync(rootIndex)) {
    add(rootIndex);
  }
  const etsRoot = join(moduleRoot, 'src', 'main', 'ets');
  if (existsSync(etsRoot)) {
    walk(etsRoot);
  }
  return out;
}

const sources = MODULES.flatMap(collectModuleSources).sort();
const sourceSet = new Set(sources);

/** Absolute path of one id's file. */
function fileOf(id) {
  const separator = id.indexOf(':');
  return join(ROOT, id.substring(0, separator), `${id.substring(separator + 1)}.ets`);
}

/** Every import edge of one file: relative imports stay in-module, bare
 * module names resolve to `<module>:Index`. */
function importsOf(id) {
  const separator = id.indexOf(':');
  const moduleName = id.substring(0, separator);
  const moduleRoot = join(ROOT, moduleName);
  const text = readFileSync(fileOf(id), 'utf8');
  const out = new Set();
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
    const specifier = match[1];
    if (specifier.startsWith('.')) {
      const base = `${moduleName}:${relative(moduleRoot, resolve(dirname(fileOf(id)), specifier)).split('\\').join('/')}`;
      for (const candidate of [base, `${base}/Index`]) {
        const normalized = candidate.replace(/\.ets$/, '');
        if (sourceSet.has(normalized)) {
          out.add(normalized);
          break;
        }
      }
    } else if (MODULE_NAMES.has(specifier)) {
      out.add(`${specifier}:Index`);
    }
  }
  return out;
}

// Build the full import graph up front.
const graph = new Map();
for (const id of sources) {
  graph.set(id, importsOf(id));
}

// Roots: the union of every module's compiled set from the last build; or,
// without any build output, every registered page plus each module root.
const roots = new Set();
let mapsFound = 0;
for (const moduleName of MODULES) {
  const sourceMap = join(
    ROOT, moduleName, 'build', 'default', 'intermediates', 'loader_out', 'default', 'ets', 'sourceMaps.map',
  );
  if (!existsSync(sourceMap)) {
    continue;
  }
  mapsFound += 1;
  const map = readFileSync(sourceMap, 'utf8');
  for (const match of map.matchAll(/([\w.-]+)\/src\/main\/ets\/([^"]+?)\.ets"/g)) {
    roots.add(`${match[1]}:src/main/ets/${match[2]}`);
  }
  for (const match of map.matchAll(/([\w.-]+)\/Index\.ets"/g)) {
    roots.add(`${match[1]}:Index`);
  }
}
if (mapsFound === 0) {
  console.log('no build output found; rooting the import graph at the page registrations instead');
  for (const moduleName of MODULES) {
    const moduleRoot = join(ROOT, moduleName);
    const mainPages = join(moduleRoot, 'src', 'main', 'resources', 'base', 'profile', 'main_pages.json');
    if (existsSync(mainPages)) {
      const pages = JSON.parse(readFileSync(mainPages, 'utf8')).src;
      for (const page of pages) {
        const id = `${moduleName}:src/main/${page}`.split('\\').join('/');
        if (sourceSet.has(id)) {
          roots.add(id);
        }
      }
    }
    const routerMap = join(moduleRoot, 'src', 'main', 'resources', 'base', 'profile', 'router_map.json');
    if (existsSync(routerMap)) {
      const entries = JSON.parse(readFileSync(routerMap, 'utf8')).routerMap;
      for (const entry of entries) {
        if (typeof entry.pageSourceFile !== 'string') continue;
        const id = `${moduleName}:${entry.pageSourceFile}`.replace(/\.ets$/, '').split('\\').join('/');
        if (sourceSet.has(id)) {
          roots.add(id);
        }
      }
    }
    if (sourceSet.has(`${moduleName}:Index`)) {
      roots.add(`${moduleName}:Index`);
    }
  }
}

// BFS the import graph from the roots.
const visited = new Set([...roots].filter((id) => graph.has(id) || sourceSet.has(id)));
const queue = [...visited];
while (queue.length > 0) {
  const current = queue.pop();
  for (const next of graph.get(current) || []) {
    if (!visited.has(next)) {
      visited.add(next);
      queue.push(next);
    }
  }
}

const orphans = sources.filter((id) => !visited.has(id));
for (const id of orphans) {
  console.error(`not compiled and not imported (unreachable): ${id}.ets`);
}
console.log(`scanned ${sources.length} ETS file(s); roots=${roots.size}; unreachable=${orphans.length}`);
process.exitCode = orphans.length === 0 ? 0 : 1;
