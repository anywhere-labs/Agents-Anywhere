// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/ipc/candidates.py @98dd0e6e5 (candidate thread source)
//
// `$CODEX_HOME/thread-writer-locks/`: which threads some app-server has loaded.
//
// When an app-server first loads a thread it creates `<thread>.lock` and holds an flock on it; after release Codex
// may delete the file or leave it, so a file only means "worth asking", and `_codex/session/inspect` decides whether
// it is held. This is the candidate source for auto-follow: it needs neither the AIR `sessionIndex` declaration
// (which `_session/list/subscribe` requires) nor `_codex/ipc/sessions` (which lists only codex-acp's own owners; the
// official App does not answer it).

import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const WRITER_LOCK_DIRECTORY = 'thread-writer-locks'
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface LockEntry {
  readonly threadId: string
  readonly mtimeMs: number
}

export interface LockDirectory {
  /** Current lock files, newest first. Empty when the directory does not exist. */
  list(): Promise<readonly LockEntry[]>
  /** Called when the directory changes (not guaranteed for every change; callers also poll as a fallback). Returns a stop function. */
  watch(onChange: () => void): () => void
}

export function lockDirectory(codexHome: string): LockDirectory {
  const directory = join(codexHome, WRITER_LOCK_DIRECTORY)
  return {
    async list() {
      let names: string[]
      try {
        names = await readdir(directory)
      } catch {
        return []
      }
      const entries: LockEntry[] = []
      for (const name of names) {
        if (!name.endsWith('.lock')) continue
        const threadId = name.slice(0, -'.lock'.length)
        if (!THREAD_ID.test(threadId)) continue
        try {
          entries.push({ threadId: threadId.toLowerCase(), mtimeMs: (await stat(join(directory, name))).mtimeMs })
        } catch {
          // just deleted
        }
      }
      return entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    },
    watch(onChange) {
      let watcher: FSWatcher | undefined
      try {
        watcher = watch(directory, { persistent: false }, () => onChange())
        watcher.on('error', () => watcher?.close())
      } catch {
        // The directory does not exist yet (Codex not installed or no thread ever loaded): rely on polling.
      }
      return () => watcher?.close()
    },
  }
}
