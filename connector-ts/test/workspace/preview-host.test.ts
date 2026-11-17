import { describe, expect, it } from 'vitest'

import type { CommandHandlerContext } from '../../src/application/inbound/index.js'
import { previewHost, type ListeningPort, type PreviewSpec, type PreviewTransport } from '../../src/workspace/index.js'

/** Preview commands write nothing to the store, so they never touch the receipt; a bare context is enough. */
const ctx = (commandId: string): CommandHandlerContext => ({ commandId, inputDigest: null, actor: 'user' }) as unknown as CommandHandlerContext

class FakeTransport implements PreviewTransport {
  readonly previews: PreviewSpec[] = []
  closedPorts: number[] = []
  closedAll = 0
  async open(spec: PreviewSpec): Promise<void> { this.previews.push(spec) }
  async close(previewId: string): Promise<boolean> {
    const index = this.previews.findIndex(p => p.previewId === previewId)
    if (index < 0) return false
    this.previews.splice(index, 1)
    return true
  }
  async closePort(port: number): Promise<string[]> {
    this.closedPorts.push(port)
    const ids = this.previews.filter(p => p.port === port).map(p => p.previewId)
    for (const id of ids) await this.close(id)
    return ids
  }
  async closeAll(): Promise<void> { this.closedAll++ }
  openPreviews(): readonly PreviewSpec[] { return this.previews }
}

const port = (value: number, pid: number | null = 200, address = '127.0.0.1'): ListeningPort => ({ port: value, address, pid, process: 'node' })
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
}

function fixture(initial: ListeningPort[], e2eeMode?: 'off' | 'required') {
  let ports = initial
  const events: { method: string; payload: Record<string, unknown> }[] = []
  const transport = new FakeTransport()
  const host = previewHost({
    frpcPath: null,
    dataDir: '/nonexistent',
    deviceId: () => 'conn_1',
    transport,
    list: async () => ports,
    // Session `ses_a` runs pid 100; its dev server (pid 200) is a child.
    parents: async () => new Map([[200, 100], [300, 1]]),
    hints: () => ({ roots: new Map([[100, 'ses_a']]), mentioned: new Map([[8080, { sessionId: 'ses_b', url: 'http://localhost:8080/app' }]]) }),
    intervalMs: 60_000,
    refreshMs: 60_000,
    ...(e2eeMode !== undefined ? { e2eeMode: () => e2eeMode } : {}),
  })
  const link = { attach: { emit: (method: string, payload: Record<string, unknown>) => events.push({ method, payload }) } }
  return { host, link, events, transport, setPorts: (next: ListeningPort[]) => { ports = next } }
}

describe('previewHost', () => {
  it('sends the device port list with each port\'s session on Link/attach', async () => {
    const f = fixture([port(5173), port(8080, 300), port(9000, 300)])
    f.host.onLink(f.link)
    await settle()
    expect(f.events).toEqual([{
      method: 'port.listening',
      payload: {
        deviceId: 'conn_1',
        ports: [
          { port: 5173, pid: 200, processName: 'node', sessionId: 'ses_a', url: 'http://localhost:5173' },
          { port: 8080, pid: 300, processName: 'node', sessionId: 'ses_b', url: 'http://localhost:8080/app' },
          { port: 9000, pid: 300, processName: 'node', sessionId: null, url: 'http://localhost:9000' },
        ],
      },
    }])
    await f.host.close()
  })

  it('sends only ports and sessions in plaintext when the link is end-to-end encrypted', async () => {
    const f = fixture([port(5173), port(8080, 300), port(9000, 300)], 'required')
    f.host.onLink(f.link)
    await settle()
    expect(f.events).toEqual([{
      method: 'port.listening',
      payload: {
        deviceId: 'conn_1',
        ports: [
          { port: 5173, pid: null, processName: null, sessionId: 'ses_a', url: 'http://localhost:5173' },
          { port: 8080, pid: null, processName: null, sessionId: 'ses_b', url: 'http://localhost:8080' },
          { port: 9000, pid: null, processName: null, sessionId: null, url: 'http://localhost:9000' },
        ],
      },
    }])
    await f.host.close()
  })

  it('refuses to preview a loopback port that belongs to no session', async () => {
    const f = fixture([port(5173), port(8080, 300), port(9000, 300)])
    const context = ctx('cmd_1')
    // pid 300 is not under any session root and nothing printed :9000.
    await expect(f.host.commands['preview.open']!({ previewId: 'prv_9', slug: 's9', port: 9000, frpToken: 't', tokenExpiresAt: 'z', frpsAddr: 'f:1' }, context))
      .rejects.toMatchObject({ code: 'preview_port_not_allowed', details: { port: 9000, reason: 'not_session' } })
    // :8080 has the same unrelated process, but a session printed its URL.
    await expect(f.host.commands['preview.open']!({ previewId: 'prv_8', slug: 's8', port: 8080, frpToken: 't', tokenExpiresAt: 'z', frpsAddr: 'f:1' }, context))
      .resolves.toMatchObject({ port: 8080 })
    expect(f.transport.previews.map(p => p.port)).toEqual([8080])
    await f.host.close()
  })

  it('opens previews through PortShare and closes those of a port that stopped listening', async () => {
    const f = fixture([port(5173)])
    f.host.onLink(f.link)
    await settle()
    const opened = await f.host.commands['preview.open']!({
      previewId: 'prv_1', slug: 'abc', port: 5173, frpToken: 'tok', tokenExpiresAt: '2026-11-17T00:00:00Z', frpsAddr: 'frps.example:7000',
    }, ctx('cmd_1'))
    expect(opened).toEqual({ previewId: 'prv_1', port: 5173, localIP: '127.0.0.1' })
    await expect(f.host.commands['preview.open']!({ previewId: 'prv_2', slug: 'x', port: 4000, frpToken: 't', tokenExpiresAt: 'z', frpsAddr: 'f:1' }, ctx('cmd_2')))
      .rejects.toMatchObject({ code: 'preview_port_not_allowed' })

    // The next poll finds the port gone (driven directly: the watcher's own timer is a minute away).
    f.setPorts([])
    f.host.onLink(f.link)
    await settle()
    // A new link starts a fresh watch: it knows no ports yet, so nothing closed on it.
    expect(f.transport.previews.map(p => p.previewId)).toEqual(['prv_1'])
    expect(await f.host.commands['preview.close']!({ previewId: 'prv_1' }, ctx('cmd_3'))).toEqual({ closed: true })
    await f.host.close()
    expect(f.transport.closedAll).toBe(1)
  })

  it('reports port.closed after closing that port\'s previews', async () => {
    const f = fixture([port(5173)])
    const host = previewHost({
      frpcPath: null, dataDir: '/nonexistent', deviceId: () => 'conn_1', transport: f.transport,
      list: async () => current, parents: async () => new Map(), intervalMs: 20, refreshMs: 60_000,
    })
    let current = [port(5173)]
    await f.transport.open({ previewId: 'prv_1', slug: 's', port: 5173, localIP: '127.0.0.1', token: 't', tokenExpiresAt: 'z', frpsAddr: 'f:1' })
    host.onLink(f.link)
    await settle()
    current = []
    await new Promise(resolve => setTimeout(resolve, 60))
    await settle()
    expect(f.transport.closedPorts).toEqual([5173])
    expect(f.transport.previews).toEqual([])
    expect(f.events.at(-1)).toEqual({ method: 'port.closed', payload: { deviceId: 'conn_1', port: 5173 } })
    await host.close()
  })

  it('repeats a non-empty port list so a reconnected Server has it', async () => {
    const f = fixture([])
    const host = previewHost({
      frpcPath: null, dataDir: '/nonexistent', deviceId: () => 'conn_1', transport: f.transport,
      list: async () => [port(5173)], parents: async () => new Map(), intervalMs: 60_000, refreshMs: 30,
    })
    host.onLink(f.link)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(f.events.filter(e => e.method === 'port.listening').length).toBeGreaterThanOrEqual(2)
    await host.close()
  })
})
