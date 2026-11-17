import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { WorkspaceError, invalid } from './errors.js'

/**
 * Which directories the workspace methods may touch (04-connector.md §8: configurable allowed roots, by default
 * the user's home). `extra` adds roots known at call time, such as the working directories of the sessions on
 * this device, so a project outside the home that already has a session keeps working as it did in v2.
 */
export interface RootPolicyOptions {
  /** `'any'` lifts the restriction (v2 behaviour). */
  readonly roots: readonly string[] | 'any'
  readonly extra?: () => Promise<readonly string[]> | readonly string[]
  readonly platform?: NodeJS.Platform
}

/** `AGENT_CONNECTOR_WORKSPACE_ROOTS`: `*` for no restriction, else a path-delimiter separated list; default the home. */
export function rootsFromEnv(env: NodeJS.ProcessEnv = process.env, home = homedir()): readonly string[] | 'any' {
  const raw = env.AGENT_CONNECTOR_WORKSPACE_ROOTS?.trim()
  if (raw === undefined || raw === '') return [home]
  if (raw === '*') return 'any'
  return raw.split(delimiter).map(part => part.trim()).filter(part => part !== '').map(part => expandHome(part, home))
}

export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/** The real path of `path`, resolving symlinks in the part that exists and appending the rest unchanged. */
export async function realPathOf(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      const real = await realpath(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(current.slice(parent.length).replace(/^[\\/]+/u, ''))
      current = parent
    }
  }
}

export class RootPolicy {
  private readonly platform: NodeJS.Platform

  public constructor(private readonly options: RootPolicyOptions) {
    this.platform = options.platform ?? process.platform
  }

  public get unrestricted(): boolean {
    return this.options.roots === 'any'
  }

  /** The configured and extra roots as real paths. */
  public async roots(): Promise<string[]> {
    if (this.options.roots === 'any') return []
    const extra = this.options.extra === undefined ? [] : await this.options.extra()
    const all = [...this.options.roots, ...extra].filter(root => isAbsolute(root))
    return [...new Set(await Promise.all(all.map(root => realPathOf(resolve(root)))))]
  }

  private fold(path: string): string {
    // Windows and the default macOS volumes compare names without case.
    return this.platform === 'win32' || this.platform === 'darwin' ? path.toLowerCase() : path
  }

  private inside(path: string, root: string): boolean {
    const p = this.fold(path)
    const r = this.fold(root)
    if (p === r) return true
    const prefix = r.endsWith(sep) || r.endsWith('/') ? r : r + sep
    return p.startsWith(prefix)
  }

  /** Whether `path` (after resolving symlinks) is inside an allowed root. */
  public async allows(path: string): Promise<boolean> {
    if (this.unrestricted) return true
    const real = await realPathOf(path)
    return (await this.roots()).some(root => this.inside(real, root))
  }

  /** Throws `permission_denied` (reason `outside_allowed_roots`) unless `path` is allowed. */
  public async check(path: string): Promise<void> {
    if (path.includes('\0')) throw invalid('paths must not contain NUL characters')
    if (!(await this.allows(path))) {
      throw new WorkspaceError('permission_denied', `outside the allowed directories: ${path}`, { reason: 'outside_allowed_roots' })
    }
  }

  /** Allowed roots that exist, for a top-level listing when the restriction is on. */
  public async existingRoots(): Promise<string[]> {
    const out: string[] = []
    for (const root of await this.roots()) {
      const info = await stat(root).catch(() => undefined)
      if (info?.isDirectory() === true) out.push(root)
    }
    return out.sort()
  }
}

