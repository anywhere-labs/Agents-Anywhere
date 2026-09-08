import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import SqliteQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { RuntimeServer, type Endpoint } from '../../src/host/dsh-runtime/server.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'

const execute = promisify(execFile)
async function endpoint(path: string): Promise<Endpoint> {
  // Host children initialize asynchronously; allow a loaded headless CI runner.
  for (let n = 0; n < 1000; n++) {
    try { return JSON.parse(await readFile(path, 'utf8')) as Endpoint } catch { await delay(10) }
  }
  throw new Error('Runtime did not publish its endpoint')
}
async function client(value: Endpoint, token = value.token) {
  const socket = createConnection(value.port, value.host)
  socket.on('error', () => undefined)
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]()
  let id = 0
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`)
    const line = await lines.next()
    if (line.done) throw new Error('Socket closed')
    return JSON.parse(line.value)
  }
  const result = await rpc('initialize', { authToken: token, protocolVersion: '1.0', runtime: 'dsh', connectorId: 'test', sessionNamespace: 'instance' })
  return { socket, rpc, result }
}

test('published Host + official SessionQuery/JSONL + actual Python adapter complete the read-only workflow', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-native-'))
  let context: Awaited<ReturnType<typeof nativeRuntime>> | undefined
  try {
    context = await nativeRuntime(home)
    const path = join(home, 'agents-anywhere/bridge/endpoint.json')
    const value = await endpoint(path)
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
    const connection = await client(value)
    try {
      assert.equal(connection.result.result.features.readOnly, true)
      const snapshot = await connection.rpc('session.getSnapshot', { sessionId: sessionId('instance', 'native-main'), externalSessionId: 'native-main' })
      assert.equal(snapshot.result.complete, true)
      assert.equal(snapshot.result.items.filter((item: { type: string }) => item.type === 'tool').length, 1)
      const cwd = new URL('../../../connector/', import.meta.url)
      const { stdout } = await execute('uv', ['run', '--frozen', 'python', 'tests/dsh_native_probe.py', home], { cwd, timeout: 40_000 })
      assert.match(stdout, /DSH native integration passed/)
      // Probes must not evict the existing Connector connection.
      assert.equal((await connection.rpc('ping')).result.ok, true)
      assert.equal(context.ctx.sessions.get('persisted-only' as never), undefined)
      assert.equal(context.ctx.get('agents'), undefined)
      const cold = (await context.ctx.sessionQuery.listSessions()).find(item => item.header.id === 'persisted-only')!
      const location = context.ctx.sessionPersistence.locate(cold.header)!
      const original = await readFile(location.path)
      const future = { seq: 1007, time: Date.now(), type: 'future/required', data: { message: 'future content' } }
      await appendFile(location.path, `${JSON.stringify(future)}\n`)
      const corrupt = await connection.rpc('session.getSnapshot', { sessionId: sessionId('instance', 'persisted-only'), externalSessionId: 'persisted-only' })
      assert.equal(corrupt.error.data.code, 'PERSISTENCE_ERROR')
      assert.equal(corrupt.result, undefined)
      await writeFile(location.path, Buffer.concat([original, Buffer.from(`${JSON.stringify({ ...future, ignorable: true })}\n`)]))
      const compatible = await connection.rpc('session.getSnapshot', { sessionId: sessionId('instance', 'persisted-only'), externalSessionId: 'persisted-only', limit: 1 })
      assert.equal(compatible.result.items[0].type, 'turn.end')
    } finally { connection.socket.destroy() }
    await context.query.dispose()
    await assert.rejects(access(path))
    await context.ctx.plugin(SqliteQuery, { path: ':memory:', openAt: 'never' }).await()
    const renewed = await endpoint(path)
    assert.notEqual(renewed.token, value.token)
    await context.plugin.dispose()
    await assert.rejects(access(path))
  } finally {
    await context?.ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

test('wrong authentication is rejected and cleanup does not remove another endpoint owner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-wire-'))
  const path = join(home, 'bridge/endpoint.json')
  const server = new RuntimeServer(path, { query: { listSessions: async () => [], readTitleSnapshots: async () => [], readSession: async () => { throw new Error('unused') } }, status: () => undefined })
  try {
    const value = await server.start()
    const rejected = await client(value, 'wrong-token')
    assert.equal(rejected.result.error.data.code, 'NOT_INITIALIZED')
    rejected.socket.destroy()
    await writeFile(path, JSON.stringify({ ...value, token: 'replacement-owner' }))
    await server.close()
    assert.equal(JSON.parse(await readFile(path, 'utf8')).token, 'replacement-owner')
  } finally { await server.close(); await rm(home, { recursive: true, force: true }) }
})

test('concurrent starts cannot overwrite ownership and closing twice releases the endpoint', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-owner-'))
  const path = join(home, 'bridge/endpoint.json')
  const reader = { query: { listSessions: async () => [], readTitleSnapshots: async () => [], readSession: async () => { throw new Error('unused') } }, status: () => undefined }
  const servers = [new RuntimeServer(path, reader), new RuntimeServer(path, reader)]
  try {
    const started = await Promise.allSettled(servers.map(server => server.start()))
    assert.equal(started.filter(result => result.status === 'fulfilled').length, 1)
    const winner = started.findIndex(result => result.status === 'fulfilled')
    const connection = await client(await endpoint(path))
    assert.equal((await connection.rpc('session.list')).result.sessions.length, 0)
    connection.socket.destroy()
    await Promise.all([servers[winner]!.close(), servers[winner]!.close()])
    await assert.rejects(access(path))
  } finally { await Promise.allSettled(servers.map(server => server.close())); await rm(home, { recursive: true, force: true }) }
})
