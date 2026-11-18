/**
 * Bundles the v3 TS Connector (`../connector-ts`) into `dist/connector/`, which
 * Desktop forks as an Electron utility process (v3 design 04-connector.md §9.4).
 *
 * Two entries: `desktop-main.js` (`connector-entry/desktop-main.mts`, connector-ts's
 * desktop-host with the features Desktop bundles binaries for) and
 * `worker-entry.js` (the store's worker thread, loaded next to it through
 * `new URL("./worker-entry.js", import.meta.url)`). The output is ESM, so the
 * directory carries its own `package.json` with `"type": "module"`.
 *
 * It needs `connector-ts` dependencies installed (`cd ../connector-ts && yarn install`).
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyBundleRuntimeFiles } from "../../connector-ts/scripts/bundle-runtime-files.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `connector-entry/` imports the Connector by relative path, so the source is always the sibling checkout.
const CONNECTOR_ROOT = join(PROJECT_ROOT, "..", "connector-ts");
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

// esbuild strips types without checking them; Desktop's entry is checked against the Connector here.
const tsc = spawnSync(process.execPath, [requireFromConnector.resolve("typescript/bin/tsc"), "-p", join(PROJECT_ROOT, "connector-entry")], { stdio: "inherit" });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const connectorPackage = JSON.parse(await readFile(join(CONNECTOR_ROOT, "package.json"), "utf8"));
await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(OUTPUT_DIR, { recursive: true });
await esbuild.build({
  absWorkingDir: CONNECTOR_ROOT,
  entryPoints: {
    // Desktop's own entry: connector-ts's desktop-host plus the port preview wiring.
    "desktop-main": join(PROJECT_ROOT, "connector-entry", "desktop-main.mts"),
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
copyBundleRuntimeFiles(CONNECTOR_ROOT, OUTPUT_DIR);
await writeFile(join(OUTPUT_DIR, "package.json"), `${JSON.stringify({ type: "module", connector: connectorPackage.version }, null, 2)}\n`);
console.log(`Bundled the Connector from ${CONNECTOR_ROOT} into ${OUTPUT_DIR}`);
