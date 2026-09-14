// Encoding guard: the port has twice been corrupted by an ANSI round trip
// through PowerShell, so every text source is checked for a BOM, a replacement
// character, or mojibake before a round is called done.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['entry/src/main/ets', 'entry/src/main/resources', 'AppScope', 'tools'];
const SKIP = new Set(['build', 'node_modules', '.hvigor', 'oh_modules']);
const TEXT = /\.(ets|ts|json|json5|mjs|md)$/;

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) {
        walk(path);
      }
    } else if (TEXT.test(entry.name)) {
      files.push(path);
    }
  }
}
for (const root of ROOTS) {
  walk(root);
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
