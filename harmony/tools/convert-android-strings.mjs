#!/usr/bin/env node
/*
 * Converts the Android string resources into HarmonyOS resource JSON.
 *
 * Why this exists
 * ---------------
 * The HarmonyOS client must show the same copy as the Android client, so the
 * strings under android/app/src/main/res/values* are the source of truth. They
 * are converted mechanically rather than retyped, and this conversion is
 * re-runnable so later Android string changes can be pulled in with one command.
 *
 * Placeholder policy
 * ------------------
 * Android uses positional placeholders (%1$s, %2$d) so translators may reorder
 * them. HarmonyOS resource formatting is documented inconsistently on whether it
 * honours that syntax, so this script does not rely on it: positional
 * placeholders are rewritten to appearance-order sequential ones (%s / %d).
 *
 * That rewrite is only sound when a string lists its placeholders in ascending
 * index order, which is what the runtime argument list assumes. The script
 * asserts that for every locale and every string, then fails the run with a
 * precise report instead of silently rendering wrong copy.
 *
 * Usage (from the repository root):
 *   node harmony/tools/convert-android-strings.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const ANDROID_RES = join(REPO, 'android', 'app', 'src', 'main', 'res');
const HARMONY_RES = join(HERE, '..', 'entry', 'src', 'main', 'resources');

/** Locale folders mapped to their Android source and HarmonyOS target roots. */
const LOCALES = [
  { label: 'en', androidDir: 'values', harmonyDir: join(HARMONY_RES, 'base', 'element') },
  { label: 'zh-CN', androidDir: 'values-zh-rCN', harmonyDir: join(HARMONY_RES, 'zh_CN', 'element') },
];

/** Android resource files merged into the single HarmonyOS string set. */
const SOURCE_FILES = ['strings.xml', 'archive_strings.xml', 'device_pairing_strings.xml'];

/**
 * Names intentionally not copied into the module string table.
 *
 * `app_name` is declared by `AppScope/resources/base/element/string.json`, which
 * is the application label HarmonyOS resolves for `$r('app.string.app_name')`.
 * Declaring it again at module level makes restool report a name conflict, and
 * the AppScope value is the one that must win, so the Android copy is dropped
 * rather than duplicated. The two values are identical, so no copy is lost.
 */
const SKIPPED_NAMES = new Set(['app_name']);

const POSITIONAL = /%(\d+)\$([sdif])/g;
const SEQUENTIAL = /%[sdif]/g;
const LITERAL_PERCENT = /%%/g;

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // &amp; last so "&amp;lt;" does not collapse into "<".
    .replace(/&amp;/g, '&');
}

function decodeAndroidEscapes(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_, escaped) => {
    if (escaped.startsWith('u')) {
      return String.fromCodePoint(parseInt(escaped.slice(1), 16));
    }
    switch (escaped) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case "'": return "'";
      case '"': return '"';
      case '\\': return '\\';
      case '@': return '@';
      case '?': return '?';
      default: return escaped;
    }
  });
}

/** Normalizes one raw Android resource value into its final display text. */
function normalize(raw) {
  let text = raw;
  const trimmed = text.trim();
  // Android treats a fully quoted value as literal and otherwise trims.
  text = trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1)
    : trimmed;
  text = decodeEntities(text);
  text = decodeAndroidEscapes(text);
  // HarmonyOS does not un-escape a literal percent sign, so collapse "%%".
  return text.replace(LITERAL_PERCENT, '%');
}

function stripHtmlTags(text) {
  return text.replace(/<[^>]+>/g, '');
}

/**
 * Describes the placeholder layout of one string.
 *
 * `declared` is the order the positional indices appear in the text, `sorted`
 * is those same indices ascending, and `sequential` is the rewritten value.
 */
function analyzePlaceholders(original) {
  const positional = [...original.matchAll(POSITIONAL)].map((m) => Number(m[1]));
  const sequential = original.replace(POSITIONAL, (_, _index, spec) => `%${spec}`);
  const uniqueDeclared = [...new Set(positional)];
  const sorted = [...uniqueDeclared].sort((a, b) => a - b);
  const expected = Array.from({ length: sorted.length }, (_, i) => i + 1);
  return {
    positional,
    uniqueDeclared,
    sorted,
    // Total placeholder slots, which is what a call site must supply. A string
    // may legitimately reference the same argument twice, e.g. "%1$s ... %1$s".
    occurrenceCount: positional.length,
    sequentialCount: (sequential.match(SEQUENTIAL) ?? []).length,
    // A string is safe to rewrite when it uses exactly the indices 1..n and
    // lists them in ascending order.
    ascending: uniqueDeclared.join(',') === sorted.join(','),
    contiguousFromOne: sorted.join(',') === expected.join(','),
    sequential,
  };
}

function parseResources(xml) {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  const strings = new Map();
  const plurals = new Map();

  for (const match of withoutComments.matchAll(/<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) {
    strings.set(match[1], stripHtmlTags(normalize(match[2])));
  }
  for (const match of withoutComments.matchAll(/<plurals\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/plurals>/g)) {
    const items = new Map();
    for (const item of match[2].matchAll(/<item\s+quantity="([^"]+)"[^>]*>([\s\S]*?)<\/item>/g)) {
      items.set(item[1], stripHtmlTags(normalize(item[2])));
    }
    plurals.set(match[1], items);
  }
  return { strings, plurals };
}

function loadLocale(locale) {
  const merged = { strings: new Map(), plurals: new Map() };
  for (const file of SOURCE_FILES) {
    let xml;
    try {
      xml = readFileSync(join(ANDROID_RES, locale.androidDir, file), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseResources(xml);
    for (const [name, value] of parsed.strings) {
      if (merged.strings.has(name)) {
        throw new Error(`duplicate string "${name}" while merging ${locale.androidDir}/${file}`);
      }
      merged.strings.set(name, value);
    }
    for (const [name, items] of parsed.plurals) {
      merged.plurals.set(name, items);
    }
  }
  return merged;
}

function main() {
  const problems = [];
  const stringOutput = new Map();
  const pluralOutput = new Map();
  const shapes = new Map();

  for (const locale of LOCALES) {
    const data = loadLocale(locale);
    const strings = [];
    const shapesForLocale = new Map();

    for (const [name, raw] of data.strings) {
      if (SKIPPED_NAMES.has(name)) {
        continue;
      }
      const analysis = analyzePlaceholders(raw);
      if (!analysis.ascending || !analysis.contiguousFromOne) {
        problems.push(
          `${locale.label}: "${name}" declares placeholders ${JSON.stringify(analysis.uniqueDeclared)} `
          + `and cannot be rewritten to appearance-order %s safely`,
        );
      }
      shapesForLocale.set(name, analysis.occurrenceCount);
      strings.push({ name, value: analysis.sequential });
    }
    shapes.set(locale.label, shapesForLocale);
    stringOutput.set(locale.label, { string: strings });

    const plurals = [];
    for (const [name, items] of data.plurals) {
      // HarmonyOS plural resources take an array of { quantity, value } entries;
      // restool rejects the Android map form with "Expected type: array".
      const value = [];
      for (const [quantity, raw] of items) {
        const analysis = analyzePlaceholders(raw);
        if (!analysis.ascending || !analysis.contiguousFromOne) {
          problems.push(
            `${locale.label}: plural "${name}" (${quantity}) declares placeholders `
            + `${JSON.stringify(analysis.uniqueDeclared)} and cannot be rewritten safely`,
          );
        }
        value.push({ quantity, value: analysis.sequential });
      }
      plurals.push({ name, value });
    }
    pluralOutput.set(locale.label, { plural: plurals });
  }

  // Every locale must agree on how many arguments each string takes.
  const baseShapes = shapes.get('en');
  for (const locale of LOCALES) {
    if (locale.label === 'en') continue;
    const other = shapes.get(locale.label);
    for (const [name, count] of baseShapes) {
      const otherCount = other.get(name);
      if (otherCount === undefined) {
        problems.push(`${locale.label}: missing string "${name}"`);
      } else if (otherCount !== count) {
        problems.push(`${locale.label}: "${name}" takes ${otherCount} argument(s), en takes ${count}`);
      }
    }
    for (const name of other.keys()) {
      if (!baseShapes.has(name)) problems.push(`${locale.label}: extra string "${name}"`);
    }
  }

  if (problems.length > 0) {
    console.error('String conversion problems — resolve before shipping:');
    for (const line of problems) console.error(`  - ${line}`);
    process.exitCode = 1;
    return;
  }

  let pluralTotal = 0;
  for (const locale of LOCALES) {
    mkdirSync(locale.harmonyDir, { recursive: true });
    const strings = stringOutput.get(locale.label);
    writeFileSync(join(locale.harmonyDir, 'app_strings.json'), `${JSON.stringify(strings, null, 2)}\n`, 'utf8');

    const plurals = pluralOutput.get(locale.label);
    pluralTotal = plurals.plural.length;
    if (pluralTotal > 0) {
      writeFileSync(join(locale.harmonyDir, 'app_plurals.json'), `${JSON.stringify(plurals, null, 2)}\n`, 'utf8');
    }
    console.log(`${locale.label}: ${strings.string.length} strings, ${pluralTotal} plural(s) -> ${locale.harmonyDir}`);
  }

  const withArgs = [...baseShapes.values()].filter((count) => count > 0).length;
  console.log(`done: ${withArgs} string(s) take arguments`);

  verifyOutputs(baseShapes);
}

/**
 * Re-reads what was written so a broken resource file fails here instead of
 * inside the ArkTS compiler.
 */
function verifyOutputs(baseShapes) {
  for (const locale of LOCALES) {
    const stringsPath = join(locale.harmonyDir, 'app_strings.json');
    const parsed = JSON.parse(readFileSync(stringsPath, 'utf8'));
    if (!Array.isArray(parsed.string)) throw new Error(`${stringsPath}: missing "string" array`);

    const seen = new Set();
    for (const entry of parsed.string) {
      if (typeof entry.name !== 'string' || !/^[A-Za-z0-9_]+$/.test(entry.name)) {
        throw new Error(`${stringsPath}: invalid resource name ${JSON.stringify(entry.name)}`);
      }
      if (seen.has(entry.name)) throw new Error(`${stringsPath}: duplicate name "${entry.name}"`);
      seen.add(entry.name);
      if (typeof entry.value !== 'string') {
        throw new Error(`${stringsPath}: "${entry.name}" has a non-string value`);
      }
      if (/%\d+\$/.test(entry.value)) {
        throw new Error(`${stringsPath}: "${entry.name}" still contains a positional placeholder`);
      }
      const expected = baseShapes.get(entry.name);
      const actual = (entry.value.match(/%[sdif]/g) ?? []).length;
      if (expected !== undefined && expected !== actual) {
        throw new Error(
          `${stringsPath}: "${entry.name}" has ${actual} placeholder(s), expected ${expected}`,
        );
      }
    }
    const pluralPath = join(locale.harmonyDir, 'app_plurals.json');
    try {
      const plural = JSON.parse(readFileSync(pluralPath, 'utf8'));
      if (!Array.isArray(plural.plural)) throw new Error(`${pluralPath}: missing "plural" array`);
      for (const entry of plural.plural) {
        if (!Array.isArray(entry.value)) {
          throw new Error(`${pluralPath}: "${entry.name}" value must be an array`);
        }
        for (const item of entry.value) {
          if (typeof item.quantity !== 'string' || typeof item.value !== 'string') {
            throw new Error(`${pluralPath}: "${entry.name}" has an invalid quantity entry`);
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    console.log(`${locale.label}: verified ${parsed.string.length} string(s)`);
  }
}

main();
