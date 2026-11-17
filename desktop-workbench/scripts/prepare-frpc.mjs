/**
 * Places the frp client the Connector uses for port preview into
 * `build/frpc/<platform>-<arch>/frpc[.exe]` (packaged as `resources/frpc`).
 * The release archive is checked against the sha256 pinned here, cached under
 * `.cache/frp`, and only `frpc` and the license are kept.
 *
 * `FRPC_BUNDLE_TARGETS` lists targets (`darwin-arm64,darwin-x64`); the default
 * is this machine. `FRPC_BUNDLE_MIRROR` downloads from a mirror with GitHub's
 * release layout.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProxyAgent } from "proxy-agent";
import { exists, runtimeTargetKey } from "./bundle-targets.mjs";

const FRP_VERSION = "0.72.0";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_ROOT = join(PROJECT_ROOT, ".cache", "frp", FRP_VERSION);
const OUTPUT_ROOT = join(PROJECT_ROOT, "build", "frpc");
const RELEASE_BASE = (process.env.FRPC_BUNDLE_MIRROR?.trim() || "https://github.com/fatedier/frp/releases/download").replace(/\/+$/, "");
const STAMP = "FRP_VERSION";
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

/** frp_sha256_checksums.txt of the v0.72.0 release. */
const TARGETS = {
  "darwin-arm64": { name: "darwin_arm64", archive: "tar.gz", sha256: "6e8576c5b6b9914a86850f6ff4fb81c5a09e706f91f70f64d5f398558bdc9db8" },
  "darwin-x64": { name: "darwin_amd64", archive: "tar.gz", sha256: "60439dc6bf794c4182a1a4cac147d642f839d55201607208979eb23aecd09be9" },
  "linux-arm64": { name: "linux_arm64", archive: "tar.gz", sha256: "02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf" },
  "linux-x64": { name: "linux_amd64", archive: "tar.gz", sha256: "daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804" },
  "win32-arm64": { name: "windows_arm64", archive: "zip", sha256: "e4b83b66c4045971dd9a47cdef16dd02af471aaa6667dd303e63b1a669162927" },
  "win32-x64": { name: "windows_amd64", archive: "zip", sha256: "5197c1b69564089cdc229fc1260a0e25db1e722b1b7db45fe1542c3c43edf9ae" },
};

const proxyAgent = PROXY_KEYS.some((key) => Boolean(process.env[key]?.trim())) ? new ProxyAgent() : undefined;

function download(url, destination, redirects = 0) {
  return new Promise((resolveDownload, rejectDownload) => {
    const request = get(url, { agent: proxyAgent, headers: { "user-agent": "agents-anywhere-desktop-build" } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location && redirects < 5) {
        response.resume();
        download(new URL(response.headers.location, url).href, destination, redirects + 1).then(resolveDownload, rejectDownload);
        return;
      }
      if (status !== 200) {
        response.resume();
        rejectDownload(new Error(`GET ${url} answered ${status}`));
        return;
      }
      const file = createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => file.close(() => resolveDownload()));
      file.on("error", rejectDownload);
    });
    request.setTimeout(Number(process.env.FRPC_BUNDLE_DOWNLOAD_TIMEOUT_MS || 30_000), () => request.destroy(new Error(`Timed out downloading ${url}`)));
    request.on("error", rejectDownload);
  });
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function archiveFor(target) {
  const spec = TARGETS[target];
  const fileName = `frp_${FRP_VERSION}_${spec.name}.${spec.archive}`;
  const cached = join(CACHE_ROOT, fileName);
  if (await exists(cached) && await sha256(cached) === spec.sha256) return cached;
  await mkdir(CACHE_ROOT, { recursive: true });
  const partial = `${cached}.partial`;
  await rm(partial, { force: true });
  await download(`${RELEASE_BASE}/v${FRP_VERSION}/${fileName}`, partial);
  const digest = await sha256(partial);
  if (digest !== spec.sha256) {
    await rm(partial, { force: true });
    throw new Error(`${fileName}: sha256 ${digest} does not match the pinned ${spec.sha256}`);
  }
  await rm(cached, { force: true });
  await copyFile(partial, cached);
  await rm(partial, { force: true });
  return cached;
}

async function isCurrent(outputDir, executable) {
  if (!(await exists(join(outputDir, executable)))) return false;
  try {
    return (await readFile(join(outputDir, STAMP), "utf8")).trim() === FRP_VERSION;
  } catch {
    return false;
  }
}

export async function ensureFrpcBundle({ targets = [runtimeTargetKey()], log = () => {} } = {}) {
  const paths = [];
  for (const target of targets) {
    const spec = TARGETS[target];
    if (!spec) throw new Error(`Unsupported frpc target: ${target}`);
    const executable = target.startsWith("win32") ? "frpc.exe" : "frpc";
    const outputDir = join(OUTPUT_ROOT, target);
    paths.push(join(outputDir, executable));
    if (await isCurrent(outputDir, executable)) continue;
    log(`Preparing frpc ${FRP_VERSION} for ${target}`);
    const archive = await archiveFor(target);
    const scratch = await mkdtemp(join(tmpdir(), "aa-frpc-"));
    try {
      // bsdtar (macOS, Windows 10+) also reads zip archives.
      const result = spawnSync("tar", ["-xf", archive, "-C", scratch], { stdio: "inherit" });
      if (result.status !== 0) throw new Error(`Could not extract ${archive}`);
      const root = join(scratch, `frp_${FRP_VERSION}_${spec.name}`);
      await rm(outputDir, { recursive: true, force: true });
      await mkdir(outputDir, { recursive: true });
      await copyFile(join(root, executable), join(outputDir, executable));
      if (executable === "frpc") await chmod(join(outputDir, executable), 0o755);
      await copyFile(join(root, "LICENSE"), join(outputDir, "LICENSE"));
      await writeFile(join(outputDir, STAMP), `${FRP_VERSION}\n`, "utf8");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const requested = process.env.FRPC_BUNDLE_TARGETS || runtimeTargetKey();
  const targets = requested === "all" ? Object.keys(TARGETS) : requested.split(",").map((value) => value.trim()).filter(Boolean);
  for (const value of await ensureFrpcBundle({ targets, log: (message) => console.log(message) })) console.log(`frpc: ${value}`);
}
