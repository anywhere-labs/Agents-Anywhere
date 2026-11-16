/**
 * Bundles the v3 TS Connector (`../connector-ts`) into `dist/connector/`, which
 * Desktop forks as an Electron utility process (v3 design 04-connector.md §9.4).
 *
 * Two entries: `desktop-main.js` (the Desktop host entry) and
 * `worker-entry.js` (the store's worker thread, loaded next to it through
 * `new URL("./worker-entry.js", import.meta.url)`). The output is ESM, so the
 * directory carries its own `package.json` with `"type": "module"`.
 *
 * It needs `connector-ts` dependencies installed (`cd ../connector-ts && yarn install`).
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONNECTOR_ROOT = resolve(process.env.WORKBENCH_CONNECTOR_SOURCE?.trim() || join(PROJECT_ROOT, "..", "connector-ts"));
const OUTPUT_DIR = join(PROJECT_ROOT, "dist", "connector");

// esbuild comes from the Connector's own dependencies, so both build the same sources the same way.
const requireFromConnector = createRequire(join(CONNECTOR_ROOT, "package.json"));
let esbuild;
try {
  esbuild = requireFromConnector("esbuild");
} catch {
  console.error(`esbuild was not found under ${CONNECTOR_ROOT}; run \`yarn install\` in connector-ts first.`);
  process.exit(1);
}

const connectorPackage = JSON.parse(await readFile(join(CONNECTOR_ROOT, "package.json"), "utf8"));
await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(OUTPUT_DIR, { recursive: true });
await esbuild.build({
  absWorkingDir: CONNECTOR_ROOT,
  entryPoints: {
    "desktop-main": join(CONNECTOR_ROOT, "src", "entry", "desktop-main.ts"),
    "worker-entry": join(CONNECTOR_ROOT, "src", "store", "worker-entry.ts"),
  },
  outdir: OUTPUT_DIR,
  bundle: true,
  format: "esm",
  platform: "node",
  // Electron 45 runs Node 22.
  target: "node22",
  sourcemap: "linked",
  logLevel: "warning",
  // Bundled CommonJS dependencies still call `require`.
  banner: { js: 'import { createRequire as __aaCreateRequire } from "node:module"; const require = __aaCreateRequire(import.meta.url);' },
});
await writeFile(join(OUTPUT_DIR, "package.json"), `${JSON.stringify({ type: "module", connector: connectorPackage.version }, null, 2)}\n`);
console.log(`Bundled the Connector from ${CONNECTOR_ROOT} into ${OUTPUT_DIR}`);
