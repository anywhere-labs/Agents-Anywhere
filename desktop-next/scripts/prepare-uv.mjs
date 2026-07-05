import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { get } from "node:https"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { ProxyAgent } from "proxy-agent"

const UV_VERSION = process.env.UV_BUNDLE_VERSION || "0.11.26"
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CACHE_ROOT = join(REPO_ROOT, ".cache", "uv", UV_VERSION)
const OUTPUT_ROOT = join(REPO_ROOT, "build", "uv")
const RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`
const RAW_BASE = `https://raw.githubusercontent.com/astral-sh/uv/${UV_VERSION}`
const DOWNLOAD_TIMEOUT_MS = Number(process.env.UV_BUNDLE_DOWNLOAD_TIMEOUT_MS || 30000)
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]

const TARGETS = {
  "darwin-arm64": { triple: "aarch64-apple-darwin", archive: "tar.gz", executable: "uv" },
  "darwin-x64": { triple: "x86_64-apple-darwin", archive: "tar.gz", executable: "uv" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", archive: "tar.gz", executable: "uv" },
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", archive: "tar.gz", executable: "uv" },
  "win32-arm64": { triple: "aarch64-pc-windows-msvc", archive: "zip", executable: "uv.exe" },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", archive: "zip", executable: "uv.exe" },
}

function runtimeKey() {
  return `${process.platform}-${process.arch}`
}

function selectedTargets() {
  const raw = process.env.UV_BUNDLE_TARGETS || runtimeKey()
  if (raw === "all") return Object.keys(TARGETS)
  return raw.split(",").map((target) => target.trim()).filter(Boolean)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function hasProxyEnv() {
  return PROXY_ENV_KEYS.some((key) => Boolean(process.env[key]?.trim()))
}

const proxyAgent = hasProxyEnv() ? new ProxyAgent() : undefined

async function download(url, destination) {
  await mkdir(dirname(destination), { recursive: true })
  if (await exists(destination)) return
  await new Promise((resolvePromise, reject) => {
    let settled = false
    const fail = async (error) => {
      if (settled) return
      settled = true
      await rm(destination, { force: true }).catch(() => undefined)
      reject(error)
    }
    const request = get(url, { agent: proxyAgent, headers: { "user-agent": "agents-anywhere-desktop-build" } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        download(response.headers.location, destination).then(resolvePromise, reject)
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Download failed (${response.statusCode}) for ${url}`))
        return
      }
      const file = createWriteStream(destination)
      response.pipe(file)
      file.on("finish", () => {
        if (settled) return
        settled = true
        file.close(resolvePromise)
      })
      file.on("error", fail)
    })
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => request.destroy(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms: ${url}`)))
    request.on("error", fail)
  })
}

async function sha256(path) {
  const hash = createHash("sha256")
  hash.update(await readFile(path))
  return hash.digest("hex")
}

async function verifyChecksum(archivePath, checksumPath) {
  const expected = (await readFile(checksumPath, "utf8")).match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase()
  if (!expected) throw new Error(`Could not read checksum from ${checksumPath}`)
  const actual = await sha256(archivePath)
  if (actual !== expected) throw new Error(`Checksum mismatch for ${basename(archivePath)}: expected ${expected}, got ${actual}`)
}

async function run(command, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))
    })
  })
}

async function extractArchive(archivePath, archiveType, destination) {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  if (archiveType === "zip") {
    if (process.platform === "win32") {
      await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(destination)} -Force`])
    } else {
      await run("unzip", ["-q", archivePath, "-d", destination])
    }
    return
  }
  await run("tar", ["-xzf", archivePath, "-C", destination])
}

async function findFile(root, filename) {
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(root, { withFileTypes: true }))
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === filename) return path
    if (entry.isDirectory()) {
      const nested = await findFile(path, filename)
      if (nested) return nested
    }
  }
  return ""
}

async function prepareTarget(key) {
  const target = TARGETS[key]
  if (!target) throw new Error(`Unsupported uv bundle target: ${key}. Supported targets: ${Object.keys(TARGETS).join(", ")}`)
  const asset = `uv-${target.triple}.${target.archive}`
  const archivePath = join(CACHE_ROOT, asset)
  const checksumPath = join(CACHE_ROOT, `${asset}.sha256`)
  await download(`${RELEASE_BASE}/${asset}`, archivePath)
  await download(`${RELEASE_BASE}/${asset}.sha256`, checksumPath)
  await verifyChecksum(archivePath, checksumPath)

  const extractDir = join(CACHE_ROOT, "extract", key)
  await extractArchive(archivePath, target.archive, extractDir)
  const executablePath = await findFile(extractDir, target.executable)
  if (!executablePath) throw new Error(`Could not find ${target.executable} in ${asset}`)

  const outputDir = join(OUTPUT_ROOT, key)
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })
  await copyFile(executablePath, join(outputDir, target.executable))
  if (target.executable !== "uv.exe") await chmod(join(outputDir, target.executable), 0o755)
  await writeFile(join(outputDir, "UV_VERSION"), `${UV_VERSION}\n`, "utf8")
  console.log(`Bundled uv ${UV_VERSION} for ${key}`)
}

async function prepareLicenses() {
  const licenseDir = join(OUTPUT_ROOT, "THIRD_PARTY_LICENSES", "uv")
  await mkdir(licenseDir, { recursive: true })
  await download(`${RAW_BASE}/LICENSE-MIT`, join(licenseDir, "LICENSE-MIT"))
  await download(`${RAW_BASE}/LICENSE-APACHE`, join(licenseDir, "LICENSE-APACHE"))
  await writeFile(
    join(licenseDir, "NOTICE"),
    [
      `uv ${UV_VERSION}`,
      "Source: https://github.com/astral-sh/uv",
      "License: MIT OR Apache-2.0",
      "",
    ].join("\n"),
    "utf8",
  )
}

async function main() {
  const targets = selectedTargets()
  await mkdir(OUTPUT_ROOT, { recursive: true })
  await Promise.all(targets.map(prepareTarget))
  await prepareLicenses()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
