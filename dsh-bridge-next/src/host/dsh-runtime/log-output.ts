import { randomUUID } from 'node:crypto'
import type { LogsServiceClient, LogWrite } from '../generated/connector-logs.js'
import type { DiagnosticEntry, DiagnosticOutput } from './diagnostics.js'

/** Retain unacknowledged entries with stable IDs; only Connector persists them. */
export class RpcLogOutput implements DiagnosticOutput {
  private readonly producer = randomUUID()
  private sequence = 0
  private pending: LogWrite[] = []
  private dropped = 0
  private client: LogsServiceClient | undefined
  private sending: Promise<void> | undefined

  constructor(private readonly capacity = 512) {}

  connect(client: LogsServiceClient | undefined): void { this.client = client }

  write(entry: DiagnosticEntry): void {
    if (this.pending.length >= this.capacity) { this.dropped++; return }
    this.pending.push({ ...entry, producer: this.producer, eventId: String(++this.sequence) })
  }

  flush(): Promise<void> {
    return this.sending ??= this.send().finally(() => { this.sending = undefined })
  }

  private async send(): Promise<void> {
    const client = this.client
    if (!client) return
    if (this.dropped && this.pending.length < this.capacity) {
      const count = this.dropped
      this.dropped = 0
      this.write({ time: new Date().toISOString(), level: 'warn', name: 'dsh-bridge',
        message: 'diagnostics.dropped', details: JSON.stringify({ droppedLogEntries: count }) })
    }
    // One bounded snapshot per flush: logs generated during an RPC cannot keep
    // shutdown alive forever. Failed deliveries remain queued for reconnect.
    const count = this.pending.length
    for (let sent = 0; sent < count && client === this.client; sent += 64) {
      const batch = this.pending.slice(0, Math.min(64, count - sent))
      try { await client.write(batch, { timeoutMs: 1000 }) }
      catch { return } // Never log log-shipping failures through this output.
      this.pending.splice(0, batch.length)
    }
  }
}
