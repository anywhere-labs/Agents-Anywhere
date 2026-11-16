/**
 * Builds the local MeshCall Router the embedded Connector starts, into
 * `build/meshcall-router/<platform>-<arch>/meshcall-router[.exe]` (packaged as
 * `resources/meshcall-router`). It must match the vendored TS package
 * (`vendor/meshcall`, commit 9334405); MeshCall 0.4.0 has no release binaries
 * yet, so the Router is built from that commit with Go.
 *
 * `MESHCALL_SOURCE_DIR` points at an existing checkout; otherwise the commit is
 * cloned into `.cache/meshcall`. `ROUTER_BUNDLE_TARGETS` lists targets
 * (`darwin-arm64,darwin-x64`); the default is this machine.
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exists, runtimeTargetKey } from "./bundle-targets.mjs";

const MESHCALL_COMMIT = "93344059ada65735c6cc08fdf3247ea9fb808d6b";
const MESHCALL_REPOSITORY = "https://github.com/t4wefan/meshcall.git";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = join(PROJECT_ROOT, "build", "meshcall-router");
const STAMP = "ROUTER_COMMIT";
const GO_TARGETS = {
  "darwin-arm64": ["darwin", "arm64"],
  "darwin-x64": ["darwin", "amd64"],
  "linux-arm64": ["linux", "arm64"],
  "linux-x64": ["linux", "amd64"],
  "win32-arm64": ["windows", "arm64"],
  "win32-x64": ["windows", "amd64"],
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "null"}`);
}

async function source() {
  const explicit = process.env.MESHCALL_SOURCE_DIR?.trim();
  if (explicit) return resolve(explicit);
  const checkout = join(PROJECT_ROOT, ".cache", "meshcall");
  if (!(await exists(join(checkout, ".git")))) {
    await mkdir(dirname(checkout), { recursive: true });
    run("git", ["clone", "--filter=blob:none", MESHCALL_REPOSITORY, checkout]);
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).stdout?.trim();
  if (head !== MESHCALL_COMMIT) {
    run("git", ["fetch", "origin", MESHCALL_COMMIT], { cwd: checkout });
    run("git", ["checkout", "--detach", MESHCALL_COMMIT], { cwd: checkout });
  }
  return checkout;
}

async function isCurrent(outputDir, executable) {
  if (!(await exists(join(outputDir, executable)))) return false;
  try {
    return (await readFile(join(outputDir, STAMP), "utf8")).trim() === MESHCALL_COMMIT;
  } catch {
    return false;
  }
}

export async function ensureRouterBundle({ targets = [runtimeTargetKey()], log = () => {} } = {}) {
  const paths = [];
  let checkout = null;
  for (const target of targets) {
    const goTarget = GO_TARGETS[target];
    if (!goTarget) throw new Error(`Unsupported Router target: ${target}`);
    const executable = target.startsWith("win32") ? "meshcall-router.exe" : "meshcall-router";
    const outputDir = join(OUTPUT_ROOT, target);
    paths.push(join(outputDir, executable));
    if (await isCurrent(outputDir, executable)) continue;
    checkout ??= await source();
    log(`Building meshcall-router ${MESHCALL_COMMIT.slice(0, 7)} for ${target}`);
    await mkdir(outputDir, { recursive: true });
    run("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", join(outputDir, executable), "./cmd/meshcall-router"], {
      cwd: join(checkout, "meshcall-router"),
      env: { ...process.env, GOOS: goTarget[0], GOARCH: goTarget[1], CGO_ENABLED: "0" },
    });
    await writeFile(join(outputDir, STAMP), `${MESHCALL_COMMIT}\n`, "utf8");
  }
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const targets = (process.env.ROUTER_BUNDLE_TARGETS || runtimeTargetKey()).split(",").map(value => value.trim()).filter(Boolean);
  const paths = await ensureRouterBundle({ targets, log: message => console.log(message) });
  for (const value of paths) console.log(`meshcall-router: ${value}`);
}
