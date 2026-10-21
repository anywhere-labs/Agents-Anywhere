import type { Logger } from '@deepseek-ai/cordis'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeDiagnostics, type DiagnosticEntry, type DiagnosticOutput, type Level } from '../dsh-runtime/diagnostics.js'

/** Pre-startup and installation diagnostics are kept locally and also forwarded to the central Logs output when provided. */
export function onboardingDiagnostics(
  sink: Pick<Logger, Level>,
  directory: string,
  secondary?: DiagnosticOutput,
): RuntimeDiagnostics {
  let pending = Promise.resolve()
  let queued = 0
  return new RuntimeDiagnostics({
    write(entry: DiagnosticEntry) {
      try { sink[entry.level]('event=%s %s', entry.message, entry.details) } catch { /* best effort */ }
      try { secondary?.write(entry) } catch { /* best effort */ }
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
    async flush() {
      await Promise.all([pending, secondary?.flush() ?? Promise.resolve()])
    },
  }, {}, 'dsh-plugin')
}
