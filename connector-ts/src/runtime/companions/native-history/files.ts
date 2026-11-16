// 有界读取原生会话文件的小工具：目录列表、文件头、文件签名。只读，不跟随目录符号链接。
// ported from effi-crew cloud/agentd/src/conv/cli-files.ts @30f8334（`dirNames`、`headLines` 的有界读取思路；
// 那里只认 Claude / Codex，这里给 Pi 的 JSONL 用）。

import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'

export async function dirNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

/** 文件第一行（最多 `maxBytes`）；读不到或没有换行且超长时返回 undefined。 */
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

/** `child` 是否在 `root` 之内（两者都应是解析过符号链接的绝对路径）。 */
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
 * 递归列出 `roots` 下的 `*.jsonl`（按名字排序，跳过点开头的目录，不跟随目录符号链接）。文件解析到来源之外的报错。
 * 返回解析后的真实路径。
 */
export async function walkJsonl(roots: readonly string[]): Promise<{ files: string[]; errors: WalkError[] }> {
  const files: string[] = []
  const errors: WalkError[] = []
  const realRoots: string[] = []
  for (const root of roots) {
    try {
      realRoots.push(await realpath(root))
    } catch {
      // 不存在的来源不算错误
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
