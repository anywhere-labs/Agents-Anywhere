import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DshBridgeListener, type DshHostConnection, type Rendezvous } from '../../src/host/index.js'

let dir: string
let listener: DshBridgeListener
let connections: DshHostConnection[]
let accepting: boolean

beforeEach(() => {
  // Short: Unix socket paths are limited to about 104 bytes.
  dir = mkdtempSync(join(tmpdir(), 'aad-'))
  connections = []
  accepting = true
  listener = new DshBridgeListener({ dir, instanceId: 'inst1', connectorVersion: '3.0.0', onConnection: c => connections.push(c), helloTimeoutMs: 200, accepting: () => accepting })
})

afterEach(async () => {
  await listener.stop()
  rmSync(dir, { recursive: true, force: true })
})

function dial(rendezvous: Rendezvous): Promise<Socket> {
  const endpoint = rendezvous.endpoint as { unixPath: string }
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint.unixPath, () => resolve(socket))
    socket.once('error', reject)
  })
}

function firstLine(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    let text = ''
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8')
      const newline = text.indexOf('\n')
      if (newline >= 0) {
        socket.off('data', onData)
        resolve(JSON.parse(text.slice(0, newline)) as Record<string, unknown>)
      }
    }
    socket.on('data', onData)
  })
}

const closed = (socket: Socket): Promise<void> => new Promise(resolve => {
  if (socket.destroyed) resolve()
  else socket.once('close', () => resolve())
})

const hello = (key: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ t: 'hello', bridgeProtocol: '3.0', key, hostInstance: 'host_abcdef', hostKind: 'desktop', dshVersion: '0.2.2', pluginVersion: '3.0.0', ...extra })}\n`

describe('DSH Bridge 3.0 local socket', () => {
  it('publishes a private rendezvous file and socket', async () => {
    const rendezvous = await listener.start()
    const file = JSON.parse(readFileSync(join(dir, 'connector-acp.json'), 'utf8')) as Rendezvous
    expect(file).toEqual(rendezvous)
    expect(file).toMatchObject({ version: 3, protocol: 'acp', instanceId: 'inst1', pid: process.pid, endpoint: { unixPath: join(dir, 'acp-inst1.sock') } })
    expect(file.key).toMatch(/^ak_[0-9a-f]{64,}$/u)
    expect(statSync(join(dir, 'connector-acp.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'acp-inst1.sock')).mode & 0o777).toBe(0o600)
  })

  it('welcomes a valid hello and hands over the stream with the bytes that followed it', async () => {
    const rendezvous = await listener.start()
    const socket = await dial(rendezvous)
    const reply = firstLine(socket)
    socket.write(`${hello(rendezvous.key)}{"jsonrpc":"2.0","method":"x"}\n`)
    expect(await reply).toEqual({ t: 'welcome', bridgeProtocol: '3.0', connectorInstance: 'inst1', connectorVersion: '3.0.0' })
    await expect.poll(() => connections.length).toBe(1)
    const connection = connections[0]!
    expect(connection.hello).toMatchObject({ hostInstance: 'host_abcdef', hostKind: 'desktop' })
    const acp = await new Promise<string>(resolve => {
      connection.socket.once('data', chunk => resolve(chunk.toString('utf8')))
      connection.socket.resume()
    })
    expect(acp).toBe('{"jsonrpc":"2.0","method":"x"}\n')
    // ACP both ways.
    const back = new Promise<string>(resolve => socket.once('data', chunk => resolve(chunk.toString('utf8'))))
    connection.socket.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
    expect(await back).toContain('initialize')
    expect(listener.connectedHosts()).toEqual(['host_abcdef'])
    socket.destroy()
  })

  it('rejects a wrong key, an unsupported protocol and a busy Connector', async () => {
    const rendezvous = await listener.start()
    const cases: [string, string][] = [
      [hello('ak_wrong'), 'bad_key'],
      [hello(rendezvous.key, { bridgeProtocol: '2.0' }), 'unsupported_protocol'],
      ['not json\n', 'unsupported_protocol'],
      [hello(rendezvous.key, { hostInstance: 'bad id!' }), 'unsupported_protocol'],
    ]
    for (const [line, code] of cases) {
      const socket = await dial(rendezvous)
      const reply = firstLine(socket)
      socket.write(line)
      expect(await reply).toMatchObject({ t: 'reject', code })
      await closed(socket)
    }
    accepting = false
    const socket = await dial(rendezvous)
    const reply = firstLine(socket)
    socket.write(hello(rendezvous.key))
    expect(await reply).toMatchObject({ t: 'reject', code: 'busy' })
    expect(connections).toEqual([])
  })

  it('closes a connection that never says hello', async () => {
    const rendezvous = await listener.start()
    const socket = await dial(rendezvous)
    await closed(socket)
    expect(connections).toEqual([])
  })

  it('replaces the older connection of the same host', async () => {
    const rendezvous = await listener.start()
    const first = await dial(rendezvous)
    first.write(hello(rendezvous.key))
    await expect.poll(() => connections.length).toBe(1)
    const second = await dial(rendezvous)
    second.write(hello(rendezvous.key))
    await expect.poll(() => connections.length).toBe(2)
    await closed(connections[0]!.socket)
    expect(listener.connectedHosts()).toEqual(['host_abcdef'])
    second.destroy()
  })

  it('removes its rendezvous file and socket on stop, but not a newer Connector\'s file', async () => {
    await listener.start()
    await listener.stop()
    expect(existsSync(join(dir, 'connector-acp.json'))).toBe(false)
    expect(existsSync(join(dir, 'acp-inst1.sock'))).toBe(false)
    const newer = new DshBridgeListener({ dir, instanceId: 'inst2', connectorVersion: '3.0.1', onConnection: () => undefined })
    await newer.start()
    await listener.stop()
    expect(JSON.parse(readFileSync(join(dir, 'connector-acp.json'), 'utf8')).instanceId).toBe('inst2')
    await newer.stop()
  })
})
