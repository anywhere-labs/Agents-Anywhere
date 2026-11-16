// The MeshCall Router the Connector ships (`router/<target>/meshcall-router`), built from the pinned meshcall
// commit and checked against the SHA-256 recorded in scripts/meshcall-router.json. The binaries are never
// committed: CI builds them as artifacts, packaging and local development run this script.
//
// The build is reproducible — `-trimpath`, no VCS stamp or build id, CGO off, and the exact Go toolchain from
// the manifest (GOTOOLCHAIN downloads it when the installed Go differs) — so every machine gets the same bytes,
// and a mismatch means the source, the toolchain or the binary is not what was reviewed.
//
// usage:
//   node scripts/fetch-router.mjs [--target darwin-arm64 ...] [--all]   build from source and verify
//   node scripts/fetch-router.mjs --from <dir> [--target ...] [--all]   take prebuilt binaries (a CI artifact laid out
//                                                                       as <dir>/<target>/meshcall-router) and verify
//   node scripts/fetch-router.mjs --record --all                        rebuild and write the checksums (review the diff)
// options: --source <meshcall checkout at the pinned commit>  --out <dir> (default router/)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'scripts', 'meshcall-router.json')
/** @type {{ repository: string, commit: string, version: string, go: string, targets: Record<string, string> }} */
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

/** `<os>-<arch>` as Node names them → Go's GOOS/GOARCH. */
const TARGETS = {
  'darwin-arm64': ['darwin', 'arm64'],
  'darwin-x64': ['darwin', 'amd64'],
  'linux-arm64': ['linux', 'arm64'],
  'linux-x64': ['linux', 'amd64'],
  'win32-arm64': ['windows', 'arm64'],
  'win32-x64': ['windows', 'amd64'],
}
/** @param {string} target */
const executable = target => (target.startsWith('win32-') ? 'meshcall-router.exe' : 'meshcall-router')

const { values } = parseArgs({
  options: {
    target: { type: 'string', multiple: true },
    all: { type: 'boolean', default: false },
    from: { type: 'string' },
    source: { type: 'string' },
    out: { type: 'string', default: 'router' },
    record: { type: 'boolean', default: false },
  },
})
const targets = values.all ? Object.keys(TARGETS) : (values.target ?? [`${process.platform}-${process.arch}`])
for (const target of targets) {
  if (!(target in TARGETS)) throw new Error(`unknown target ${target}; one of ${Object.keys(TARGETS).join(', ')}`)
}
const out = resolve(root, values.out ?? 'router')

/** @param {string} path */
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

/** @param {string} command @param {readonly string[]} args @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options] */
function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options }).trim()
}

/** A meshcall checkout at the pinned commit: `--source`, else a shallow clone in the temp directory (reused). */
function checkout() {
  const dir = values.source !== undefined ? resolve(values.source) : join(tmpdir(), `aa-meshcall-${manifest.commit.slice(0, 12)}`)
  if (values.source === undefined && !existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    run('git', ['init', '-q'], { cwd: dir })
    run('git', ['fetch', '-q', '--depth', '1', manifest.repository, manifest.commit], { cwd: dir })
    run('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: dir })
  }
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: dir })
  if (head !== manifest.commit) throw new Error(`${dir} is at ${head}, not the pinned ${manifest.commit}`)
  return dir
}

/** @param {string} source @param {string} target @param {string} path */
function build(source, target, path) {
  const [goos, goarch] = /** @type {[string, string]} */ (TARGETS[/** @type {keyof typeof TARGETS} */ (target)])
  run('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -buildid= -X main.version=${manifest.version}`, '-o', path, './cmd/meshcall-router'], {
    cwd: join(source, 'meshcall-router'),
    env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch, GOTOOLCHAIN: manifest.go, GOFLAGS: '-mod=readonly' },
  })
}

const source = values.from === undefined ? checkout() : null
const recorded = { ...manifest.targets }
let failed = false
for (const target of targets) {
  const path = join(out, target, executable(target))
  mkdirSync(dirname(path), { recursive: true })
  if (source !== null) build(source, target, path)
  else copyFileSync(join(resolve(/** @type {string} */ (values.from)), target, executable(target)), path)
  chmodSync(path, 0o755)
  const actual = sha256(path)
  if (values.record) {
    recorded[target] = actual
    console.log(`${target}  ${actual}  (recorded)`)
    continue
  }
  const expected = manifest.targets[target]
  if (expected === actual) {
    writeFileSync(`${path}.sha256`, `${actual}  ${executable(target)}\n`)
    console.log(`${target}  ${actual}  ok`)
  } else {
    rmSync(path, { force: true })
    console.error(`${target}  ${actual}  does not match the recorded ${expected ?? '(none)'}; removed`)
    failed = true
  }
}
if (values.record) {
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, targets: Object.fromEntries(Object.entries(recorded).sort()) }, null, 2)}\n`)
}
if (failed) process.exit(1)
