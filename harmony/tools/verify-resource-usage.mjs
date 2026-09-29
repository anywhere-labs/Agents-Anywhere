#!/usr/bin/env node
/*
 * Verifies every `$r('app.<kind>.<name>')` reference against the resource tables.
 *
 * Why this exists
 * ---------------
 * `hvigor` does not fail a build for a resource name that does not exist: the
 * reference compiles and only breaks (or renders blank) at runtime, on the
 * device, in the one screen nobody opened during review. With 764 strings across
 * two locales and dozens of screens still to port, that is the most likely way a
 * typo escapes.
 *
 * The check is deliberately mechanical: collect every reference in the ETS
 * sources, then confirm the name is declared in `resources/base` (and, for
 * strings and plurals, that `zh_CN` declares it too, since a missing translation
 * silently falls back to English).
 *
 * Usage (from the repository root or this directory):
 *   node harmony/tools/verify-resource-usage.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = join(HERE, '..', 'entry', 'src', 'main');
const ETS_ROOT = join(MODULE_ROOT, 'ets');
const RES_ROOT = join(MODULE_ROOT, 'resources');

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

function main() {
  const base = readElementTables(join(RES_ROOT, 'base'));
  const zh = readElementTables(join(RES_ROOT, 'zh_CN'));
  base.media = readMediaNames(join(RES_ROOT, 'base'));
  zh.media = new Set(base.media);

  const sources = listFiles(ETS_ROOT, (name) => name.endsWith('.ets'));
  const missing = [];
  const untranslated = [];
  let references = 0;

  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    const relative = file.substring(ETS_ROOT.length + 1);
    for (const match of text.matchAll(REFERENCE)) {
      references += 1;
      const kind = match[1];
      const name = match[2];
      const table = base[kind];
      if (table === undefined || !table.has(name)) {
        missing.push(`${relative}: app.${kind}.${name}`);
        continue;
      }
      // Strings and plurals are the only kinds that need a translation.
      if ((kind === 'string' || kind === 'plural') && !zh[kind].has(name)) {
        untranslated.push(`${relative}: app.${kind}.${name}`);
      }
    }
  }

  if (missing.length > 0) {
    console.error(`Resource references with no declaration (${missing.length}):`);
    for (const line of missing) console.error(`  - ${line}`);
    process.exitCode = 1;
    return;
  }
  if (untranslated.length > 0) {
    console.error(`Resources missing from zh_CN (${untranslated.length}):`);
    for (const line of untranslated) console.error(`  - ${line}`);
    process.exitCode = 1;
    return;
  }

  console.log(`verified ${references} resource reference(s) across ${sources.length} ETS file(s)`);
}

main();
