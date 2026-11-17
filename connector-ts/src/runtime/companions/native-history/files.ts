// ported from effi-crew cloud/agentd/src/conv/cli-files.ts @30f8334 (dirNames, headLines)
//
// Small helpers for bounded reads of native session files: directory listings, file heads, file signatures.
// Read-only; directory symlinks are not followed. Used for Pi's JSONL.

import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'

export async function dirNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

/** The first line of a file (at most `maxBytes`); undefined when unreadable, or when there is no newline and it is too long. */
export async function firstLine(path: string, maxBytes = 128 * 1024): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    const text = buffer.subarray(0, bytesRead)
    const newline = text.indexOf(10)
    if (newline < 0 && bytesRead === maxBytes) return undefined
    return new TextDecoder('utf-8', { fatal: true }).decode(newline < 0 ? text : text.subarray(0, newline))
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/** Whether `child` is inside `root` (both should be absolute paths with symlinks resolved). */
export function within(child: string, root: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface WalkError {
  readonly root?: string
  readonly path?: string
  readonly code: string
}

/**
 * Recursively lists `*.jsonl` under `roots` (sorted by name, skipping dot directories, not following directory
 * symlinks). Files that resolve outside their source are reported as errors. Returns the resolved real paths.
 */
export async function walkJsonl(roots: readonly string[]): Promise<{ files: string[]; errors: WalkError[] }> {
  const files: string[] = []
  const errors: WalkError[] = []
  const realRoots: string[] = []
  for (const root of roots) {
    try {
      realRoots.push(await realpath(root))
    } catch {
      // a missing source is not an error
    }
  }
  const visit = async (root: string, directory: string): Promise<void> => {
    let names: string[]
    try {
      names = (await readdir(directory)).sort()
    } catch {
      errors.push({ root, code: 'pi_source_unreadable' })
      return
    }
    for (const name of names) {
      const path = join(directory, name)
      let info
      try {
        info = await lstat(path)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (!name.startsWith('.')) await visit(root, path)
        continue
      }
      if (!name.endsWith('.jsonl')) continue
      try {
        const resolved = await realpath(path)
        if (!realRoots.some(source => within(resolved, source))) throw new Error('outside source')
        if (!(await stat(resolved)).isFile()) throw new Error('not a file')
        files.push(resolved)
      } catch {
        errors.push({ path, code: 'pi_history_unreadable' })
      }
    }
  }
  for (const root of realRoots) await visit(root, root)
  return { files: [...new Set(files)], errors }
}
