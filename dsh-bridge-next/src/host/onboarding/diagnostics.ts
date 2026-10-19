import type { Logger } from '@deepseek-ai/cordis'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeDiagnostics, type DiagnosticEntry, type Level } from '../dsh-runtime/diagnostics.js'

/** Installation and onboarding diagnostics remain local in this migration. */
export function onboardingDiagnostics(sink: Pick<Logger, Level>, directory: string): RuntimeDiagnostics {
  let pending = Promise.resolve()
  let queued = 0
  return new RuntimeDiagnostics({
    write(entry: DiagnosticEntry) {
      try { sink[entry.level]('event=%s %s', entry.message, entry.details) } catch { /* best effort */ }
      if (queued >= 256) return
      queued++
      pending = pending.then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const path = join(directory, 'onboarding.jsonl')
        if (await stat(path).then(value => value.size, () => 0) > 2 * 1024 * 1024) {
          await rename(path, join(directory, 'onboarding.previous.jsonl'))
        }
        await appendFile(path, JSON.stringify(entry) + '\n', { mode: 0o600 })
      }).catch(() => undefined).finally(() => { queued-- })
    },
    async flush() { await pending },
  })
}
