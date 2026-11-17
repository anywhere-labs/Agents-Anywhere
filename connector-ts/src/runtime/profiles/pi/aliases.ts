// Alias table for Pi native session IDs: once reported, an external ID never changes.
//
// Why: when a new session is reclaimed as idle before Pi has written its native file, waking it up can only attach
// a new native session (session.ts `restartEmpty`), and the session ID Pi gives changes with it. A records
// `RuntimeSession.nativeSessionId` as the session's externalSessionId; it is also an input to Timeline item
// source.sessionId, native session inventory dedup and read-only history item IDs (`pi_native_...`), so externally
// it must always be the original ID.
//
// How: record "actual ID -> original ID" and persist it in the instance data directory
// (`<instance dir>/pi-session-aliases.json`). Everything external (RuntimeSession.nativeSessionId,
// listNativeSessions, readNativeHistory input and item IDs, open(existing)) uses the original ID; processes, file
// locks, permission and plan markers and write verification use the actual ID. Sessions without an alias have the
// same ID for both; a missing file means an empty table.

import { readFileSync } from 'node:fs'

import type { PiAliasLookup } from '../../companions/native-history/index.js'
import { privateJson } from './settings.js'

interface AliasFile {
  readonly version: 1
  /** Actual native ID -> ID originally reported externally. */
  readonly aliases: Readonly<Record<string, string>>
}

export class PiSessionAliases implements PiAliasLookup {
  private readonly toOriginal = new Map<string, string>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly file: string) {
    let parsed: Partial<AliasFile> = {}
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AliasFile>
    } catch {
      // Missing or unreadable: treat as an empty table (only affects new sessions that never wrote a native file before going idle)
    }
    const aliases = parsed.version === 1 && parsed.aliases !== null && typeof parsed.aliases === 'object' ? parsed.aliases : {}
    for (const [actual, original] of Object.entries(aliases)) {
      if (typeof original === 'string' && original !== '' && original !== actual) this.toOriginal.set(actual, original)
    }
  }

  /** External ID: the original one when the actual ID has an alias, otherwise unchanged. */
  original(actual: string): string {
    return this.toOriginal.get(actual) ?? actual
  }

  /** Actual ID currently behind an external ID (the most recently recorded); unchanged when there is no alias. */
  actual(original: string): string {
    let found = original
    for (const [actual, first] of this.toOriginal) if (first === original) found = actual
    return found
  }

  /**
   * The session changed native ID: `previous` is the actual ID before the change (which may already have an alias),
   * `next` the new one. Returns only after the write completes; read-modify-write is serialised within an instance.
   */
  record(previous: string, next: string): Promise<void> {
    if (previous === next) return Promise.resolve()
    const original = this.original(previous)
    this.toOriginal.delete(previous)
    if (original !== next) this.toOriginal.set(next, original)
    const write = this.chain.catch(() => undefined).then(() => privateJson(this.file, { version: 1, aliases: Object.fromEntries(this.toOriginal) } satisfies AliasFile))
    this.chain = write
    return write
  }
}
