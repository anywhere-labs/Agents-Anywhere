import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent } from "proxy-agent";

const UV_VERSION = process.env.UV_BUNDLE_VERSION || "0.11.26";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_ROOT = join(PROJECT_ROOT, ".cache", "uv", UV_VERSION);
const OUTPUT_ROOT = join(PROJECT_ROOT, "build", "uv");
const RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
const RAW_BASE = `https://raw.githubusercontent.com/astral-sh/uv/${UV_VERSION}`;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.UV_BUNDLE_DOWNLOAD_TIMEOUT_MS || 30_000);
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

const TARGETS = {
  "darwin-arm64": { triple: "aarch64-apple-darwin", archive: "tar.gz", executable: "uv" },
  "darwin-x64": { triple: "x86_64-apple-darwin", archive: "tar.gz", executable: "uv" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", archive: "tar.gz", executable: "uv" },
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", archive: "tar.gz", executable: "uv" },
  "win32-arm64": { triple: "aarch64-pc-windows-msvc", archive: "zip", executable: "uv.exe" },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", archive: "zip", executable: "uv.exe" },
};

const proxyAgent = PROXY_KEYS.some((key) => Boolean(process.env[key]?.trim()))
  ? new ProxyAgent()
  : undefined;

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  await mkdir(dirname(destination), { recursive: true });
  if (await exists(destination)) return;
  await new Promise((resolveDownload, rejectDownload) => {
    let settled = false;
    const fail = async (error) => {
      if (settled) return;
      settled = true;
      await rm(destination, { force: true }).catch(() => undefined);
      rejectDownload(error);
    };
    const request = get(
      url,
      { agent: proxyAgent, headers: { "user-agent": "agents-anywhere-desktop-build" } },
      (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          download(response.headers.location, destination).then(resolveDownload, rejectDownload);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          rejectDownload(new Error(`Download failed (${response.statusCode}) for ${url}`));
          return;
        }
        const file = createWriteStream(destination);
        response.pipe(file);
        file.on("finish", () => {
          if (settled) return;
          settled = true;
          file.close(resolveDownload);
        });
        file.on("error", fail);
      },
    );
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => request.destroy(new Error(`Download timed out: ${url}`)));
    request.on("error", fail);
  });
}

async function verifyChecksum(archivePath, checksumPath) {
  const expected = (await readFile(checksumPath, "utf8")).match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
  if (!expected) throw new Error(`Could not read checksum for ${basename(archivePath)}`);
  const hash = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  if (hash !== expected) throw new Error(`Checksum mismatch for ${basename(archivePath)}`);
}

async function run(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", rejectRun);
    child.on("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited with ${code}`)));
  });
}

async function extract(archivePath, archiveType, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  if (archiveType === "zip") {
    if (process.platform === "win32") {
      await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(destination)} -Force`]);
    } else {
      await run("unzip", ["-q", archivePath, "-d", destination]);
    }
    return;
  }
  await run("tar", ["-xzf", archivePath, "-C", destination]);
}

async function findFile(root, filename) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name === filename) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, filename);
      if (nested) return nested;
    }
  }
  return "";
}

async function prepareTarget(key) {
  const target = TARGETS[key];
  if (!target) throw new Error(`Unsupported uv bundle target: ${key}`);
  const asset = `uv-${target.triple}.${target.archive}`;
  const archivePath = join(CACHE_ROOT, asset);
  const checksumPath = join(CACHE_ROOT, `${asset}.sha256`);
  await download(`${RELEASE_BASE}/${asset}`, archivePath);
  await download(`${RELEASE_BASE}/${asset}.sha256`, checksumPath);
  await verifyChecksum(archivePath, checksumPath);
  const extractDir = join(CACHE_ROOT, "extract", key);
  await extract(archivePath, target.archive, extractDir);
  const executablePath = await findFile(extractDir, target.executable);
  if (!executablePath) throw new Error(`Could not find ${target.executable} in ${asset}`);
  const outputDir = join(OUTPUT_ROOT, key);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await copyFile(executablePath, join(outputDir, target.executable));
  if (target.executable !== "uv.exe") await chmod(join(outputDir, target.executable), 0o755);
  await writeFile(join(outputDir, "UV_VERSION"), `${UV_VERSION}\n`, "utf8");
  console.log(`Bundled uv ${UV_VERSION} for ${key}`);
}

async function prepareLicenses() {
  const licenseDir = join(OUTPUT_ROOT, "THIRD_PARTY_LICENSES", "uv");
  await mkdir(licenseDir, { recursive: true });
  await download(`${RAW_BASE}/LICENSE-MIT`, join(licenseDir, "LICENSE-MIT"));
  await download(`${RAW_BASE}/LICENSE-APACHE`, join(licenseDir, "LICENSE-APACHE"));
  await writeFile(join(licenseDir, "NOTICE"), `uv ${UV_VERSION}\nSource: https://github.com/astral-sh/uv\nLicense: MIT OR Apache-2.0\n`, "utf8");
}

async function main() {
  const requested = process.env.UV_BUNDLE_TARGETS || `${process.platform}-${process.arch}`;
  const targets = requested === "all" ? Object.keys(TARGETS) : requested.split(",").map((value) => value.trim()).filter(Boolean);
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await Promise.all(targets.map(prepareTarget));
  await prepareLicenses();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
