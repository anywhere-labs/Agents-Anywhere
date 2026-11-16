// Builds the shippable Connector: one ESM bundle per process entry, plus the files they load at run time.
//
//   dist/anywhere-cli.js    the `anywhere-cli` executable (DSH runs it with its own Node)
//   dist/desktop-main.js    Desktop's utility process (`utilityProcess.fork`)
//   dist/worker-entry.js    the store worker thread both of them start (`new URL('./worker-entry.js', import.meta.url)`)
//   dist/assets/, dist/dependencies.json   files Runtime profiles read next to their module
//   dist/router/            the MeshCall Router for the package's platform, from router/<target>/ (scripts/fetch-router.mjs)
//
// Native modules stay external and ship beside the bundle in `node_modules/` (node-pty, and ws's optional
// accelerators). SQLite is `node:sqlite`, nothing to ship. Not a Node SEA: the hosts bring their own Node.
//
// usage: node scripts/bundle.mjs [--outdir dist] [--router-target darwin-arm64] [--smoke]
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Worker } from 'node:worker_threads'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { outdir: { type: 'string', default: 'dist' }, 'router-target': { type: 'string' }, smoke: { type: 'boolean', default: false } } })
const outdir = resolve(root, values.outdir ?? 'dist')

/** Native or optional at run time: resolved from `node_modules/` next to the bundle, never inlined. */
const EXTERNAL = ['node-pty', 'bufferutil', 'utf-8-validate', '@opentelemetry/api']

/**
 * Files modules read through `new URL('./…', import.meta.url)`: in a bundle that URL is the bundle's own.
 * @type {readonly (readonly [string, string])[]}
 */
const RUNTIME_FILES = [
  ['src/runtime/profiles/pi/assets/sdk-bridge.mjs', 'assets/sdk-bridge.mjs'],
  ['src/runtime/profiles/pi/assets/permissions.mjs', 'assets/permissions.mjs'],
  ['src/runtime/supervisor/assets/electron-node.mjs', 'assets/electron-node.mjs'],
  ['src/runtime/profiles/pi/dependencies.json', 'dependencies.json'],
]

rmSync(outdir, { recursive: true, force: true })
await build({
  absWorkingDir: root,
  entryPoints: {
    'anywhere-cli': 'src/entry/main.ts',
    'desktop-main': 'src/entry/desktop-main.ts',
    'worker-entry': 'src/store/worker-entry.ts',
  },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.13',
  external: EXTERNAL,
  // CommonJS dependencies (ws, ajv) call require(); an ESM bundle has none of its own.
  banner: { js: "import { createRequire as __aaCreateRequire } from 'node:module'; const require = __aaCreateRequire(import.meta.url);" },
  sourcemap: 'linked',
  legalComments: 'linked',
  logLevel: 'warning',
})
for (const [from, to] of RUNTIME_FILES) {
  mkdirSync(dirname(join(outdir, to)), { recursive: true })
  cpSync(join(root, from), join(outdir, to))
}
writeFileSync(join(outdir, 'package.json'), `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`)
// One platform per package: the Router that scripts/fetch-router.mjs built and verified for it.
const routerTarget = values['router-target'] ?? `${process.platform}-${process.arch}`
const routerDir = join(root, 'router', routerTarget)
if (existsSync(routerDir)) cpSync(routerDir, join(outdir, 'router'), { recursive: true, filter: source => !source.endsWith('.sha256') })
else if (values['router-target'] !== undefined) throw new Error(`no Router for ${routerTarget}: run node scripts/fetch-router.mjs --target ${routerTarget}`)
console.log(`bundled into ${outdir}${existsSync(routerDir) ? ` with the ${routerTarget} Router` : ' (no Router)'}`)

if (values.smoke) {
  // The CLI starts and the store worker opens and migrates a store, from the bundle alone.
  const version = execFileSync(process.execPath, [join(outdir, 'anywhere-cli.js'), '--version'], { encoding: 'utf8' }).trim()
  const dataDir = mkdtempSync(join(tmpdir(), 'aa-bundle-'))
  try {
    const ready = await new Promise((resolveReady, reject) => {
      const worker = new Worker(join(outdir, 'worker-entry.js'), { workerData: { dataDir, durability: 'normal' } })
      worker.once('error', reject)
      worker.once('message', message => {
        void worker.terminate()
        message.type === 'ready' ? resolveReady(message) : reject(new Error(JSON.stringify(message)))
      })
    })
    const shipped = join(outdir, 'router', process.platform === 'win32' ? 'meshcall-router.exe' : 'meshcall-router')
    if (existsSync(shipped)) console.log(`smoke: ${execFileSync(shipped, ['--version'], { encoding: 'utf8' }).trim()}`)
    console.log(`smoke: anywhere-cli ${version}; store worker ready (epoch ${ready.storeEpoch}, ${Object.keys(ready.methods ?? {}).length} store methods)`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}
