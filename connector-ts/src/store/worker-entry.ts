import { parentPort, workerData } from 'node:worker_threads'

import { openSqliteStore, type OpenStoreOptions } from './sqlite-store.js'
import { methodsOf, serveStore, type FailedMessage, type ReadyMessage } from './thread.js'

// The store worker: owns SQLite and the blob files for the life of the Connector.
const port = parentPort
if (port === null) throw new Error('the store worker must run in a worker thread')
try {
  const store = openSqliteStore(workerData as OpenStoreOptions)
  serveStore(port, store, () => port.close())
  port.postMessage({ type: 'ready', readOnly: store.readOnly, storeEpoch: store.storeEpoch, methods: methodsOf(store) } satisfies ReadyMessage)
} catch (error) {
  port.postMessage({ type: 'failed', error: { name: (error as Error).name ?? 'Error', code: (error as { code?: string }).code, message: (error as Error).message ?? String(error) } } satisfies FailedMessage)
}
