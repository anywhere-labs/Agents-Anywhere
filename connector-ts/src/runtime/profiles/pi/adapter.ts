// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/adapter.py @98dd0e6e5 (adapter compatibility patch)
//
// A small, anchor-verified compatibility patch of the third-party release `@openma/pi-acp`.
//
// Interim measure (04-connector.md §5.4): the patch goes away once upstream or a maintained fork takes the changes.
// Every anchor must match before use; if one does not, preparation stops. It never runs with half a patch.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { JsonObject } from '../../../application/ports/runtime-session.js'
import { acpFingerprint } from '../../../domain/identity/index.js'
import { fail } from '../../acp/errors.js'
import { fileLock } from '../../supervisor/npm-runtime.js'

export const PATCH_REVISION = 6
/** The patch entry points have not changed across 0.1.x so far; every anchor below must still match. */
export const SUPPORTED_ADAPTER: readonly [number, number] = [0, 1]
export const BRIDGE_TEMPLATE = fileURLToPath(new URL('./assets/sdk-bridge.mjs', import.meta.url))

export const ANCHORS: ReadonlyArray<readonly [string, string]> = [
  [
    'async function findSession(sessionId, sessionDir) {',
    'async function findSession(sessionId, sessionDir) {\n  if(process.env.AA_PI_SESSION_FILE) return aaFindSession(sessionId);',
  ],
  [
    'await session.prompt(converted.text, converted.images)',
    'await aaWithMessage(params, () => session.prompt(converted.text, converted.images))',
  ],
  [
    'await session.steer(converted.text, converted.images)',
    'await aaWithMessage(params, () => session.steer(converted.text, converted.images))',
  ],
  [
    'return buildConfigOptions(this.session, {\n      booleanOptions: this.features.booleanConfigOptions\n    });',
    'return aaConfigOptions(this.session, buildConfigOptions(this.session, {\n      booleanOptions: this.features.booleanConfigOptions\n    }));',
  ],
  [
    'extensions: session.extensions(),',
    'extensions: session.extensions(), aaLoadingReport: aaLoadingReport(),',
  ],
]
/**
 * When opening a session, an unavailable model is only logged; after the patch it fails outright (no silent model
 * switch). `.` does not cross line breaks.
 */
const REQUIRE_MODEL = /await this\.requireModel\(session\)\.catch\(\(error\) => \{\n.*?\n {4}\}\);/g

export function adapterVersion(packageRoot: string): string {
  const version = (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown }).version
  const parts = String(version).split('-')[0]!.split('.').map(Number)
  if (!(parts.length >= 2 && parts[0] === SUPPORTED_ADAPTER[0] && parts[1] === SUPPORTED_ADAPTER[1] && parts.every(Number.isInteger))) {
    fail('pi_adapter_incompatible', `Pi ACP 适配器 ${String(version)} 不受支持，需要 0.1.x。`)
  }
  return String(version)
}

/** Patches every dist/*.js of the release; fails if any anchor is not found. */
export function patchSources(sources: Readonly<Record<string, string>>): Record<string, string> {
  const patched: Record<string, string> = {}
  for (const [name, source] of Object.entries(sources)) patched[name] = source.replaceAll('"@earendil-works/pi-coding-agent"', '"../sdk-bridge.mjs"')
  const touched = new Set<string>()
  for (const [old, replacement] of ANCHORS) {
    const owners = Object.keys(patched).filter(name => patched[name]!.includes(old))
    if (!owners.length) fail('pi_adapter_patch_failed', 'Pi ACP 兼容入口已变化，已停止准备。')
    for (const name of owners) patched[name] = patched[name]!.replaceAll(old, replacement)
    for (const name of owners) touched.add(name)
  }
  let matches = 0
  for (const name of Object.keys(patched)) {
    let count = 0
    patched[name] = patched[name]!.replace(REQUIRE_MODEL, () => {
      count += 1
      return 'await this.requireModel(session);'
    })
    matches += count
    if (count) touched.add(name)
  }
  if (matches !== 3) fail('pi_adapter_patch_failed', 'Pi ACP 模型就绪校验入口已变化。')
  for (const name of touched) {
    patched[name] = 'import {aaFindSession, aaWithMessage, aaConfigOptions, aaLoadingReport} from "../sdk-bridge.mjs";\n'
      + patched[name]!.replace('if (pi.model === void 0 && available.length > 0) {', 'if (pi.model === void 0 && available.length > 0 && !process.env.AA_PI_SESSION_FILE) {')
  }
  return patched
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

export interface PreparedAdapter {
  /** Patched entry (dist/<entry name> in the cache). */
  readonly entry: string
  readonly metadata: JsonObject
}

/** node_modules holding the adapter's dependencies (the package's own, or the one it sits in). */
function dependencyRoot(packageRoot: string): string | undefined {
  for (let current = packageRoot; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules')
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // keep walking up
    }
    if (dirname(current) === current) return undefined
  }
}

/**
 * Builds a patched executable copy at `root/<patch digest>`: the release files, the SDK bridge (with the absolute
 * SDK URL written in) and a node_modules link back to the original dependencies. An existing cache with the same
 * name is compared byte by byte; executables in an old cache are not trusted.
 */
export async function prepareAdapter(entry: string, sdk: string, root: string): Promise<PreparedAdapter> {
  const packageRoot = dirname(dirname(entry))
  const version = adapterVersion(packageRoot)
  const dist = dirname(entry)
  const sources: Record<string, string> = {}
  for (const name of readdirSync(dist).filter(name => name.endsWith('.js')).sort()) sources[name] = readFileSync(join(dist, name), 'utf8')
  if (sources[basename(entry)] === undefined) fail('pi_adapter_incompatible', 'Pi ACP 适配器入口不存在。')
  const releaseFiles = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, sha256(source)]))
  const patchedSources = patchSources(sources)
  const sdkEntry = join(sdk, 'dist/index.js')
  const bridge = (await readFile(BRIDGE_TEMPLATE, 'utf8')).replaceAll('__AA_PI_SDK_URL__', pathToFileURL(sdkEntry).href)
  // Dependency resolution is part of the executable cache identity: Desktop may move an unchanged npm release from
  // the instance cache to the shared cache, and the old adapter must stay for processes still using it.
  const modules = dependencyRoot(packageRoot)
  if (modules === undefined) fail('pi_adapter_dependencies_missing', 'Pi ACP 依赖目录不存在。')
  const modulesReal = realpathSync(modules)
  const patch = acpFingerprint({ bridge, source: releaseFiles, revision: PATCH_REVISION, dependencyRoot: modulesReal })
  const destination = join(root, patch)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const release = await fileLock(join(root, '.patch.lock'))
  try {
    const staging = join(root, `.adapter-${randomUUID()}`)
    try {
      await cp(packageRoot, staging, { recursive: true, verbatimSymlinks: true, filter: source => basename(source) !== 'node_modules' })
      await writeFile(join(staging, 'sdk-bridge.mjs'), bridge, 'utf8')
      for (const [name, source] of Object.entries(patchedSources)) await writeFile(join(staging, 'dist', name), source, 'utf8')
      // Third-party dependencies still resolve from the original install.
      await symlink(modules, join(staging, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
      if (existsSync(destination)) {
        for (const name of ['sdk-bridge.mjs', ...Object.keys(releaseFiles).map(file => join('dist', file))]) {
          const cached = join(destination, name)
          const fresh = join(staging, name)
          if (!existsSync(cached) || !readFileSync(cached).equals(readFileSync(fresh))) {
            fail('pi_adapter_cache_corrupt', 'Pi ACP 可执行缓存校验失败，请停止相关实例后清理缓存重试。')
          }
        }
        let linked: string | undefined
        try {
          linked = realpathSync(join(destination, 'node_modules'))
        } catch {
          linked = undefined
        }
        if (linked !== modulesReal) fail('pi_adapter_cache_corrupt', 'Pi ACP 缓存依赖来源已变化。')
      } else {
        await rename(staging, destination)
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  } finally {
    await release()
  }
  return {
    entry: join(destination, 'dist', basename(entry)),
    metadata: { package: '@openma/pi-acp', version, sourceFiles: releaseFiles, patchDigest: patch, sdkEntry },
  }
}
