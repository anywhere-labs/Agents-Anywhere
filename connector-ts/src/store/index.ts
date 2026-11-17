// Local storage: SQLite schema, migrations, blob storage and byte budgets, implementing the Store / Outbox ports.
// The SQLite driver is node:sqlite (finding S3: none of the three hosts needs a native module); all access runs on
// a dedicated worker thread.

import { Worker } from 'node:worker_threads'

import { reviveError, openStoreChannel, type FailedMessage, type ReadyMessage, type RemoteStore } from './thread.js'
import { StoreError, type OpenStoreOptions } from './sqlite-store.js'

export { openSqliteStore, StoreError, type OpenStoreOptions, type SyncStore } from './sqlite-store.js'
export { inProcessStore, type RemoteStore } from './thread.js'
export { SCHEMA_VERSION } from './schema.js'
export * from './slim.js'

export interface StoreWorkerOptions {
  /** Defaults to the bundled `worker-entry.js` next to this module. */
  readonly workerUrl?: URL
  readonly execArgv?: readonly string[]
  /**
   * The worker exited or crashed while the store was open. Every waiting and later store call has already been
   * rejected with this `store_unavailable` error; the Connector cannot go on without its store and should stop.
   */
  readonly onUnavailable?: (error: StoreError) => void
}

/** Starts the store worker and returns the async store port once SQLite is open and migrated. */
export function openStoreWorker(options: OpenStoreOptions, worker: StoreWorkerOptions = {}): Promise<RemoteStore> {
  const { now: _now, ...data } = options
  const thread = new Worker(worker.workerUrl ?? new URL('./worker-entry.js', import.meta.url), {
    workerData: data,
    ...(worker.execArgv !== undefined ? { execArgv: [...worker.execArgv] } : {}),
  })
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    const onEarlyExit = (code: number): void => reject(new StoreError('store_unavailable', `the store worker exited before the store opened (code ${code})`))
    thread.once('error', onError)
    thread.once('exit', onEarlyExit)
    thread.once('message', (message: ReadyMessage | FailedMessage) => {
      thread.off('error', onError)
      thread.off('exit', onEarlyExit)
      if (message.type === 'failed') {
        void thread.terminate()
        reject(reviveError(message.error))
        return
      }
      // The worker's own port and ours are the same channel: requests and replies use the worker's
      // message events from here on.
      const port = {
        on: (event: 'message', listener: (value: unknown) => void) => thread.on(event, listener),
        postMessage: (value: unknown) => thread.postMessage(value),
        close: () => undefined,
      }
      const channel = openStoreChannel(port as never, message, async () => {
        await thread.terminate()
      })
      // Without these, a worker that dies leaves every store call waiting forever (commands, outbox, watch).
      const unavailable = (detail: string): void => {
        const error = new StoreError('store_unavailable', `the local store is unavailable: ${detail}`)
        if (channel.fail(error)) worker.onUnavailable?.(error)
      }
      thread.on('error', error => unavailable(`its worker crashed: ${error.message}`))
      thread.on('exit', code => unavailable(`its worker exited (code ${code})`))
      resolve(channel.store)
    })
  })
}
