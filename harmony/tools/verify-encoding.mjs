// Encoding guard: text sources are checked for a BOM, a replacement
// character, or mojibake before a round is called done. On Windows a
// PowerShell ANSI round trip can silently corrupt every non-ASCII string,
// and a BOM breaks hvigor's JSON5 parsing of the first line.
//
// Scans every module of the six-module project (module sources, module
// resources, module-root Index.ets), plus AppScope, docs, tools, hvigor
// config and the root-level build files.
//
// Usage (from the harmony project root):
//   node tools/verify-encoding.mjs

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = ['common', 'network', 'session', 'terminal', 'files', 'entry'];
const ROOTS = [
  ...MODULES.map((name) => join(name, 'src', 'main')),
  ...MODULES.map((name) => join(name, 'Index.ets')),
  'AppScope',
  'docs',
  'tools',
  'hvigor',
  'hvigorfile.ts',
  'build-profile.json5',
  'oh-package.json5',
  'code-linter.json5',
];
const SKIP = new Set(['build', 'node_modules', '.hvigor', '.idea', 'oh_modules']);
const TEXT = /\.(ets|ts|json|json5|mjs|md)$/;

const files = [];
function walk(entryPath) {
  if (!existsSync(entryPath)) {
    return;
  }
  const stats = statSync(entryPath);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(entryPath)) {
      const path = join(entryPath, entry);
      if (statSync(path).isDirectory()) {
        if (!SKIP.has(entry)) {
          walk(path);
        }
      } else if (TEXT.test(entry)) {
        files.push(path);
      }
    }
  } else if (TEXT.test(entryPath)) {
    files.push(entryPath);
  }
}
for (const root of ROOTS) {
  walk(join(HERE, '..', root));
}

let bom = 0;
let replacement = 0;
let mojibake = 0;
for (const file of files) {
  const bytes = readFileSync(file);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    console.log('BOM', file);
    bom++;
  }
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD')) {
    console.log('REPLACEMENT', file);
    replacement++;
  }
  if (/[\u00c3\u00c2][\u0080-\u00bf]/.test(text)) {
    console.log('MOJIBAKE', file);
    mojibake++;
  }
}
console.log(`scanned ${files.length} text files; BOM=${bom} replacement=${replacement} mojibake=${mojibake}`);
process.exitCode = bom + replacement + mojibake === 0 ? 0 : 1;
