/**
 * uv runtime detection — four-level resolver.
 *
 * Mirrors section 3.1.2 of the technical proposal:
 *
 *   1. User override — explicit `UV_PATH` env var or plugin config.
 *   2. System PATH — `which uv` / `where.exe uv`.
 *   3. NPM-bundled binary — `@agents-anywhere/uv-<platform>-<arch>`.
 *   4. Runtime download — already cached at `~/.agents-anywhere/bin/uv`.
 *
 * Each probe is a single source of truth for one resolution tier; the public
 * `EnvDetector.resolve` chains them in priority order and returns the first
 * success. The detector never throws — callers receive a structured result
 * they can surface in the settings UI or feed to the process runner.
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/** Where a resolved uv binary came from. */
export type UvSource = 'custom' | 'system' | 'npm-bundled' | 'downloaded' | 'unresolved'

/** Resolution result for a uv probe. */
export interface UvResolutionResult {
  /** Absolute path to the uv executable; `null` if no tier matched. */
  uvPath: string | null
  /** Which tier the result came from. */
  source: UvSource
  /** Raw `uv --version` output, when available. */
  version: string | null
  /** True when the resolved path passed `uv --version` execution. */
  executable: boolean
  /** Human-readable explanation of what each tier reported (for the settings UI). */
  notes: ReadonlyArray<string>
}

const PLATFORM_PACKAGE_PREFIX = '@agents-anywhere/uv-'
const DOWNLOAD_DIR_NAME = '.agents-anywhere'

interface ResolverOptions {
  /** Override the env var lookup (used by tests + plugin config bridge). */
  env?: NodeJS.ProcessEnv
  /** Override the home directory lookup (used by tests). */
  homeDir?: string
  /** Override the platform triple (used by tests). */
  platform?: NodeJS.Platform
  /** Override the architecture string (used by tests). */
  arch?: string
  /** Custom uv path that outranks every tier (used by plugin config). */
  customPath?: string | null
  /** Directory where the bundled package should be resolved from (used by tests). */
  bundleRoot?: string | null
}

export class EnvDetector {
  private readonly env: NodeJS.ProcessEnv
  private readonly homeDir: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly customPath: string | null | undefined
  private readonly bundleRoot: string | null | undefined

  constructor(options: ResolverOptions = {}) {
    this.env = options.env ?? process.env
    this.homeDir = options.homeDir ?? os.homedir()
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.customPath = options.customPath
    this.bundleRoot = options.bundleRoot
  }

  /** Run the four-tier resolution and return the first successful probe. */
  resolve(): UvResolutionResult {
    const notes: string[] = []
    const tiers: ReadonlyArray<{ name: string; result: UvResolutionResult }> = [
      { name: 'custom', result: this.probeCustom() },
      { name: 'system', result: this.probeSystem() },
      { name: 'npm-bundled', result: this.probeNpmBundled() },
      { name: 'downloaded', result: this.probeDownloaded() },
    ]
    for (const tier of tiers) {
      notes.push(`${tier.name}: ${formatProbe(tier.result)}`)
      if (tier.result.uvPath !== null && tier.result.executable) {
        return { ...tier.result, notes }
      }
    }
    return {
      uvPath: null,
      source: 'unresolved',
      version: null,
      executable: false,
      notes,
    }
  }

  /** Probe tier 1: `UV_PATH` env var or explicit `customPath`. */
  private probeCustom(): UvResolutionResult {
    const explicit = this.customPath ?? this.env.UV_PATH
    if (explicit === undefined || explicit.length === 0) {
      return { uvPath: null, source: 'custom', version: null, executable: false, notes: [] }
    }
    if (!existsSync(explicit)) {
      return { uvPath: null, source: 'custom', version: null, executable: false, notes: [`UV_PATH not found: ${explicit}`] }
    }
    const version = readVersion(explicit)
    return {
      uvPath: explicit,
      source: 'custom',
      version,
      executable: version !== null,
      notes: version !== null ? [] : [`UV_PATH executable returned no version: ${explicit}`],
    }
  }

  /** Probe tier 2: `which uv` / `where.exe uv`. */
  private probeSystem(): UvResolutionResult {
    try {
      const cmd = this.platform === 'win32' ? 'where.exe' : 'which'
      const output = execFileSync(cmd, ['uv'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      const first = output.split(/\r?\n/)[0]?.trim()
      if (first === undefined || first.length === 0 || !existsSync(first)) {
        return { uvPath: null, source: 'system', version: null, executable: false, notes: ['which uv returned no path'] }
      }
      const version = readVersion(first)
      return {
        uvPath: first,
        source: 'system',
        version,
        executable: version !== null,
        notes: version !== null ? [] : [`system uv not executable: ${first}`],
      }
    } catch {
      return { uvPath: null, source: 'system', version: null, executable: false, notes: ['which uv failed'] }
    }
  }

  /**
   * Probe tier 3: the bundled NPM package (`@agents-anywhere/uv-<platform>-<arch>`).
   * Resolves the package via `createRequire(path).resolve(name, { paths })`.
   * In production `bundleRoot` is the plugin install directory; tests pass a
   * temp directory with a mocked `node_modules` tree.
   */
  private probeNpmBundled(): UvResolutionResult {
    const triple = `${this.platform}-${this.arch}`
    const packageName = `${PLATFORM_PACKAGE_PREFIX}${triple}`
    const binName = this.platform === 'win32' ? 'uv.exe' : 'uv'
    const lookup = createRequire(import.meta.url)
    const searchPaths = this.bundleRoot !== undefined && this.bundleRoot !== null
      ? [this.bundleRoot]
      : []
    let entry: string | null = null
    try {
      const resolved = lookup.resolve(packageName, { paths: searchPaths })
      entry = path.join(path.dirname(resolved), 'bin', binName)
    } catch {
      try {
        entry = lookup.resolve(`${packageName}/bin/${binName}`, { paths: searchPaths })
      } catch {
        entry = null
      }
    }
    if (entry === null || !existsSync(entry)) {
      return {
        uvPath: null,
        source: 'npm-bundled',
        version: null,
        executable: false,
        notes: [`bundled package ${packageName} not installed`],
      }
    }
    // Normalize `/private/var/...` → `/var/...` on macOS where Node's
    // resolver follows the symlink in `/var` → `/private/var`.
    const normalized = safeRealpath(entry)
    const version = readVersion(normalized)
    return {
      uvPath: normalized,
      source: 'npm-bundled',
      version,
      executable: version !== null,
      notes: version !== null ? [] : [`bundled uv not executable: ${normalized}`],
    }
  }

  /**
   * Probe tier 4: a uv binary previously downloaded to `~/.agents-anywhere/bin/uv`.
   * The download itself is owned by `process-runner`; this probe only checks
   * for an existing artifact so we can surface it in the settings UI.
   */
  private probeDownloaded(): UvResolutionResult {
    const file = path.join(this.homeDir, DOWNLOAD_DIR_NAME, 'bin', this.platform === 'win32' ? 'uv.exe' : 'uv')
    if (!existsSync(file)) {
      return { uvPath: null, source: 'downloaded', version: null, executable: false, notes: ['no downloaded uv in ~/.agents-anywhere/bin'] }
    }
    const version = readVersion(file)
    return {
      uvPath: file,
      source: 'downloaded',
      version,
      executable: version !== null,
      notes: version !== null ? [] : [`downloaded uv not executable: ${file}`],
    }
  }
}

function readVersion(executable: string): string | null {
  try {
    const output = execFileSync(executable, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return output.length > 0 ? output : null
  } catch {
    return null
  }
}

function safeRealpath(target: string): string {
  try {
    // `realpathSync` is the synchronous sibling we already rely on for
    // filesystem checks; it follows the same `/private` → `/var` chain on
    // macOS that `require.resolve` may keep opaque.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { realpathSync } = require('node:fs') as typeof import('node:fs')
    return realpathSync(target)
  } catch {
    return target
  }
}

function formatProbe(result: UvResolutionResult): string {
  if (result.uvPath !== null && result.executable) return `${result.source} ✓ (${result.version ?? 'unknown'})`
  if (result.uvPath !== null) return `${result.source} ✗ not executable`
  if (result.notes.length > 0) return result.notes[0]!
  return result.source
}