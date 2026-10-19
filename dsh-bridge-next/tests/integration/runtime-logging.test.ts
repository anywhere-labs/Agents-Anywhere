import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Mesh, Router } from 'meshcall'
import { LogsServiceClient } from '../../src/host/generated/connector-logs.js'
import { BridgeConnection } from '../../src/host/dsh-runtime/connection.js'
import { RuntimeDiagnostics } from '../../src/host/dsh-runtime/diagnostics.js'
import { RpcLogOutput } from '../../src/host/dsh-runtime/log-output.js'
import { writeJson } from '../../src/host/storage/files.js'

async function connector(home: string) {
  const child = spawn('uv', ['run', 'python', 'tests/logs_probe.py', home], {
    cwd: new URL('../../../connector/', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000) })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  const lines = createInterface({ input: child.stdout })
  const descriptor = await new Promise<{ instanceId: string; pid: number; key: string; callerKey: string; endpoint: { unixPath: string } }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Connector not ready: ${stderr}`)), 15000)
    lines.once('line', line => { clearTimeout(timer); resolve(JSON.parse(line)) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Connector exited: ${stderr}`)) })
  })
  return { descriptor, async close() { lines.close(); child.stdin.end(); await exited } }
}

test('Bridge DI logger crosses real Python Logs RPC and history survives Connector replacement', { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-log-rpc-'))
  let process = await connector(home)
  let mesh: Mesh | undefined
  let caller: Mesh | undefined
  const output = new RpcLogOutput()
  const diagnostics = new RuntimeDiagnostics(output)
  const path = join(home, 'bridge', 'connector.json')
  await writeJson(path, { ...process.descriptor, version: 2, protocol: 'meshcall' })
  const connection = new BridgeConnection(path, {
    query: { listSessions: async () => [], readTitleSnapshots: async () => [],
      readSession: async () => { throw new Error('PRIVATE_NATIVE_BODY') } }, status: () => undefined,
  }, diagnostics, 100, output)
  try {
    diagnostics.log('info', 'before.connection')
    await connection.start()
    mesh = new Mesh(new Router(process.descriptor.endpoint), { token: process.descriptor.key })
    caller = new Mesh(new Router(process.descriptor.endpoint), { token: process.descriptor.callerKey })
    await assert.rejects(caller.unary('aa.dsh.v2.Bridge', 'getSessionState', { externalSessionId: 'broken' },
      { metadata: { 'aa-session-namespace': 'log-test' }, timeoutMs: 3000 }))
    await diagnostics.flush()
    const logs = new LogsServiceClient(mesh)
    const first = await logs.read('bridge')
    assert.ok(first.items.some(entry => entry.message === 'before.connection'))
    const rejected = first.items.find(entry => entry.message.startsWith('rpc.rejected'))!
    assert.equal(JSON.parse(rejected.details!).method, 'getSessionState')
    assert.ok(JSON.parse(rejected.details!).call_id, 'MeshCall injects a bound per-call logger')
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_NATIVE_BODY/)
    const cursor = first.lastSeq!
    await connection.close()
    await caller.close()
    caller = undefined
    await mesh.close()
    mesh = undefined
    await process.close()
    diagnostics.log('info', 'while.disconnected')
    process = await connector(home)
    mesh = new Mesh(new Router(process.descriptor.endpoint), { token: process.descriptor.key })
    output.connect(new LogsServiceClient(mesh))
    await diagnostics.flush()
    const recovered = await new LogsServiceClient(mesh).read('bridge', null, cursor)
    assert.ok(recovered.items.some(entry => entry.message === 'while.disconnected'))
    assert.ok(recovered.items.every(entry => entry.seq > cursor))
    assert.ok((await new LogsServiceClient(mesh).read('bridge')).items.some(entry => entry.seq === rejected.seq))
  } finally {
    await connection.close()
    await caller?.close()
    await mesh?.close()
    await process.close()
    await rm(home, { recursive: true, force: true })
  }
})
