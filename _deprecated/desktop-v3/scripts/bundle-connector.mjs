#!/usr/bin/env node
// Stage connector-v3 for the desktop app in `build/connector`:
//   dist/src/**.js            the compiled connector
//   node_modules/**           its production dependency closure (meshcall, ws, zod, ajv, and this platform's
//                             meshcall-router binary package)
//   desktop-entry.mjs         entry run with Electron's Node (ELECTRON_RUN_AS_NODE=1)
//
//   node scripts/bundle-connector.mjs
//   AA_DESKTOP_CONNECTOR_SRC=/path/to/connector-v3   use another checkout
//
// Electron runs it as Node, so no separate Node.js runtime is downloaded or shipped. Packaging for another
// OS / CPU needs that platform's `meshcall-router-<os>-<arch>` package installed in connector-v3.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const src = path.resolve(process.env.AA_DESKTOP_CONNECTOR_SRC ?? path.join(root, "..", "connector-v3"));
const target = path.join(root, "build", "connector");

function run(cmd, args, options = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}  (in ${options.cwd ?? process.cwd()})`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed (${result.status ?? result.signal})`);
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(path.join(src, "package.json"))) {
  console.error(`connector-v3 not found at ${src}`);
  process.exit(1);
}
// The dependency tree is copied from node_modules, so never let Yarn fall back to Plug'n'Play.
const yarnEnv = { ...process.env, YARN_NODE_LINKER: "node-modules" };
if (!existsSync(path.join(src, "node_modules"))) run("corepack", ["yarn", "install"], { cwd: src, env: yarnEnv });
run("corepack", ["yarn", "build"], { cwd: src, env: yarnEnv });

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** Directory of package `name` as Node would resolve it from `fromDir`, staying inside `src`. */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  while (dir.startsWith(src)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const packages = new Set();
function collect(fromDir, deps, optional) {
  for (const name of Object.keys(deps ?? {})) {
    const dir = resolvePackageDir(name, fromDir);
    if (!dir) {
      if (optional) continue;
      console.error(`missing dependency ${name} (from ${path.relative(src, fromDir) || "connector-v3"})`);
      process.exit(1);
    }
    if (packages.has(dir)) continue;
    packages.add(dir);
    const manifest = readJson(path.join(dir, "package.json"));
    collect(dir, manifest.dependencies, false);
    collect(dir, manifest.optionalDependencies, true);
  }
}

const manifest = readJson(path.join(src, "package.json"));
collect(src, manifest.dependencies, false);
collect(src, manifest.optionalDependencies, true);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(path.join(src, "dist", "src"), path.join(target, "dist", "src"), {
  recursive: true,
  filter: (file) => !file.endsWith(".d.ts") && !file.endsWith(".map"),
});
for (const dir of [...packages].sort()) {
  const rel = path.relative(src, dir);
  cpSync(dir, path.join(target, rel), {
    recursive: true,
    // Nested node_modules are staged on their own (only what the closure needs).
    filter: (file) => !path.relative(dir, file).split(path.sep).includes("node_modules"),
  });
}
writeFileSync(
  path.join(target, "package.json"),
  `${JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: "module", main: "dist/src/index.js" }, null, 2)}\n`,
);
writeFileSync(
  path.join(target, "desktop-entry.mjs"),
  `// Desktop entry for the bundled connector-v3, run with Electron's Node (ELECTRON_RUN_AS_NODE=1).
// Agents started by the connector must not inherit ELECTRON_RUN_AS_NODE (Electron-based CLIs would break).
delete process.env.ELECTRON_RUN_AS_NODE;

// Exit with the desktop app even if it dies without stopping us (the local Router follows: it shuts down
// when our stdin pipe to it closes).
const parent = process.ppid;
const watchdog = setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    clearInterval(watchdog);
    process.kill(process.pid, "SIGTERM");
  }
}, 5000);
watchdog.unref();

await import("./dist/src/cli.js");
`,
);

const routers = [...packages].filter((dir) => path.basename(dir).startsWith("meshcall-router-")).map((dir) => path.basename(dir));
console.log(`connector bundle → ${path.relative(root, target)} (${packages.size} packages; router: ${routers.join(", ") || "none"})`);
if (routers.length === 0) console.warn("warning: no meshcall-router binary package found; Local-First mode will not start");
