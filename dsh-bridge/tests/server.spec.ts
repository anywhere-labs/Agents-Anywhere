import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { LoopbackJsonRpcServer } from '../src/bridge/wire/server.js'
import type { JsonRpcNotification, JsonRpcRequest } from '../src/bridge/wire/types.js'

describe('loopback bridge server', () => {
  it('publishes a private endpoint and authenticates one Connector', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aa-bridge-server-'))
    const disconnected: string[] = []
    const server = new LoopbackJsonRpcServer(root, 4096, {
      request: (frame: JsonRpcRequest) => Promise.resolve({ method: frame.method }),
      notification: (_frame: JsonRpcNotification) => Promise.resolve(),
      eof: () => Promise.resolve(),
      fatal: () => Promise.resolve(),
      disconnected: (reason: string) => { disconnected.push(reason); return Promise.resolve() },
    })
    try {
      const endpoint = await server.start()
      const record = JSON.parse(await readFile(server.endpointPath, 'utf8')) as Record<string, unknown>
      expect(record).toMatchObject({ version: 1, host: '127.0.0.1', port: endpoint.port, pid: process.pid })
      expect(record.token).toBe(endpoint.token)
      expect((await stat(server.endpointPath)).mode & 0o777).toBe(0o600)

      const socket = createConnection({ host: endpoint.host, port: endpoint.port })
      socket.setEncoding('utf8')
      await once(socket, 'connect')
      socket.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'initialize',
        params: { authToken: endpoint.token },
      })}\n`)
      const [response] = await once(socket, 'data') as [string]
      expect(JSON.parse(response)).toMatchObject({ id: 'init-1', result: { method: 'initialize' } })

      const notification = once(socket, 'data')
      await server.notify('runtime.capabilities.update', { revision: 1 })
      const [message] = await notification as [string]
      expect(JSON.parse(message)).toMatchObject({ method: 'runtime.capabilities.update', params: { revision: 1 } })
      socket.end()
      await once(socket, 'close')
      expect(disconnected).toEqual(['connector-disconnected'])
    } finally {
      await server.stop()
      await expect(stat(server.endpointPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await rm(root, { recursive: true })
    }
  })

  it('rejects a second live endpoint owner without replacing its descriptor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aa-bridge-live-owner-'))
    const first = serverFor(root)
    const second = serverFor(root)
    try {
      const endpoint = await first.start()
      const descriptor = await readFile(first.endpointPath, 'utf8')
      await expect(second.start()).rejects.toThrow(`already owned by live process ${process.pid}`)
      expect(await readFile(first.endpointPath, 'utf8')).toBe(descriptor)
      expect(JSON.parse(descriptor)).toMatchObject({ token: endpoint.token, pid: process.pid })
    } finally {
      await second.stop()
      await first.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reclaims a confirmed stale descriptor and supports repeated disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aa-bridge-stale-owner-'))
    const server = serverFor(root)
    await writeFile(server.endpointPath, `${JSON.stringify({
      version: 1,
      host: '127.0.0.1',
      port: 1,
      token: 'stale-token',
      pid: 2_147_483_647,
    })}\n`, { mode: 0o600 })
    try {
      const endpoint = await server.start()
      expect(JSON.parse(await readFile(server.endpointPath, 'utf8'))).toMatchObject({
        token: endpoint.token,
        pid: process.pid,
      })
      await server.stop()
      await server.stop()
      await expect(stat(server.endpointPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

function serverFor(root: string): LoopbackJsonRpcServer {
  return new LoopbackJsonRpcServer(root, 4096, {
    request: (frame: JsonRpcRequest) => Promise.resolve({ method: frame.method }),
    notification: (_frame: JsonRpcNotification) => Promise.resolve(),
    eof: () => Promise.resolve(),
    fatal: () => Promise.resolve(),
    disconnected: () => Promise.resolve(),
  })
}
