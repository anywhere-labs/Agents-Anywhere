import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { download, exists, run, runtimeTargetKey } from "./prepare-uv.mjs";

// The python-build-standalone CPython builds that uv itself installs.
const PYTHON_VERSION = process.env.PYTHON_BUNDLE_VERSION || "3.12.14";
const PBS_RELEASE = process.env.PYTHON_BUNDLE_RELEASE || "20260929";
const BUILD = `${PYTHON_VERSION}+${PBS_RELEASE}`;
const MINOR = PYTHON_VERSION.split(".").slice(0, 2).join(".");
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_ROOT = join(PROJECT_ROOT, ".cache", "python", BUILD);
const OUTPUT_ROOT = process.env.WORKBENCH_PYTHON_BUNDLE_DIR?.trim()
  ? resolve(process.env.WORKBENCH_PYTHON_BUNDLE_DIR.trim())
  : join(PROJECT_ROOT, "build", "python");
// A mirror must serve the release layout, including SHA256SUMS (npmmirror does).
const MIRROR = process.env.PYTHON_BUNDLE_MIRROR?.trim() || "https://github.com/astral-sh/python-build-standalone/releases/download";
const RELEASE_BASE = `${MIRROR.replace(/\/+$/, "")}/${PBS_RELEASE}`;

// `executable` must match what the Desktop supervisor resolves in each target directory.
const TARGETS = {
  "darwin-arm64": { triple: "aarch64-apple-darwin", executable: "bin/python3" },
  "darwin-x64": { triple: "x86_64-apple-darwin", executable: "bin/python3" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", executable: "bin/python3" },
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", executable: "bin/python3" },
  "win32-arm64": { triple: "aarch64-pc-windows-msvc", executable: "python.exe" },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", executable: "python.exe" },
};

/**
 * Entries the Connector never loads, as [directory, name pattern]: the Tk GUI
 * stack, IDLE, turtle demos, the embedding build config and the base
 * interpreter's own pip (uv creates the Connector environment without pip).
 * Dropping them also leaves fewer native libraries to sign on macOS.
 */
const PRUNE = {
  windows: [
    ["Lib", /^(idlelib|tkinter|turtledemo)$/],
    ["Lib/site-packages", /^pip(-.+\.dist-info)?$/],
    ["DLLs", /^(_tkinter\.pyd|tcl\d+t\.dll|tk\d+t\.dll)$/],
    [".", /^tcl$/],
  ],
  posix: [
    [`lib/python${MINOR}`, /^(idlelib|tkinter|turtledemo|config-.+)$/],
    [`lib/python${MINOR}/site-packages`, /^pip(-.+\.dist-info)?$/],
    [`lib/python${MINOR}/lib-dynload`, /^_tkinter\./],
    ["lib", /^(tcl\d|tk\d|itcl\d|thread\d|libtcl|libtk)/],
    ["bin", /^(idle3|pip)/],
  ],
};

function assetName(target) {
  return `cpython-${BUILD}-${target.triple}-install_only_stripped.tar.gz`;
}

async function expectedChecksum(asset) {
  const sums = join(CACHE_ROOT, "SHA256SUMS");
  await download(`${RELEASE_BASE}/SHA256SUMS`, sums);
  for (const line of (await readFile(sums, "utf8")).split(/\r?\n/)) {
    const [, hash, name] = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i) ?? [];
    if (name === asset) return hash.toLowerCase();
  }
  throw new Error(`SHA256SUMS of ${PBS_RELEASE} does not list ${asset}`);
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

/** Downloads once into the cache; a cached archive that fails the checksum is fetched again. */
async function downloadVerified(asset) {
  const archivePath = join(CACHE_ROOT, asset);
  const expected = await expectedChecksum(asset);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await download(`${RELEASE_BASE}/${asset}`, archivePath);
    if (await sha256(archivePath) === expected) return archivePath;
    await rm(archivePath, { force: true });
  }
  throw new Error(`Checksum mismatch for ${asset}`);
}

/** Windows ships bsdtar in System32; Git's GNU tar would read `C:\...` as a remote host. */
function tarCommand() {
  return process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
}

async function prune(root, rules) {
  for (const [directory, pattern] of rules) {
    const parent = join(root, directory);
    if (!(await exists(parent))) continue;
    for (const entry of await readdir(parent)) {
      if (pattern.test(entry)) await rm(join(parent, entry), { recursive: true, force: true });
    }
  }
}

async function prepareTarget(key) {
  const target = TARGETS[key];
  if (!target) throw new Error(`Unsupported Python bundle target: ${key}`);
  if (process.platform === "win32" && !key.startsWith("win32")) {
    // Their archives contain symlinks (bin/python3 -> python3.12) Windows cannot create.
    throw new Error(`Prepare the ${key} Python bundle on macOS or Linux, not Windows`);
  }
  const asset = assetName(target);
  const archivePath = await downloadVerified(asset);
  const extractDir = join(CACHE_ROOT, "extract", key);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await run(tarCommand(), ["-xzf", archivePath, "-C", extractDir]);
  const pythonRoot = join(extractDir, "python");
  await prune(pythonRoot, key.startsWith("win32") ? PRUNE.windows : PRUNE.posix);
  if (!(await exists(join(pythonRoot, target.executable)))) {
    throw new Error(`Could not find ${target.executable} in ${asset}`);
  }
  const outputDir = join(OUTPUT_ROOT, key);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(dirname(outputDir), { recursive: true });
  // Keep the interpreter's relative symlinks (bin/python3 -> python3.12) intact.
  await cp(pythonRoot, outputDir, { recursive: true, verbatimSymlinks: true });
  await writeFile(join(outputDir, "PYTHON_VERSION"), `${BUILD}\n`, "utf8");
}

async function isCurrent(outputDir, target) {
  if (!(await exists(join(outputDir, target.executable)))) return false;
  try {
    return (await readFile(join(outputDir, "PYTHON_VERSION"), "utf8")).trim() === BUILD;
  } catch {
    return false;
  }
}

/**
 * Guarantees the bundled CPython exists for the requested targets and returns
 * their interpreter paths. An already-current bundle is reused, and a cached
 * download is never repeated.
 */
export async function ensurePythonBundle({ targets = [runtimeTargetKey()], log = () => {} } = {}) {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const bundled = [];
  for (const key of targets) {
    const target = TARGETS[key];
    if (!target) throw new Error(`Unsupported Python bundle target: ${key}`);
    const outputDir = join(OUTPUT_ROOT, key);
    if (!(await isCurrent(outputDir, target))) {
      log(`Preparing bundled CPython ${BUILD} for ${key} (downloads once, then cached)`);
      await prepareTarget(key);
    }
    bundled.push(join(outputDir, target.executable));
  }
  return bundled;
}

async function prepareLicenses(targets) {
  const licenseDir = join(OUTPUT_ROOT, "THIRD_PARTY_LICENSES", "python");
  await mkdir(licenseDir, { recursive: true });
  const [key] = targets;
  const license = key.startsWith("win32") ? "LICENSE.txt" : join("lib", `python${MINOR}`, "LICENSE.txt");
  await copyFile(join(OUTPUT_ROOT, key, license), join(licenseDir, "LICENSE.txt"));
  await writeFile(
    join(licenseDir, "NOTICE"),
    `CPython ${PYTHON_VERSION} (python-build-standalone ${PBS_RELEASE})\n`
      + "Source: https://github.com/astral-sh/python-build-standalone\n"
      + "License: PSF-2.0; the libraries it links (OpenSSL, SQLite, libffi, zlib, xz, bzip2, ...) keep their own licenses\n",
    "utf8",
  );
}

async function main() {
  const requested = process.env.PYTHON_BUNDLE_TARGETS || runtimeTargetKey();
  const targets = requested === "all" ? Object.keys(TARGETS) : requested.split(",").map((value) => value.trim()).filter(Boolean);
  await ensurePythonBundle({ targets, log: (message) => console.log(message) });
  await prepareLicenses(targets);
  console.log(`Bundled CPython ${BUILD} for ${targets.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
