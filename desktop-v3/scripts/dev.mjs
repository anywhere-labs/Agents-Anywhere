#!/usr/bin/env node
// `yarn dev`: compile the main process, stage the web bundle and the connector when they are missing (or when
// `--rebuild` is passed), then start Electron. Extra arguments go to Electron, e.g.
//   yarn dev --user-data-dir=/tmp/aa-desktop --remote-debugging-port=9333

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const rebuild = args.includes("--rebuild");
const electronArgs = args.filter((a) => a !== "--rebuild");

function step(script) {
  const result = spawnSync(process.execPath, [path.join(here, script)], { stdio: "inherit", cwd: root });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tsc = spawnSync("corepack", ["yarn", "build:main"], { stdio: "inherit", cwd: root, shell: process.platform === "win32" });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
if (rebuild || !existsSync(path.join(root, "build", "web", "index.html"))) step("build-web.mjs");
if (rebuild || !existsSync(path.join(root, "build", "connector", "desktop-entry.mjs"))) step("bundle-connector.mjs");

const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, [".", ...electronArgs], { stdio: "inherit", cwd: root });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
