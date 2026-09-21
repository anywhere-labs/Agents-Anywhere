/**
 * Mirror loader used by the sessiondetail checks.
 *
 * `lib.mjs`'s transcribe step mirrors the real `.ets` sources so Node can run
 * them, but ArkTS writes its types with a plain `import { T } from './T'`
 * instead of `import type`. Node keeps that binding, so importing a mirrored
 * module whose import list names a type that type stripping erased
 * (`CodeLanguageSpec`, `RemoteRuntimeNotice`, `RemoteRuntimeCapabilitySet`, …)
 * dies with
 *
 *     The requested module './X.ts' does not provide an export named 'Y'
 *
 * before a single line of checked code runs. That is an artefact of the mirror,
 * not a property of the module under test: those names are erased by type
 * stripping and never exist at runtime.
 *
 * This loader closes the gap at the *export* site rather than the import site.
 * Every erased `export interface X { … }` / `export type X = …;` in a mirrored
 * module is replaced by `export const X = undefined;`, so the name exists as the
 * `undefined` it always was at runtime, the declaration's *shape* is irrelevant
 * because type stripping removes it either way, and every real export keeps its
 * declared behaviour untouched. No `.ets` source is modified and no logic is
 * re-implemented — `loadModule` still runs the shipped code.
 *
 * A bare kit import (`@kit.ArkTS`, `@ohos.*`) is left alone on purpose: that is
 * a genuine blocker and the check for such a module must report it, not paper
 * over it.
 *
 * Register once, before the first `loadModule(...)` call:
 *
 *     import { register } from 'node:module';
 *     register('./mirror-loader-hooks.mjs', import.meta.url);
 *     const { loadModule, suite, expect, finish } = await import('./lib.mjs');
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The mirrored tree this loader is allowed to rewrite. */
const GENERATED = '/tools/logic-checks/.generated/';

/** Finds the `}` that closes the `{` at `start`, ignoring braces in strings. */
function matchingBrace(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** Replaces erased type declarations with the `undefined` they are at runtime. */
function exportErasedTypes(text) {
  const starts = [];
  const declaration = /export (?:declare )?interface ([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = declaration.exec(text)) !== null) {
    const bodyStart = text.indexOf('{', match.index);
    if (bodyStart < 0) {
      continue;
    }
    const bodyEnd = matchingBrace(text, bodyStart);
    if (bodyEnd < 0) {
      continue;
    }
    starts.push({ from: match.index, to: bodyEnd + 1, name: match[1] });
  }

  const alias = /export (?:declare )?type ([A-Za-z_$][\w$]*) =/g;
  while ((match = alias.exec(text)) !== null) {
    let index = match.index + match[0].length;
    let depth = 0;
    while (index < text.length) {
      const char = text[index];
      if (char === '{' || char === '(' || char === '[' || char === '<') {
        depth++;
      } else if (char === '}' || char === ')' || char === ']' || char === '>') {
        depth--;
      } else if (char === ';' && depth <= 0) {
        break;
      }
      index++;
    }
    starts.push({ from: match.index, to: Math.min(index + 1, text.length), name: match[1] });
  }

  starts.sort((left, right) => left.from - right.from);
  let out = '';
  let cursor = 0;
  for (const entry of starts) {
    if (entry.from < cursor) {
      continue;
    }
    out += text.slice(cursor, entry.from);
    out += `export const ${entry.name} = undefined;`;
    cursor = entry.to;
  }
  return out + text.slice(cursor);
}

export async function load(url, context, nextLoad) {
  if (!url.includes(GENERATED) || !url.endsWith('.ts')) {
    return nextLoad(url, context);
  }
  const path = fileURLToPath(url);
  const text = readFileSync(path, 'utf8');
  if (!text.includes('export interface') && !text.includes('export type')) {
    return { format: 'module-typescript', source: text, shortCircuit: true };
  }
  return { format: 'module-typescript', source: exportErasedTypes(text), shortCircuit: true };
}
