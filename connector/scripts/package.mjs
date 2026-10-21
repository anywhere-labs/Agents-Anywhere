/**
 * Package the Connector as a standalone distribution.
 *
 * Every artifact is self-contained and has the same shape:
 *   - uv (from the PyPI wheel, so domestic PyPI mirrors work)
 *   - a bundled managed CPython (python-build-standalone `install_only_stripped`,
 *     the exact asset `uv python install` uses)
 *   - the Connector source (pyproject.toml, uv.lock, connector/)
 *   - a wrapper that prefers a compatible system CPython and falls back to the
 *     bundled one, so a machine that already has Python 3.12-3.15 never pays
 *     for a new interpreter install
 *   - a package README
 *
 * Usage:
 *   node scripts/package.mjs [target]
 *   target: win32-x64 (default on Windows) | win32-arm64 | linux-x64 | linux-arm64 | all
 *
 * Caveat: Linux tarballs must be produced on Linux. Windows bsdtar cannot store
 * the executable bit, so build linux-* targets on a Linux host.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import { cp, mkdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { readFileSync, readdirSync, copyFileSync, chmodSync } from "node:fs";
import { get } from "node:https";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UV_VERSION = process.env.UV_BUNDLE_VERSION || "0.11.26";
const PYTHON_VERSION = process.env.PYTHON_BUNDLE_VERSION || "3.14.6";
const PYTHON_TAG = process.env.PYTHON_BUNDLE_TAG || "20260623";

const PYPI_INDEX_BASES = [
  process.env.UV_BUNDLE_INDEX?.trim().replace(/\/+$/, ""),
  process.env.UV_BUNDLE_MIRROR?.trim().replace(/\/+$/, ""),
  "https://mirrors.aliyun.com/pypi/simple",
  "https://pypi.org/simple",
].filter(Boolean);

const PYTHON_RELEASE_BASES = [
  process.env.PYTHON_BUNDLE_MIRROR?.trim().replace(/\/+$/, ""),
  "https://github.com/astral-sh/python-build-standalone/releases/download",
].filter(Boolean);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const STAGING_ROOT = join(DIST, "staging");
const PKG_DIR_NAME = "agents-anywhere-connector";
const UV_CACHE = join(ROOT, ".cache", "uv", UV_VERSION);
const PYTHON_CACHE = join(ROOT, ".cache", "python", `${PYTHON_VERSION}-${PYTHON_TAG}`);

const TARGETS = {
  "win32-x64": {
    distName: "win-x64",
    archive: "zip",
    windows: true,
    uvFile: "uv.exe",
    uvWheel: `uv-${UV_VERSION}-py3-none-win_amd64.whl`,
    pythonTriple: "x86_64-pc-windows-msvc",
    pythonRelative: join("python", "python.exe"),
    platform: "Windows 10 1903+ / 11 (x64)",
  },
  "win32-arm64": {
    distName: "win-arm64",
    archive: "zip",
    windows: true,
    uvFile: "uv.exe",
    uvWheel: `uv-${UV_VERSION}-py3-none-win_arm64.whl`,
    pythonTriple: "aarch64-pc-windows-msvc",
    pythonRelative: join("python", "python.exe"),
    platform: "Windows 11 (ARM64)",
  },
  "linux-x64": {
    distName: "linux-x64",
    archive: "tar.gz",
    windows: false,
    uvFile: "uv",
    uvWheel: `uv-${UV_VERSION}-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl`,
    pythonTriple: "x86_64-unknown-linux-gnu",
    pythonRelative: join("python", "bin", "python3"),
    platform: "Linux x86_64（glibc >= 2.17；Kylin V10 / Ubuntu 20.04+ / Debian 11+）",
  },
  "linux-arm64": {
    distName: "linux-arm64",
    archive: "tar.gz",
    windows: false,
    uvFile: "uv",
    uvWheel: `uv-${UV_VERSION}-py3-none-manylinux_2_28_aarch64.whl`,
    pythonTriple: "aarch64-unknown-linux-gnu",
    pythonRelative: join("python", "bin", "python3"),
    platform: "Linux arm64（glibc >= 2.17；Kylin V10 ARM / Ubuntu 20.04+ arm64）",
  },
};

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function download(url, destination) {
  return new Promise((resolveDownload, rejectDownload) => {
    let settled = false;
    const fail = async (error) => {
      if (settled) return;
      settled = true;
      await rm(destination, { force: true }).catch(() => undefined);
      rejectDownload(error);
    };
    const request = get(
      url,
      { headers: { "user-agent": "agents-anywhere-connector-package" } },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
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
    request.setTimeout(600_000, () => request.destroy(new Error(`Download timed out: ${url}`)));
    request.on("error", fail);
  });
}

function fetchText(url) {
  return new Promise((resolveText, rejectText) => {
    const request = get(url, { headers: { "user-agent": "agents-anywhere-connector-package" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        fetchText(response.headers.location).then(resolveText, rejectText);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        rejectText(new Error(`Fetch failed (${response.statusCode}) for ${url}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolveText(body));
    });
    request.setTimeout(120_000, () => request.destroy(new Error(`Fetch timed out: ${url}`)));
    request.on("error", rejectText);
  });
}

async function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchUv(target) {
  const fileName = target.uvWheel;
  const cachePath = join(UV_CACHE, fileName);
  const checksumPath = `${cachePath}.sha256`;
  await mkdir(UV_CACHE, { recursive: true });
  if (await exists(cachePath)) {
    const sidecar = (await exists(checksumPath)) ? (await readFile(checksumPath, "utf8")).trim() : "";
    const expected = sidecar.match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
    if (!expected || (await sha256(cachePath)) === expected) return cachePath;
    await rm(cachePath, { force: true });
  }
  const errors = [];
  for (const base of PYPI_INDEX_BASES) {
    const indexUrl = `${base}/uv/`;
    try {
      const page = await fetchText(indexUrl);
      const match = page.match(new RegExp(`href="([^"]*${escapeRegExp(fileName)})[^"]*"`));
      if (!match) throw new Error(`${fileName} not listed on ${base}`);
      const href = match[1];
      const expected = (href.match(/#sha256=([a-f0-9]{64})/i)?.[1] ?? "").toLowerCase();
      const url = new URL(href, indexUrl).toString();
      await download(url, cachePath);
      if (expected && (await sha256(cachePath)) !== expected) throw new Error(`Checksum mismatch for ${fileName}`);
      if (expected) await writeFile(checksumPath, `${expected}  ${fileName}\n`);
      return cachePath;
    } catch (error) {
      errors.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
      await rm(cachePath, { force: true }).catch(() => undefined);
    }
  }
  throw new Error(`Failed to download ${fileName}: ${errors.join("; ")}`);
}

async function fetchPython(target) {
  const asset = `cpython-${PYTHON_VERSION}+${PYTHON_TAG}-${target.pythonTriple}-install_only_stripped.tar.gz`;
  const cachePath = join(PYTHON_CACHE, asset);
  await mkdir(PYTHON_CACHE, { recursive: true });
  if (await exists(cachePath)) return cachePath;
  const errors = [];
  for (const base of PYTHON_RELEASE_BASES) {
    try {
      await download(`${base}/${PYTHON_TAG}/${asset}`, cachePath);
      return cachePath;
    } catch (error) {
      errors.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
      await rm(cachePath, { force: true }).catch(() => undefined);
    }
  }
  throw new Error(`Failed to download ${asset}: ${errors.join("; ")}`);
}

async function extract(archivePath, destination) {
  await mkdir(destination, { recursive: true });
  const lower = archivePath.toLowerCase();
  const isZip = lower.endsWith(".whl") || lower.endsWith(".zip");
  if (isZip && process.platform !== "win32") {
    // GNU tar cannot read zip containers; the PyPI wheels are zips.
    const viaPython = spawnSync("python3", ["-m", "zipfile", "-e", archivePath, destination], { stdio: "inherit" });
    if (viaPython.status === 0) return;
    const viaUnzip = spawnSync("unzip", ["-q", "-o", archivePath, "-d", destination], { stdio: "inherit" });
    if (viaUnzip.status !== 0) throw new Error(`Failed to extract ${archivePath}`);
    return;
  }
  const binary = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  const args = isZip
    ? ["-xf", archivePath, "-C", destination]
    : ["-xzf", archivePath, "-C", destination];
  const result = spawnSync(binary, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Failed to extract ${archivePath}`);
}

function findFile(root, filename) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name === filename) return candidate;
    if (entry.isDirectory()) {
      const nested = findFile(candidate, filename);
      if (nested) return nested;
    }
  }
  return "";
}

const EXCLUDED_DIRS = new Set([
  "__pycache__",
  "_reference",
  "_deprecated",
  ".venv",
  "tests",
  "scripts",
  ".pytest_cache",
  ".ruff_cache",
]);

function isExcluded(relative) {
  const parts = relative.split(sep);
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return true;
  return /\.(pyc|pyo)$/.test(relative);
}

function readVersionSync() {
  const text = readFileSync(join(ROOT, "pyproject.toml"), "utf8");
  return /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? "0.0.0";
}

function posixWrapper() {
  return `#!/usr/bin/env sh
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"

export UV_INDEX_URL="\${UV_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}"
export UV_PYTHON_INSTALL_MIRROR="\${UV_PYTHON_INSTALL_MIRROR:-https://github.com/astral-sh/python-build-standalone/releases/download}"
export UV_HTTP_TIMEOUT="\${UV_HTTP_TIMEOUT:-120}"
export UV_PROJECT_ENVIRONMENT="$DIR/.venv"
export UV_CACHE_DIR="$DIR/.uv-cache"

# Interpreter order: explicit UV_PYTHON > system CPython 3.12-3.15 > bundled CPython > uv download.
PY="\${UV_PYTHON:-}"
if [ -z "$PY" ]; then
  for candidate in python3.15 python3.14 python3.13 python3.12 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] in ((3,12),(3,13),(3,14),(3,15)) else 1)' >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  done
fi
if [ -z "$PY" ] && [ -x "$DIR/pythons/python/bin/python3" ]; then
  PY="$DIR/pythons/python/bin/python3"
fi

if [ -n "$PY" ]; then
  exec "$DIR/uv" run --project "$DIR/connector" --python "$PY" anywhere-cli "$@"
fi
exec "$DIR/uv" run --project "$DIR/connector" anywhere-cli "$@"
`;
}

function windowsWrapper() {
  return `@echo off
setlocal

set "PKG_DIR=%~dp0"
set "UV_PROJECT_ENVIRONMENT=%PKG_DIR%.venv"
set "UV_CACHE_DIR=%PKG_DIR%.uv-cache"
if not defined UV_INDEX_URL set "UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/"
if not defined UV_PYTHON_INSTALL_MIRROR set "UV_PYTHON_INSTALL_MIRROR=https://github.com/astral-sh/python-build-standalone/releases/download"
if not defined UV_HTTP_TIMEOUT set "UV_HTTP_TIMEOUT=120"

rem Interpreter order: explicit UV_PYTHON > system CPython 3.12-3.15 > bundled CPython > uv download.
set "PY="
if defined UV_PYTHON set "PY=%UV_PYTHON%"
if not defined PY for %%C in (python3.15.exe python3.14.exe python3.13.exe python3.12.exe python3.exe python.exe) do call :probe %%C
if not defined PY if exist "%PKG_DIR%pythons\\python\\python.exe" set "PY=%PKG_DIR%pythons\\python\\python.exe"

if defined PY (
  "%PKG_DIR%uv.exe" run --project "%PKG_DIR%connector" --python "%PY%" anywhere-cli %*
) else (
  "%PKG_DIR%uv.exe" run --project "%PKG_DIR%connector" anywhere-cli %*
)
exit /b %errorlevel%

:probe
if defined PY exit /b 0
for /f "delims=" %%P in ('where %~1 2^>nul') do (
  if not defined PY (
    %%~P -c "import sys; raise SystemExit(0 if sys.version_info[:2] in ((3,12),(3,13),(3,14),(3,15)) else 1)" >nul 2>&1 && set "PY=%%~P"
  )
)
exit /b 0
`;
}

function packageReadme(target, version) {
  const isWin = target.windows;
  const cli = isWin ? "anywhere-cli.bat" : "./anywhere-cli";
  const runCommand = isWin ? "start /b anywhere-cli.bat start" : "nohup ./anywhere-cli start &";
  return `# Agents Anywhere Connector ${target.distName}

独立 Connector + CLI 包（v${version}，${target.distName}）。无需安装 Desktop 客户端，只需能访问 Agents Anywhere Server。

## 要求

- ${target.platform}
- 磁盘约 300MB（首次运行创建虚拟环境并安装依赖）
- 可访问 Server 的网络
- 无需系统 Python：包内已捆绑 CPython ${PYTHON_VERSION}。若系统已安装 Python 3.12-3.15，会优先使用系统 Python，不触发新的解释器下载。

## 使用

\`\`\`bash
# 1. 配对：生成配对码，到 Web 控制台认领
${cli} pair https://your-server.com

# 2. 认领后自动保存凭据并启动
# 3. 后台运行
${runCommand}
\`\`\`

其他子命令：

\`\`\`bash
${cli} start        # 使用已保存配置启动
${cli} configure --server-url URL --connector-id ID --connector-token TOKEN
${cli} --help
\`\`\`

## 镜像（默认已配置，可覆盖）

| 变量 | 默认值 |
| --- | --- |
| \`UV_INDEX_URL\` | \`https://mirrors.aliyun.com/pypi/simple/\`（PyPI 依赖） |
| \`UV_PYTHON_INSTALL_MIRROR\` | GitHub 直连（仅在删除 \`pythons/\` 且系统无可用 Python 时才会用到） |

## 数据目录

配置与运行数据默认在 \`~/.agents-anywhere/\`（可用 \`AGENT_CONNECTOR_DATA_DIR\` 覆盖）。

## 更新

用新版本包整体替换本目录即可；\`.venv\` 会在依赖变化时自动重建。
`;
}

async function stagePackage(target, { uvWheelPath, pythonArchivePath }) {
  const version = readVersionSync();
  const staging = join(STAGING_ROOT, target.distName);
  const pkgDir = join(staging, PKG_DIR_NAME);
  await rm(staging, { recursive: true, force: true });
  await mkdir(pkgDir, { recursive: true });

  const uvExtract = join(staging, "uv-extract");
  await extract(uvWheelPath, uvExtract);
  const uvSource = findFile(uvExtract, target.uvFile);
  if (!uvSource) throw new Error(`Could not find ${target.uvFile} inside ${uvWheelPath}`);
  copyFileSync(uvSource, join(pkgDir, target.uvFile));
  if (!target.windows) chmodSync(join(pkgDir, target.uvFile), 0o755);
  await rm(uvExtract, { recursive: true, force: true });

  const pythonsDir = join(pkgDir, "pythons");
  await extract(pythonArchivePath, pythonsDir);
  const pythonEntry = join(pythonsDir, target.pythonRelative);
  if (!existsSync(pythonEntry)) {
    throw new Error(`Bundled python entry missing: ${target.pythonRelative}`);
  }
  if (!target.windows) chmodSync(pythonEntry, 0o755);

  const sourceDir = join(ROOT, "connector");
  await cp(sourceDir, join(pkgDir, "connector"), {
    recursive: true,
    dereference: true,
    filter: (_source, destination) => !isExcluded(destination.slice(ROOT.length + 1)),
  });
  for (const name of ["pyproject.toml", "uv.lock"]) {
    const source = join(ROOT, name);
    if (await exists(source)) await cp(source, join(pkgDir, name));
  }

  if (target.windows) {
    await writeFile(join(pkgDir, "anywhere-cli.bat"), windowsWrapper(), "utf8");
  } else {
    await writeFile(join(pkgDir, "anywhere-cli"), posixWrapper(), "utf8");
    chmodSync(join(pkgDir, "anywhere-cli"), 0o755);
  }
  await writeFile(join(pkgDir, "README.md"), packageReadme(target, version), "utf8");

  return { pkgDir, staging, version };
}

async function makeArchive(target, { pkgDir, staging, version }) {
  await mkdir(DIST, { recursive: true });
  const base = `agents-anywhere-connector-${version}-${target.distName}`;
  if (target.archive === "zip") {
    const out = join(DIST, `${base}.zip`);
    await rm(out, { force: true });
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Compress-Archive -LiteralPath ${JSON.stringify(pkgDir)} -DestinationPath ${JSON.stringify(out)} -Force`],
      { stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error("Compress-Archive failed");
    return out;
  }
  if (process.platform === "win32") {
    console.warn(`warning: ${target.distName} tarball built on Windows; executable bits will not survive`);
  }
  const out = join(DIST, `${base}.tar.gz`);
  await rm(out, { force: true });
  const result = spawnSync("tar", ["-czf", out, "-C", staging, PKG_DIR_NAME], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("tar failed");
  return out;
}

async function buildTarget(requested) {
  const target = TARGETS[requested];
  console.log(`\n=== ${requested} -> ${target.distName} ===`);
  console.log(`fetching uv wheel ...`);
  const uvWheelPath = await fetchUv(target);
  console.log(`  ${uvWheelPath}`);
  console.log(`fetching cpython ${PYTHON_VERSION}+${PYTHON_TAG} (${target.pythonTriple}) ...`);
  const pythonArchivePath = await fetchPython(target);
  console.log(`  ${pythonArchivePath}`);
  const staged = await stagePackage(target, { uvWheelPath, pythonArchivePath });
  const out = await makeArchive(target, staged);
  await rm(staged.staging, { recursive: true, force: true });
  console.log(`Done: ${out}`);
  return out;
}

async function main() {
  const requested = process.argv[2] || (process.platform === "win32" ? "win32-x64" : "linux-x64");
  if (requested === "all") {
    for (const name of Object.keys(TARGETS)) await buildTarget(name);
    return;
  }
  if (!TARGETS[requested]) {
    console.error(`Unknown target: ${requested}. Choose from: ${Object.keys(TARGETS).join(", ")}, all`);
    process.exit(1);
  }
  await buildTarget(requested);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});