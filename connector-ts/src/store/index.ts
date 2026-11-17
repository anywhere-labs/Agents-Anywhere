// 本地存储：SQLite schema、迁移、块存储与字节预算，实现 Store / Outbox 端口。
// SQLite 驱动用 node:sqlite（S3 结论：三种宿主都不需要原生模块）；所有访问在专用 worker 线程里。

import { Worker } from 'node:worker_threads'

import { reviveError, connectStore, type FailedMessage, type ReadyMessage, type RemoteStore } from './thread.js'
import type { OpenStoreOptions } from './sqlite-store.js'

export { openSqliteStore, StoreError, type OpenStoreOptions, type SyncStore } from './sqlite-store.js'
export { inProcessStore, type RemoteStore } from './thread.js'
export { SCHEMA_VERSION } from './schema.js'
export * from './slim.js'

export interface StoreWorkerOptions {
  /** Defaults to the bundled `worker-entry.js` next to this module. */
  readonly workerUrl?: URL
  readonly execArgv?: readonly string[]
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
    thread.once('error', onError)
    thread.once('message', (message: ReadyMessage | FailedMessage) => {
      thread.off('error', onError)
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
      resolve(connectStore(port as never, message, async () => {
        await thread.terminate()
      }))
    })
  })
}
