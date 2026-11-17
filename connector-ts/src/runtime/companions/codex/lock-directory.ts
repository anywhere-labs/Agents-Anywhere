// `$CODEX_HOME/thread-writer-locks/`：哪些线程被某个 app-server 加载过。
// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/ipc/candidates.py（候选线程来源）
//
// app-server 第一次加载线程时创建 `<线程>.lock` 并持有其上的 flock；释放后 Codex 可能删掉也可能留下文件，
// 所以文件只说明「值得问一下」，持有与否以 `_codex/session/inspect` 为准。
// 这是自动跟随的候选来源：不需要声明 AIR `sessionIndex`（`_session/list/subscribe` 需要），也不依赖
// `_codex/ipc/sessions`（它只列 codex-acp 自己的 owner，官方 App 不响应）。

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
  /** 当前的锁文件，最新的在前。目录不存在时为空。 */
  list(): Promise<readonly LockEntry[]>
  /** 目录有变化时回调（不保证每次变化都通知，调用方另有轮询兜底）。返回停止函数。 */
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
          // 刚被删掉
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
        // 目录还不存在（没装 Codex 或从没加载过线程）：靠轮询。
      }
      return () => watcher?.close()
    },
  }
}
