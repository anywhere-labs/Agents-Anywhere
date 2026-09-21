/**
 * Shared harness for the HarmonyOS pure-logic checks.
 *
 * The checks run the **real** `.ets` sources on Node instead of a re-typed copy,
 * so a check cannot drift away from the shipped code. `loadModule` mirrors a
 * module and everything it imports into `.generated/`, rewriting the relative
 * specifiers so Node's type-stripping loader can run the result.
 *
 * Two kinds of check exist and both are wanted:
 *   - behavioural: `loadModule(...)` then assert on real return values;
 *   - structural:  `readSource(...)` then assert on the rule table in the source
 *     (see `placeholder-check.mjs`) — for rules whose expression is a table, not
 *     a function.
 *
 * Run everything with `node tools/logic-checks/run.mjs`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = normalize(join(HERE, '..', '..'));
export const SRC_ROOT = join(REPO, 'entry', 'src', 'main', 'ets');
const GENERATED = join(HERE, '.generated');

/** The raw text of a source module, for structural checks. */
export function readSource(relPath) {
  return readFileSync(join(SRC_ROOT, relPath), 'utf8');
}

/**
 * Node's type stripping rejects `enum`, so the transcribe step turns one into a
 * frozen object with the same member names and values.
 */
function enumToConst(text) {
  return text.replace(/export enum (\w+) \{([\s\S]*?)\n\}/g, (match, name, body) => {
    const entries = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('/**') && !line.startsWith('*')
        && !line.startsWith('//'))
      .map((line) => line.replace(/,$/, ''))
      .filter((line) => line.includes('='))
      .map((line) => line.replace(/\s*=\s*/, ': '));
    return `export const ${name} = Object.freeze({ ${entries.join(', ')} });`;
  });
}

/**
 * The bindings a module really exports at runtime, or `null` when the text
 * re-exports a whole module and the question cannot be answered locally.
 *
 * Node's type stripping erases an `interface` (and a `type` alias) but leaves
 * the `import { SomeInterface }` that mentioned it, and the link then fails with
 * "does not provide an export named ...". `workspacePathKey`-style ports import
 * their DTO types from sibling modules, so the mirror has to know which names
 * survive type stripping before it can rewrite such an import.
 */
function runtimeExports(text) {
  if (/(?:^|\n)\s*export\s+(?:\*|\{[^}]*\}\s*from)/.test(text)) {
    return null;
  }
  const names = new Set();
  const declared =
    /(?:^|\n)\s*export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = declared.exec(text)) !== null) {
    names.add(match[1]);
  }
  const listed = /(?:^|\n)\s*export\s*\{([^}]*)\}/g;
  while ((match = listed.exec(text)) !== null) {
    for (const raw of match[1].split(',')) {
      const entry = raw.trim();
      if (entry.length === 0 || /^type\s/.test(entry)) {
        continue;
      }
      const aliased = entry.split(/\s+as\s+/);
      names.add((aliased[1] ?? aliased[0]).trim());
    }
  }
  if (/(?:^|\n)\s*export\s+default\b/.test(text)) {
    names.add('default');
  }
  return names;
}

/**
 * Drops the named imports a target module cannot provide at runtime.
 *
 * The target is always a sibling already written by `mirror`, so its generated
 * text is the truth about what type stripping left behind. A binding that is
 * gone was a type; keeping it would abort the whole check with a link error.
 */
function eraseTypeImports(text, rel) {
  return text.replace(
    /import\s+([^;]+?)\s+from\s+'(\.[^']+)';/g,
    (match, spec, from) => {
      const rest = spec.trim();
      if (rest.startsWith('type ') || !rest.includes('{')) {
        return match;
      }
      const target = normalize(join(GENERATED, dirname(rel), from));
      if (!existsSync(target)) {
        return match;
      }
      const exported = runtimeExports(readFileSync(target, 'utf8'));
      if (exported === null) {
        return match;
      }
      const braces = /^([\s\S]*?)\{([\s\S]*)\}([\s\S]*)$/.exec(rest);
      const kept = braces[2]
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !/^type\s/.test(part)
          && exported.has(part.split(/\s+as\s+/)[0].trim()));
      const head = braces[1].trim().replace(/,$/, '').trim();
      const tail = braces[3].trim();
      const parts = [
        head,
        kept.length > 0 ? `{ ${kept.join(', ')} }` : '',
        tail,
      ].filter((part) => part.length > 0);
      if (parts.length === 0) {
        return `import '${from}';`;
      }
      return `import ${parts.join(', ')} from '${from}';`;
    },
  );
}

const mirrored = new Set();

/**
 * Copies `relPath` and its full relative-import closure into `.generated/`,
 * keeping the tree shape so the rewritten specifiers resolve.
 */
function mirror(relPath) {
  const rel = normalize(relPath).replace(/\\/g, '/');
  if (mirrored.has(rel)) {
    return;
  }
  mirrored.add(rel);
  const source = join(SRC_ROOT, rel);
  if (!existsSync(source)) {
    throw new Error(`no such module: ${rel}`);
  }
  let text = readFileSync(source, 'utf8');
  text = text.replace(
    /import\s+([^;]+?)\s+from\s+'(\.[^']+)';/g,
    (match, spec, from) => {
      const depRel = normalize(join(dirname(rel), from)).replace(/\\/g, '/');
      const depWithExt = depRel.endsWith('.ets') ? depRel : `${depRel}.ets`;
      mirror(depWithExt);
      const target = depWithExt.replace(/\.ets$/, '.ts');
      let specifier = relative(dirname(rel), target).replace(/\\/g, '/');
      if (!specifier.startsWith('.')) {
        specifier = `./${specifier}`;
      }
      return `import ${spec} from '${specifier}';`;
    },
  );
  const out = join(GENERATED, rel.replace(/\.ets$/, '.ts'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, eraseTypeImports(enumToConst(text), rel), 'utf8');
}

/** Imports the real module through that mirror; returns the module namespace. */
export async function loadModule(relPath) {
  mirror(relPath);
  const rel = normalize(relPath).replace(/\\/g, '/');
  const target = join(GENERATED, rel.replace(/\.ets$/, '.ts'));
  return import(`file:///${target.replace(/\\/g, '/')}`);
}

let failures = 0;
let passes = 0;

/** Asserts deep equality; prints one line per assertion. */
export function expect(label, actual, wanted) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (ok) {
    passes++;
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`);
    console.log(`         actual: ${JSON.stringify(actual)}`);
    console.log(`         wanted: ${JSON.stringify(wanted)}`);
  }
}

/** Asserts a predicate the caller already evaluated. */
export function expectTrue(label, condition) {
  expect(label, condition === true, true);
}

export function suite(name) {
  console.log(`\n== ${name}`);
}

/** Ends the process with a non-zero code when anything failed. */
export function finish() {
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}
