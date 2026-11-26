#!/usr/bin/env node
// Build the web-v3 workbench as a static export for the desktop app and copy it to `build/web`.
//
//   node scripts/build-web.mjs            build ../web-v3 with AA_DESKTOP_EXPORT=1
//   AA_DESKTOP_WEB_SRC=/path/to/web-v3    use another checkout
//
// The desktop build uses its own dist dir, `web-v3/.next-desktop` (a static export is written there), so a
// running `next dev` in web-v3 is not disturbed.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const webSrc = path.resolve(process.env.AA_DESKTOP_WEB_SRC ?? path.join(root, "..", "web-v3"));
const target = path.join(root, "build", "web");

function run(cmd, args, options = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}  (in ${options.cwd ?? process.cwd()})`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed (${result.status ?? result.signal})`);
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(path.join(webSrc, "package.json"))) {
  console.error(`web-v3 not found at ${webSrc}`);
  process.exit(1);
}
if (!existsSync(path.join(webSrc, "node_modules"))) run("corepack", ["yarn", "install"], { cwd: webSrc });

const out = path.join(webSrc, ".next-desktop");
rmSync(out, { recursive: true, force: true });
run("corepack", ["yarn", "build"], {
  cwd: webSrc,
  env: { ...process.env, AA_DESKTOP_EXPORT: "1", NEXT_TELEMETRY_DISABLED: "1" },
});
if (!existsSync(path.join(out, "index.html"))) {
  console.error(`static export missing: ${out}/index.html`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(out, target, { recursive: true, filter: (src) => !src.endsWith(".map") });
console.log(`web bundle → ${path.relative(root, target)}`);
