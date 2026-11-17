// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/history.py @98dd0e6e5 (discover_history_files)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/native_runtime.py @98dd0e6e5 (scan, list_sessions)
//
// Read-only index of Pi native sessions: inventories the JSONL in the source directories and rereads only files whose
// signature changed. Browsing lives here; handover is in profiles/pi/session.ts.

import { open } from 'node:fs/promises'

import type { NativeSessionPage, NativeSessionRef, NativeSessionSummary } from '../../../application/ports/runtime-session.js'
import { fail } from '../../acp/errors.js'
import { firstLine, walkJsonl, type WalkError } from './files.js'
import { readPiHistory, type PiHistory } from './pi-history.js'

export const PAGE_SIZE = 100

export interface PiSource {
  /** Session ID from the file header (the real ID). */
  readonly nativeSessionId: string
  /** Session ID reported externally: the original one when the session changed native IDs (profiles/pi/aliases.ts), else the same as nativeSessionId. */
  readonly externalSessionId: string
  /** File path with symlinks resolved. */
  readonly path: string
  readonly cwd: string
  readonly title: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly revision: string
  readonly version?: unknown
  readonly complete: boolean
  readonly ownedByAgentsAnywhere: boolean
  /** Several files claim the same session identity. */
  ambiguous: boolean
}

/** Native session ID aliases (maintained by the Pi profile): maps between external IDs and the real IDs in file headers. */
export interface PiAliasLookup {
  original(actual: string): string
  actual(original: string): string
}

const NO_ALIASES: PiAliasLookup = { original: id => id, actual: id => id }

interface Cached {
  readonly signature: string
  readonly source: PiSource
}

async function signature(path: string): Promise<{ id: string; signature: string } | undefined> {
  const line = await firstLine(path)
  if (line === undefined) return undefined
  let header: unknown
  try {
    header = JSON.parse(line)
  } catch {
    return undefined
  }
  const record = header as { type?: unknown; id?: unknown }
  if (record === null || typeof record !== 'object' || record.type !== 'session' || typeof record.id !== 'string' || record.id === '') return undefined
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat({ bigint: true })
    return { id: record.id, signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}` }
  } finally {
    await handle.close()
  }
}

function sourceOf(history: PiHistory): PiSource {
  return {
    nativeSessionId: history.nativeId,
    externalSessionId: history.nativeId,
    path: history.path,
    cwd: history.cwd,
    title: history.title,
    ...(history.createdAt !== undefined ? { createdAt: history.createdAt } : {}),
    ...(history.updatedAt !== undefined ? { updatedAt: history.updatedAt } : {}),
    revision: history.revision,
    version: history.version,
    complete: history.complete,
    ownedByAgentsAnywhere: history.ownedByAgentsAnywhere,
    ambiguous: false,
  }
}

export class PiNativeIndex {
  private readonly cache = new Map<string, Cached>()
  private scanning: Promise<PiSource[]> | undefined
  lastErrors: readonly WalkError[] = []

  /** `roots`: re-evaluated on every inventory (the sessionDir in settings.json may have changed). */
  constructor(private readonly roots: () => readonly string[], private readonly aliases: PiAliasLookup = NO_ALIASES) {}

  /** Adds the external ID (an alias may be recorded after caching, so it is computed on every read). */
  private external(source: PiSource): PiSource {
    return { ...source, externalSessionId: this.aliases.original(source.nativeSessionId) }
  }

  /** Takes an inventory (concurrent calls share one). A source that is temporarily unreadable is not a deletion: its known sessions drop out of the result, without an error. */
  scan(): Promise<PiSource[]> {
    this.scanning ??= this.scanOnce().finally(() => {
      this.scanning = undefined
    })
    return this.scanning
  }

  private async scanOnce(): Promise<PiSource[]> {
    const roots = this.roots()
    const { files, errors } = await walkJsonl(roots)
    const seen = new Set<string>()
    for (const path of files) {
      const found = await signature(path)
      if (found === undefined) {
        errors.push({ path, code: 'pi_history_unreadable' })
        continue
      }
      seen.add(path)
      if (this.cache.get(path)?.signature === found.signature) continue
      try {
        this.cache.set(path, { signature: found.signature, source: sourceOf(await readPiHistory(path, roots)) })
      } catch (error) {
        errors.push({ path, code: (error as { error?: { code?: string } }).error?.code ?? 'pi_history_unreadable' })
      }
    }
    for (const path of [...this.cache.keys()]) if (!seen.has(path)) this.cache.delete(path)
    const sources = [...this.cache.values()].map(entry => entry.source)
    const counts = new Map<string, number>()
    for (const source of sources) counts.set(source.nativeSessionId, (counts.get(source.nativeSessionId) ?? 0) + 1)
    for (const source of sources) source.ambiguous = (counts.get(source.nativeSessionId) ?? 0) > 1
    this.lastErrors = errors
    return sources
  }

  /** Native session inventory: most recently updated first, 100 per page; the cursor is an offset. */
  async list(cursor?: string): Promise<NativeSessionPage> {
    const sources = (await this.scan()).sort((a, b) => {
      const left = a.updatedAt ?? ''
      const right = b.updatedAt ?? ''
      return left !== right ? (left < right ? 1 : -1) : a.path < b.path ? 1 : -1
    })
    const offset = cursor !== undefined && /^\d+$/.test(cursor) ? Number(cursor) : 0
    const page = sources.slice(offset, offset + PAGE_SIZE)
    return {
      sessions: page.map(source => summary(this.external(source))),
      ...(offset + PAGE_SIZE < sources.length ? { nextCursor: String(offset + PAGE_SIZE) } : {}),
    }
  }

  /**
   * Finds the file a reference points to: by location when given (it must be inside a source with a matching
   * identity), otherwise by session ID (rejected when several match). IDs in references are external IDs and are
   * mapped to real IDs through aliases before comparing.
   */
  async find(ref: NativeSessionRef): Promise<PiSource> {
    const sources = await this.scan()
    const actual = this.aliases.actual(ref.nativeSessionId)
    if (ref.locator !== undefined && ref.locator !== '') {
      let history: PiHistory
      try {
        history = await readPiHistory(ref.locator, this.roots())
      } catch (error) {
        if ((error as { error?: unknown }).error !== undefined) throw error
        fail('pi_source_missing', '原生历史来源暂时不可用。')
      }
      if (history.nativeId !== actual) fail('pi_source_identity_changed', '原位置已是另一原生会话，不能继续原绑定。')
      const source = this.external(sourceOf(history))
      source.ambiguous = sources.filter(item => item.nativeSessionId === actual).length > 1
      return source
    }
    const matches = sources.filter(source => source.nativeSessionId === actual)
    if (matches.length > 1) fail('pi_source_ambiguous', '多个历史文件具有相同会话身份，请先确认来源。')
    if (matches.length === 0) fail('pi_source_missing', '找不到这个 Pi 原生会话。')
    return this.external(matches[0]!)
  }

  read(path: string): Promise<PiHistory> {
    return readPiHistory(path, this.roots())
  }
}

export function summary(source: PiSource): NativeSessionSummary {
  return {
    nativeSessionId: source.externalSessionId,
    locator: source.path,
    title: source.title,
    cwd: source.cwd,
    ...(source.createdAt !== undefined ? { createdAt: source.createdAt } : {}),
    ...(source.updatedAt !== undefined ? { updatedAt: source.updatedAt } : {}),
    ...(source.ownedByAgentsAnywhere ? { ownedByAgentsAnywhere: true } : {}),
  }
}
