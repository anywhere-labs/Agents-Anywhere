// Verifies every `$r('app.<kind>.<name>')` reference against the resource tables.
//
// hvigor does not fail a build for a resource name that does not exist: the
// reference compiles and only breaks (or renders blank) at runtime, on the
// device, in the one screen nobody opened during review. This check collects
// every reference in the ETS sources of every module, then confirms the name
// is declared in `resources/base` and — for strings and plurals, where a
// missing translation silently falls back — in the `en` and `zh_CN` tables
// too (this project keeps base / en / zh_CN in sync).
//
// Resource resolution follows the module type of this six-module project:
//   - HAP/HSP modules (entry, session, terminal, files) own their resource
//     table: `$r('app.*')` in their code resolves against their own module.
//   - HAR modules (common, network) are statically merged into each consumer,
//     so their references resolve against the union of all module tables.
//
// Usage (from the harmony project root):
//   node tools/verify-resource-usage.mjs

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = [
  { name: 'common', merged: true },
  { name: 'network', merged: true },
  { name: 'session', merged: false },
  { name: 'terminal', merged: false },
  { name: 'files', merged: false },
  { name: 'entry', merged: false },
];

const REFERENCE = /\$r\(\s*'app\.(string|plural|color|float|media|integer)\.([A-Za-z0-9_]+)'/g;

function listFiles(root, predicate) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (predicate(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Reads every `element/*.json` in a locale folder into one name set per kind. */
function readElementTables(localeDir) {
  const tables = { string: new Set(), plural: new Set(), color: new Set(), float: new Set(), integer: new Set() };
  const elementDir = join(localeDir, 'element');
  if (!existsSync(elementDir)) {
    return tables;
  }
  for (const file of listFiles(elementDir, (name) => name.endsWith('.json'))) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`${file}: invalid JSON (${error.message})`);
    }
    for (const kind of Object.keys(tables)) {
      const entries = parsed[kind];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry.name === 'string') tables[kind].add(entry.name);
      }
    }
  }
  return tables;
}

/** Media names resolve by file basename, without the extension. */
function readMediaNames(localeDir) {
  const names = new Set();
  const mediaDir = join(localeDir, 'media');
  if (!existsSync(mediaDir)) {
    return names;
  }
  for (const file of listFiles(mediaDir, () => true)) {
    const name = basename(file);
    names.add(name.replace(/\.[^.]+$/, ''));
  }
  return names;
}

/** Per-module resource tables: base / en / zh_CN. Media comes from base only. */
function readModuleTables(moduleName) {
  const resRoot = join(HERE, '..', moduleName, 'src', 'main', 'resources');
  const base = readElementTables(join(resRoot, 'base'));
  const en = readElementTables(join(resRoot, 'en'));
  const zh = readElementTables(join(resRoot, 'zh_CN'));
  base.media = readMediaNames(join(resRoot, 'base'));
  return { base, en, zh };
}

function unionTables(all) {
  const out = { base: {}, en: {}, zh: {} };
  for (const locale of Object.keys(out)) {
    for (const kind of ['string', 'plural', 'color', 'float', 'integer', 'media']) {
      const merged = new Set();
      for (const tables of all) {
        const table = tables[locale][kind];
        if (table !== undefined) {
          for (const name of table) merged.add(name);
        }
      }
      out[locale][kind] = merged;
    }
  }
  return out;
}

function main() {
  const moduleTables = new Map();
  for (const module of MODULES) {
    moduleTables.set(module.name, readModuleTables(module.name));
  }
  const mergedTables = unionTables([...moduleTables.values()]);

  const missing = [];
  const untranslated = [];
  let totalReferences = 0;
  let totalFiles = 0;
  const perModule = [];

  for (const module of MODULES) {
    const etsRoot = join(HERE, '..', module.name, 'src', 'main', 'ets');
    const tables = module.merged ? mergedTables : moduleTables.get(module.name);
    const sources = existsSync(etsRoot) ? listFiles(etsRoot, (name) => name.endsWith('.ets')) : [];
    let references = 0;

    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      const rel = `${module.name}/src/main/ets/${file.substring(etsRoot.length + 1).split('\\').join('/')}`;
      for (const match of text.matchAll(REFERENCE)) {
        references += 1;
        const kind = match[1];
        const name = match[2];
        const table = tables.base[kind];
        if (table === undefined || !table.has(name)) {
          missing.push(`${rel}: app.${kind}.${name}`);
          continue;
        }
        // Strings and plurals are the only kinds that need a translation.
        if ((kind === 'string' || kind === 'plural') && (!tables.en[kind].has(name) || !tables.zh[kind].has(name))) {
          untranslated.push(`${rel}: app.${kind}.${name}`);
        }
      }
    }

    totalReferences += references;
    totalFiles += sources.length;
    perModule.push(`${module.name}: ${references} reference(s) in ${sources.length} ETS file(s)`);
  }

  if (missing.length > 0) {
    console.error(`Resource references with no declaration (${missing.length}):`);
    for (const line of missing) console.error(`  - ${line}`);
    process.exitCode = 1;
    return;
  }
  if (untranslated.length > 0) {
    console.error(`Resources missing from en/zh_CN (${untranslated.length}):`);
    for (const line of untranslated) console.error(`  - ${line}`);
    process.exitCode = 1;
    return;
  }

  for (const line of perModule) console.log(line);
  console.log(`verified ${totalReferences} resource reference(s) across ${totalFiles} ETS file(s)`);
}

main();
