// Bundles the v3 Connector (../connector-ts) into lib/bundled-connector/: `anywhere-cli.js` and the files it loads
// at run time, built by the Connector's own scripts/bundle.mjs, plus the MeshCall Router of every platform found
// under connector-ts/router/<target>/ (scripts/fetch-router.mjs builds them) as router/<target>/meshcall-router.
//
// `DSH_BRIDGE_ROUTER_TARGETS` (comma-separated targets, or `all`) lists the Routers a release must carry; the build
// fails when one is missing. Without it, whatever Routers exist are copied (none: set MESHCALL_ROUTER_BINARY to run).
// Needs connector-ts dependencies installed (`cd ../connector-ts && yarn install`).
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ALL_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']
/** What the plugin runs: the CLI entry, the store worker it starts, and the files Runtime profiles read. */
const SHIPPED = ['anywhere-cli.js', 'agent-tools.js', 'worker-entry.js', 'assets', 'dependencies.json', 'package.json']

const connector = fileURLToPath(new URL('../../connector-ts/', import.meta.url))
const target = fileURLToPath(new URL('../lib/bundled-connector/', import.meta.url))
await stat(join(connector, 'node_modules', 'esbuild')).catch(() => {
  throw new Error(`connector-ts dependencies are not installed: run \`yarn install\` in ${connector}`)
})

const staging = await mkdtemp(join(tmpdir(), 'aa-dsh-connector-'))
try {
  execFileSync(process.execPath, [join(connector, 'scripts', 'bundle.mjs'), '--outdir', staging], { cwd: connector, stdio: 'inherit' })
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const entry of SHIPPED) await cp(join(staging, entry), join(target, entry), { recursive: true })
  for (const legal of (await readdir(staging)).filter(name => name.endsWith('.LEGAL.txt'))) await cp(join(staging, legal), join(target, legal))
} finally {
  await rm(staging, { recursive: true, force: true })
}

const required = (process.env['DSH_BRIDGE_ROUTER_TARGETS'] ?? '').trim()
const wanted = required === 'all' ? ALL_TARGETS : required.split(',').map(item => item.trim()).filter(Boolean)
const unknown = wanted.filter(item => !ALL_TARGETS.includes(item))
if (unknown.length) throw new Error(`unknown Router targets: ${unknown.join(', ')}`)
const copied: string[] = []
for (const platform of ALL_TARGETS) {
  const executable = platform.startsWith('win32-') ? 'meshcall-router.exe' : 'meshcall-router'
  const source = join(connector, 'router', platform, executable)
  if (!await stat(source).then(() => true, () => false)) {
    if (wanted.includes(platform)) throw new Error(`no Router for ${platform}: run node ../connector-ts/scripts/fetch-router.mjs --target ${platform}`)
    continue
  }
  await mkdir(join(target, 'router', platform), { recursive: true })
  await cp(source, join(target, 'router', platform, executable))
  copied.push(platform)
}
console.log(`已打包内置 Connector${copied.length ? `，含 ${copied.join('、')} 的 MeshCall Router` : '（未含 Router，运行时需设置 MESHCALL_ROUTER_BINARY）'}。`)
