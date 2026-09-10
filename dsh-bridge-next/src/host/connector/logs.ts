import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

type Event = 'starting' | 'running' | 'stopped' | 'auth_failed' | 'process_error' | 'exited'

/** Bounded lifecycle diagnostics. Raw child output and credentials are never recorded. */
export class ConnectorLogs {
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string) {}
  record(event: Event): void {
    this.pending = this.pending.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const path = join(this.directory, 'connector.jsonl')
      const size = await stat(path).then(file => file.size, () => 0)
      if (size > 512 * 1024) await rename(path, join(this.directory, 'connector.previous.jsonl'))
      await appendFile(path, `${JSON.stringify({ time: new Date().toISOString(), event })}\n`, { mode: 0o600 })
    }).catch(() => undefined)
  }
  async flush(): Promise<void> { await this.pending }
}
