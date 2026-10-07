// Writes web-next/public/downloads/plugin/manifest.json from the versioned
// plugin tarballs that are already published in that directory.
//
// Contract notes (see docs/plugin-distribution.md):
// - Only versioned, content-immutable files (agents-anywhere-dsh-bridge-next-<version>.tgz)
//   are indexed. The stable-name pointer file (agents-anywhere-dsh-bridge-next.tgz)
//   is intentionally excluded: its content changes on every release, so it can
//   never carry a trustworthy integrity value.
// - `latest` is the highest version by semver order (prereleases sort below
//   their release), not necessarily the version in package.json.
// - integrity follows the npm/pnpm Subresource Integrity format:
//   "sha512-" + base64(sha512(file bytes)).
// - url is the absolute public download address. The manifest is served from
//   the same directory (https://dsh.chyu.top/downloads/plugin/manifest.json);
//   consumers (pnpm add, update checkers) need absolute URLs, so no relative
//   form is emitted.
// - Output is byte-stable for identical directory contents (no timestamps),
//   so re-running the script is a no-op diff.

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const scriptDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(scriptDir, '..', '..')
const packageDir = join(scriptDir, '..')

const DOWNLOAD_BASE = 'https://dsh.chyu.top/downloads/plugin'
const TARBALL_PREFIX = 'agents-anywhere-dsh-bridge-next-'
const STABLE_TARBALL = 'agents-anywhere-dsh-bridge-next.tgz'
const MANIFEST_NAME = 'manifest.json'

function fail(message) {
  console.error(`write-release-manifest: ${message}`)
  process.exit(1)
}

// Strict-enough semver parse: major.minor.patch with optional prerelease.
function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function compareIdentifiers(a, b) {
  const numericA = /^\d+$/.test(a)
  const numericB = /^\d+$/.test(b)
  if (numericA && numericB) return Number(a) - Number(b)
  if (numericA) return -1 // numeric identifiers always sort before alphanumeric
  if (numericB) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

// Follows semver precedence: higher major/minor/patch wins; a prerelease sorts
// below the same core version; longer prerelease lists win on equal prefixes.
function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const shared = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < shared; index += 1) {
    const delta = compareIdentifiers(a.prerelease[index], b.prerelease[index])
    if (delta !== 0) return delta
  }
  return a.prerelease.length - b.prerelease.length
}

async function sha512Integrity(filePath) {
  const bytes = await readFile(filePath)
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

async function main() {
  const packageManifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  const packageVersion = packageManifest.version
  if (typeof packageVersion !== 'string' || !parseSemver(packageVersion)) {
    fail(`dsh-bridge-next/package.json has no usable semver version: ${JSON.stringify(packageVersion)}`)
  }

  const pluginDir = join(repoRoot, 'web-next', 'public', 'downloads', 'plugin')
  let entries
  try {
    entries = await readdir(pluginDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`plugin download directory not found: ${pluginDir}\n  Pass or create the directory that holds the published tarballs; nothing was written.`)
    }
    throw error
  }

  const versions = []
  const skipped = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name === MANIFEST_NAME) continue // our own output from a previous run
    if (entry.name === STABLE_TARBALL) {
      skipped.push(entry.name) // pointer copy, mutable by design — never indexed
      continue
    }
    if (!entry.name.startsWith(TARBALL_PREFIX) || !entry.name.endsWith('.tgz')) {
      skipped.push(entry.name)
      continue
    }
    const version = entry.name.slice(TARBALL_PREFIX.length, -'.tgz'.length)
    const parsed = parseSemver(version)
    if (!parsed) {
      skipped.push(entry.name) // not a clean versioned tarball name
      continue
    }
    versions.push({ version, parsed, file: join(pluginDir, entry.name) })
  }

  if (versions.length === 0) {
    fail(`no versioned tarballs (${TARBALL_PREFIX}<version>.tgz) found under ${pluginDir}`)
  }

  versions.sort((a, b) => compareSemver(b.parsed, a.parsed))

  const listed = []
  for (const item of versions) {
    listed.push({
      version: item.version,
      url: `${DOWNLOAD_BASE}/${TARBALL_PREFIX}${item.version}.tgz`,
      integrity: await sha512Integrity(item.file),
    })
  }

  const manifest = {
    latest: { ...listed[0] },
    versions: listed,
  }

  // Trailing newline matches other JSON artifacts in this repo and keeps
  // repeat runs byte-identical.
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`
  await mkdir(pluginDir, { recursive: true })
  const manifestPath = join(pluginDir, MANIFEST_NAME)
  const previous = await readFile(manifestPath, 'utf8').catch(() => null)
  if (previous !== serialized) {
    await writeFile(manifestPath, serialized, 'utf8')
  }

  if (!versions.some(item => item.version === packageVersion)) {
    console.error(
      `write-release-manifest: warning: package.json version ${packageVersion} has no matching tarball ` +
      `(${TARBALL_PREFIX}${packageVersion}.tgz) in ${pluginDir}; the manifest lists only what is already published.`,
    )
  }
  if (skipped.length > 0) {
    console.error(`write-release-manifest: skipped non-versioned files: ${skipped.join(', ')}`)
  }
  console.log(`write-release-manifest: wrote ${manifestPath}`)
  console.log(`write-release-manifest: latest ${manifest.latest.version}, ${manifest.versions.length} version(s) indexed`)
}

main().catch(error => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error))
})
