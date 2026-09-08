import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeDiagnostics } from '../../src/host/dsh-runtime/diagnostics.js'
import { readBridgeLogs } from '../../src/host/dsh-runtime/log-reader.js'

test('bridge diagnostics preserve the failing read and stack without native content, and expose only bridge files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-bridge-logs-'))
  try {
    const log = new RuntimeDiagnostics(undefined, root)
    const cause = Object.assign(new Error('PRIVATE_PROMPT PRIVATE_TOKEN'), { code: 'SESSION_UNKNOWN_EVENT' })
    const error = new Error('PRIVATE_SESSION_JSON', { cause })
    await assert.rejects(log.measure('session.visibility_read', { sessionId: 'session-1' }, async () => { throw error }))
    await log.flush()
    await writeFile(join(root, 'connector.jsonl'), 'PRIVATE_CONNECTOR_LOG')
    await writeFile(join(root, 'host.log'), 'PRIVATE_HOST_LOG')
    const result = await readBridgeLogs(root)
    assert.equal(result.entries.length, 2)
    const failed = result.entries[1]!
    assert.equal(failed.event, 'session.visibility_read.failed')
    assert.equal(failed.level, 'error')
    assert.match(failed.details, /session-1/)
    assert.match(failed.details, /runtime-diagnostics.test.ts/)
    assert.match(failed.details, /SESSION_UNKNOWN_EVENT/)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/)
    if (process.platform !== 'win32') assert.equal((await stat(join(root, 'dsh-runtime.jsonl'))).mode & 0o777, 0o600)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('bridge log rotation and bounded reads retain recent entries and tolerate partial appends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-bridge-logs-'))
  try {
    assert.deepEqual((await readBridgeLogs(root)).entries, [])
    const path = join(root, 'dsh-runtime.jsonl')
    const previous = `${'x'.repeat(2 * 1024 * 1024)}\n`
    await writeFile(path, previous)
    const log = new RuntimeDiagnostics(undefined, root)
    log.log('info', 'bridge.listening', { port: 1234 })
    await log.flush()
    assert.equal(await readFile(join(root, 'dsh-runtime.previous.jsonl'), 'utf8'), previous)
    assert.equal((await readBridgeLogs(root)).entries[0]?.event, 'bridge.listening')
    const entries = Array.from({ length: 210 }, (_, seq) => JSON.stringify({ time: new Date().toISOString(), level: 'debug', event: 'sync.batch', seq }))
    await writeFile(path, entries.join('\n') + '\n{"incomplete"')
    const result = await readBridgeLogs(root)
    assert.equal(result.entries.length, 200)
    assert.equal(JSON.parse(result.entries[0]!.details).seq, 10)
    assert.equal(JSON.parse(result.entries.at(-1)!.details).seq, 209)
  } finally { await rm(root, { recursive: true, force: true }) }
})
