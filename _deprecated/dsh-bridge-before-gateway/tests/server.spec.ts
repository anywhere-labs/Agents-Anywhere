import { once } from 'node:events'
import { chmod, mkdtemp, readFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareStateLayout } from '../src/security/paths.js'
import { MAX_FRAME_BYTES } from '../src/wire/protocol.js'
import { LoopbackJsonRpcServer } from '../src/wire/server.js'
import type {
  BridgeRequestHandler,
  JsonRpcNotification,
  JsonRpcRequest,
} from '../src/wire/types.js'

interface Endpoint {
  host: string
  port: number
  token: string
  pid: number
  maxFrameBytes: number
}

const running: LoopbackJsonRpcServer[] = []

afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop()
})

async function fixture(authenticationDeadlineMs = 1_000): Promise<{
  server: LoopbackJsonRpcServer
  endpoint: Endpoint
  handler: RecordingHandler
}> {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-wire-'))
  if (process.platform !== 'win32') await chmod(home, 0o700)
  const layout = await prepareStateLayout(home, join(home, 'agents-anywhere', 'bridge'))
  const handler = new RecordingHandler()
  const server = new LoopbackJsonRpcServer(layout, authenticationDeadlineMs, handler)
  running.push(server)
  await server.start()
  const endpoint = JSON.parse(await readFile(layout.endpointPath, 'utf8')) as Endpoint
  return { server, endpoint, handler }
}

describe('loopback ownership and framing', () => {
  it('lets an authenticated Connector claim ownership while unauthenticated peers wait', async () => {
    const { endpoint, handler } = await fixture()
    const idlePeer = await open(endpoint)
    const owner = await open(endpoint)
    owner.write(frame('owner', 'initialize', initializeParams(endpoint.token)))
    const response = await readFrame(owner)
    expect(response).toMatchObject({ id: 'owner', result: { identity: { runtime: 'dsh' } } })
    expect(handler.requests).toHaveLength(1)
    idlePeer.destroy()
    owner.destroy()
  })

  it('disconnects the first authentication failure without reserving ownership', async () => {
    const { endpoint, handler } = await fixture()
    const rejected = await open(endpoint)
    const closed = once(rejected, 'close')
    rejected.write(frame('bad', 'initialize', initializeParams('wrong-token')))
    rejected.resume()
    await closed

    const owner = await open(endpoint)
    owner.write(frame('good', 'initialize', initializeParams(endpoint.token)))
    expect(await readFrame(owner)).toMatchObject({ id: 'good', result: { identity: { runtime: 'dsh' } } })
    expect(handler.requests).toHaveLength(1)
    owner.destroy()
  })

  it('enforces an authentication deadline', async () => {
    const { endpoint } = await fixture(50)
    const socket = await open(endpoint)
    await once(socket, 'close')
    expect(socket.destroyed).toBe(true)
  })

  it('rejects a second authenticated owner', async () => {
    const { endpoint, handler } = await fixture()
    const first = await open(endpoint)
    first.write(frame(1, 'initialize', initializeParams(endpoint.token)))
    await readFrame(first)

    const second = await open(endpoint)
    const closed = once(second, 'close')
    second.write(frame(2, 'initialize', initializeParams(endpoint.token)))
    second.resume()
    await closed
    expect(handler.requests).toHaveLength(1)
    first.destroy()
  })

  it('closes an over-limit frame without allocating an unbounded buffer', async () => {
    const { endpoint } = await fixture()
    const socket = await open(endpoint)
    socket.write(Buffer.alloc(MAX_FRAME_BYTES + 2, 0x61))
    await once(socket, 'close')
    expect(socket.destroyed).toBe(true)
  })
})

class RecordingHandler implements BridgeRequestHandler {
  readonly requests: JsonRpcRequest[] = []
  readonly notifications: JsonRpcNotification[] = []
  readonly disconnects: string[] = []
  readonly fatalErrors: Error[] = []

  async request(frame: JsonRpcRequest): Promise<unknown> {
    this.requests.push(frame)
    if (frame.method === 'initialize') {
      return {
        identity: {
          runtime: 'dsh',
          runtimeVersion: '0.1.1-rc.2',
          bridgeVersion: '0.1.0',
          protocolVersion: '1.0',
          displayName: 'DeepSeek Harness',
        },
      }
    }
    return { ok: true }
  }

  async notification(frame: JsonRpcNotification): Promise<void> {
    this.notifications.push(frame)
  }

  async disconnected(reason: string): Promise<void> {
    this.disconnects.push(reason)
  }

  async fatal(error: Error): Promise<void> {
    this.fatalErrors.push(error)
  }
}

async function open(endpoint: Endpoint): Promise<Socket> {
  const socket = connect(endpoint.port, endpoint.host)
  await once(socket, 'connect')
  return socket
}

function frame(id: string | number, method: string, params: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
}

function initializeParams(authToken: string): Record<string, unknown> {
  return {
    authToken,
    protocolVersion: '1.0',
    runtime: 'dsh',
    connectorId: 'connector-test',
    clientInfo: { name: 'agents-anywhere-connector', version: 'test' },
  }
}

async function readFrame(socket: Socket): Promise<Record<string, unknown>> {
  const [chunk] = await once(socket, 'data') as [Buffer]
  return JSON.parse(chunk.toString('utf8').trim()) as Record<string, unknown>
}
