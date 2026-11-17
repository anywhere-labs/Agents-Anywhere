/**
 * Pre-installs the Pi ACP adapter and SDK into `build/pi-runtime`, packaged as
 * `resources/pi-runtime`. The Connector copies it into its npm cache instead
 * of downloading Node and npm packages on first launch, and runs it with the
 * Desktop's own Electron as Node.
 *
 * The package list is the Connector's own `dependencies.json`, so the bundle
 * matches what the Connector would install; it ignores a bundle whose list
 * differs and falls back to the network.
 */

import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exists, runtimeTargetKey } from "./bundle-targets.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEPENDENCIES_FILE = join(PROJECT_ROOT, "..", "connector-ts", "src", "runtime", "profiles", "pi", "dependencies.json");
const OUTPUT_ROOT = process.env.WORKBENCH_PI_BUNDLE_DIR?.trim()
  ? resolve(process.env.WORKBENCH_PI_BUNDLE_DIR.trim())
  : join(PROJECT_ROOT, "build", "pi-runtime");
const REGISTRY = (process.env.PI_BUNDLE_NPM_REGISTRY?.trim() || "https://registry.npmjs.org").replace(/\/+$/, "");
const STAMP = "PI_RUNTIME.json";

/** The same flags the Connector uses: no install scripts, no lockfile, production only. */
const NPM_ARGS = ["install", "--omit=dev", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund"];

function npm(args, cwd) {
  const windows = process.platform === "win32";
  // npm.cmd needs cmd.exe; every argument here is a plain flag without spaces.
  const result = spawnSync(windows ? "npm.cmd" : "npm", args, { cwd, stdio: "inherit", shell: windows });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} exited with ${result.status ?? "null"}`);
}

/**
 * Prebuilt native modules ship for every platform (pi-tui carries Linux,
 * macOS and Windows builds). Keep only the targets being packaged: fewer
 * bytes, and macOS signing never meets a foreign binary. CLI shims go too.
 */
async function pruneBundle(directory, targets) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(directory, entry.name);
    if (entry.name === ".bin") {
      // CLI shims are symlinks on POSIX and unused here: Pi starts from its
      // entry script, and links complicate signing and universal merges.
      await rm(child, { recursive: true, force: true });
    } else if (entry.name === "prebuilds") {
      for (const build of await readdir(child)) {
        if (!targets.includes(build)) await rm(join(child, build), { recursive: true, force: true });
      }
    } else {
      await pruneBundle(child, targets);
    }
  }
}

function stampFor(dependencies, targets) {
  return JSON.stringify({ dependencies, targets: [...targets].sort(), registry: REGISTRY });
}

async function isCurrent(stamp) {
  try {
    return (await readFile(join(OUTPUT_ROOT, STAMP), "utf8")) === stamp
      && await exists(join(OUTPUT_ROOT, "package.json"))
      && await exists(join(OUTPUT_ROOT, "node_modules", "@openma", "pi-acp", "dist", "bin.js"));
  } catch {
    return false;
  }
}

export async function ensurePiRuntimeBundle({ targets = [runtimeTargetKey()], log = () => {} } = {}) {
  const dependencies = JSON.parse(await readFile(DEPENDENCIES_FILE, "utf8"));
  const stamp = stampFor(dependencies, targets);
  if (await isCurrent(stamp)) {
    log(`Reusing the bundled Pi runtime for ${targets.join(", ")}`);
    return OUTPUT_ROOT;
  }
  log(`Installing the Pi runtime for ${targets.join(", ")} from ${REGISTRY}`);
  const staging = `${OUTPUT_ROOT}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  // The Connector compares this manifest with its own list before using the bundle.
  await writeFile(join(staging, "package.json"), JSON.stringify({ private: true, dependencies }), "utf8");
  npm([...NPM_ARGS, `--registry=${REGISTRY}/`], staging);
  await pruneBundle(join(staging, "node_modules"), targets);
  await writeFile(join(staging, STAMP), stamp, "utf8");
  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await rename(staging, OUTPUT_ROOT);
  return OUTPUT_ROOT;
}

async function main() {
  const requested = process.env.PI_BUNDLE_TARGETS || runtimeTargetKey();
  const targets = requested.split(",").map((value) => value.trim()).filter(Boolean);
  await ensurePiRuntimeBundle({ targets, log: (message) => console.log(message) });
  console.log(`Bundled the Pi runtime for ${targets.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
