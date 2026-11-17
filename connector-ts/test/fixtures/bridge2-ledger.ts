import { Bridge2Error, BACKEND_UNAVAILABLE, type Bridge2Ledger, type HistoryRefusedError, type Json, type Notification } from '../../src/runtime/dsh-bridge2/relay.js'

/** The Connector's local store as the relay sees it. */
export class MemoryLedger implements Bridge2Ledger {
  readonly published: Notification[] = []
  readonly sessions = new Map<string, { meta: Json, items: Json[] }>()
  readonly state = new Map<string, Json>()
  refuse: HistoryRefusedError | undefined
  unavailable = 0
  async publish(notifications: readonly Notification[]) {
    if (this.unavailable > 0) { this.unavailable -= 1; throw new Bridge2Error(BACKEND_UNAVAILABLE, 'store busy', true) }
    this.published.push(...notifications)
  }
  async replaceSession(sessionId: string, meta: Json, items: readonly Json[]) {
    if (this.refuse) throw this.refuse
    this.sessions.set(sessionId, { meta, items: [...items] })
  }
  async readState(key: string) { return this.state.get(key) }
  async writeState(key: string, value: Json) { this.state.set(key, value) }
  async deleteState(key: string) { this.state.delete(key) }
}

