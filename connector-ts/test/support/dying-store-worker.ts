// Test-only store worker: the real one, except that a `kv.get(_, '__die__')` request ends the worker thread before
// it is served, the way a crash would (the call stays unanswered).
import { parentPort } from 'node:worker_threads'

parentPort?.on('message', (request: { repo?: string; args?: unknown[] }) => {
  if (request.repo === 'kv' && request.args?.[1] === '__die__') process.exit(7)
})
await import('../../src/store/worker-entry.js')
