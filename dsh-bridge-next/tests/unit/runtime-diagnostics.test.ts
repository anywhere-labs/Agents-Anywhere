import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeDiagnostics, RuntimeRpcLogger, type DiagnosticEntry } from '../../src/host/dsh-runtime/diagnostics.js'
import { RpcLogOutput } from '../../src/host/dsh-runtime/log-output.js'
import { readBridgeLogs } from '../../src/host/dsh-runtime/log-reader.js'
import type { LogsServiceClient, LogWrite } from '../../src/host/generated/connector-logs.js'

function collector() {
  const entries: DiagnosticEntry[] = []
  const logger = new RuntimeDiagnostics({ write: entry => entries.push(entry), async flush() {} })
  return { logger, entries }
}

test('injected diagnostics preserve safe error context without native content', async () => {
  const { logger, entries } = collector()
  const cause = Object.assign(new Error('PRIVATE_PROMPT PRIVATE_TOKEN', {
    cause: new Error('corrupt session log: seq gap in committed region at line 730 (expected 9044, got 9041)'),
  }), { code: 'SESSION_UNKNOWN_EVENT' })
  await assert.rejects(logger.measure('session.visibility_read', { sessionId: 'session-1' }, async () => {
    throw new Error('PRIVATE_SESSION_JSON', { cause })
  }))
  assert.equal(entries.length, 2)
  assert.equal(entries[1]!.message, 'session.visibility_read.failed')
  const details = JSON.parse(entries[1]!.details)
  assert.match(entries[1]!.details, /runtime-diagnostics.test.ts/)
  assert.equal(details.cause.cause.expectedSeq, 9044)
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_/)
})

test('RPC output retries stable event IDs after lost acknowledgements and bounds offline memory', async () => {
  const output = new RpcLogOutput(3)
  const logger = new RuntimeDiagnostics(output)
  for (let i = 0; i < 5; i++) logger.log('info', `event-${i}`)
  const deliveries: LogWrite[][] = []
  let lostReply = true
  output.connect({ write: async (batch: LogWrite[]) => {
    deliveries.push(batch)
    if (lostReply) { lostReply = false; throw new Error('reply lost') }
    return { accepted: batch.length }
  } } as LogsServiceClient)
  await logger.flush()
  await logger.flush()
  assert.deepEqual(deliveries[0], deliveries[1])
  assert.equal(deliveries[0]!.length, 3)
  await logger.flush()
  const dropped = deliveries.at(-1)![0]!
  assert.equal(dropped.message, 'diagnostics.dropped')
  assert.equal(JSON.parse(dropped.details!).droppedLogEntries, 2)
})

test('framework logger retains bound call context and excludes log-service feedback', () => {
  const { logger, entries } = collector()
  const rpc = new RuntimeRpcLogger(logger)
  rpc.bind({ service: 'aa.dsh.v2.Bridge', method: 'sync', call_id: 'call-1' }).warning('sync failed: %s', new Error('PRIVATE_PAYLOAD'))
  rpc.bind({ service: 'aa.local.v2.Logs' }).debug('write completed')
  assert.equal(entries.length, 1)
  assert.equal(JSON.parse(entries[0]!.details).call_id, 'call-1')
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_PAYLOAD/)
})

test('log UI adapter preserves central sequence IDs and method/outcome summaries', () => {
  const { logger, entries } = collector()
  logger.log('debug', 'rpc.completed', { method: 'getSessionState' })
  logger.log('warn', 'rpc.rejected', { method: 'session.send' })
  logger.log('debug', 'session.read.started')
  // Call-scoped loggers store the formatted message, not a bare event name.
  new RuntimeRpcLogger(logger).bind({ service: 'aa.dsh.v2.Bridge', method: 'sync', call_id: 'call-9' })
    .warning('rpc.rejected %s', JSON.stringify({ code: 'SESSION_NOT_FOUND' }))
  const result = readBridgeLogs({ items: entries.map((e, i) => ({ ...e, seq: i + 41 })),
    firstSeq: 41, lastSeq: 44, total: 4, hasMoreBefore: false, hasMoreAfter: false })
  assert.deepEqual(result.entries.map(e => [e.method, e.outcome]), [
    ['getSessionState', 'success'], ['session.send', 'failure'], ['session.read', 'pending'], ['sync', 'failure'],
  ])
  assert.equal(result.entries[0]!.id, '41')
  assert.equal(JSON.parse(result.entries[3]!.details).code, 'SESSION_NOT_FOUND')
})
