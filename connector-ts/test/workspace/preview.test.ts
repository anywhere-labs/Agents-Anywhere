import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  FrpcManager,
  MAX_OPEN_PREVIEWS,
  WorkspaceError,
  annotatePorts,
  decidePortShare,
  localUrlsIn,
  originOf,
  parseFrpsAddr,
  parsePs,
  previewCommands,
  renderFrpcConfig,
  sessionOfPort,
  sessionOfProcess,
  withoutQuery,
  type ChildLike,
  type ListeningPort,
  type PreviewSpec,
} from '../../src/workspace/index.js'

const listening = (port: number, address = '127.0.0.1', pid: number | null = 100): ListeningPort => ({ port, address, pid, process: 'node' })

const inSession = (): string => 'sess_a'
const noSession = (): null => null

describe('PortShare', () => {
  it('forwards only to loopback and refuses LAN-only bindings', () => {
    expect(decidePortShare(5173, [listening(5173, '0.0.0.0')], 0, false, inSession)).toEqual({ port: 5173, localIP: '127.0.0.1' })
    expect(decidePortShare(5173, [listening(5173, '::1')], 0, false, inSession)).toEqual({ port: 5173, localIP: '::1' })
    expect(() => decidePortShare(3000, [listening(3000, '192.168.1.5')], 0, false, inSession)).toThrow(expect.objectContaining({ code: 'preview_port_not_allowed', details: expect.objectContaining({ reason: 'not_local' }) }))
    expect(() => decidePortShare(4000, [listening(3000)], 0, false, inSession)).toThrow(expect.objectContaining({ code: 'preview_port_not_allowed', details: expect.objectContaining({ reason: 'not_listening' }) }))
    expect(() => decidePortShare(0, [], 0, false, inSession)).toThrow(WorkspaceError)
  })

  it('refuses a loopback port no session on this device started or printed', () => {
    // A notebook or database console on 127.0.0.1 is listening and local, but no session owns it.
    expect(() => decidePortShare(8888, [listening(8888)], 0, false, noSession))
      .toThrow(expect.objectContaining({ code: 'preview_port_not_allowed', details: { port: 8888, reason: 'not_session' } }))
    const seen: number[][] = []
    decidePortShare(5173, [listening(5173), listening(5173, '::1')], 0, false, bindings => { seen.push(bindings.map(b => b.port)); return 'sess_a' })
    expect(seen).toEqual([[5173, 5173]])
  })

  it('limits open previews per device but lets an open one refresh', () => {
    const ports = [listening(5173)]
    expect(() => decidePortShare(5173, ports, MAX_OPEN_PREVIEWS, false, inSession)).toThrow(expect.objectContaining({ code: 'preview_limit_reached' }))
    expect(decidePortShare(5173, ports, MAX_OPEN_PREVIEWS, true, inSession).port).toBe(5173)
  })
})

describe('session association', () => {
  it('walks the process tree to the session root', () => {
    const parents = parsePs('  1     0\n 100    50\n  50    10\n  10     1\n 200     1\n')
    const roots = new Map([[10, 'sess_a']])
    expect(sessionOfProcess(100, roots, parents)).toBe('sess_a')
    expect(sessionOfProcess(200, roots, parents)).toBeNull()
    expect(sessionOfProcess(null, roots, parents)).toBeNull()
  })

  it('drops query and fragment from printed URLs, where dev servers put access tokens', () => {
    const urls = localUrlsIn('Jupyter: http://127.0.0.1:8888/lab?token=abc123 or http://localhost:8889/tree#access_token=xyz, then http://localhost:5173/app/?x=1.')
    expect([...urls]).toEqual([[8888, 'http://127.0.0.1:8888/lab'], [8889, 'http://localhost:8889/tree'], [5173, 'http://localhost:5173/app/']])
    expect(withoutQuery('http://localhost:3000?token=s')).toBe('http://localhost:3000')
    expect(originOf('http://127.0.0.1:8888/lab?token=abc')).toBe('http://127.0.0.1:8888')
    expect(originOf('https://example.com:443/')).toBeNull()
    // Hints from elsewhere are cleaned again before they go out.
    const annotated = annotatePorts([listening(8888)], { roots: new Map(), mentioned: new Map([[8888, { sessionId: 's', url: 'http://localhost:8888/?token=leak#k=v' }]]) }, new Map())
    expect(annotated[0]!.url).toBe('http://localhost:8888/')
    expect(JSON.stringify(annotated)).not.toContain('leak')
  })

  it('sends only the port and its session in plaintext under E2EE', () => {
    const hints = { roots: new Map([[10, 'sess_a']]), mentioned: new Map([[8888, { sessionId: 'sess_b', url: 'http://127.0.0.1:8888/lab?token=leak' }]]) }
    const annotated = annotatePorts([listening(5173, '127.0.0.1', 100), listening(8888, '127.0.0.1', 300)], hints, new Map([[100, 10]]), 'required')
    expect(annotated).toEqual([
      { port: 5173, pid: null, processName: null, sessionId: 'sess_a', url: 'http://localhost:5173' },
      { port: 8888, pid: null, processName: null, sessionId: 'sess_b', url: 'http://127.0.0.1:8888' },
    ])
    expect(JSON.stringify(annotated)).not.toMatch(/node|leak|lab/u)
  })

  it('associates a port with a session through any of its bindings or a printed URL', () => {
    const hints = { roots: new Map([[10, 'sess_a']]), mentioned: new Map([[3001, { sessionId: 'sess_b', url: 'http://localhost:3001' }]]) }
    const parents = new Map([[100, 10]])
    expect(sessionOfPort(5173, [null, 100], hints, parents)).toBe('sess_a')
    expect(sessionOfPort(3001, [999], hints, parents)).toBe('sess_b')
    expect(sessionOfPort(8888, [999], hints, parents)).toBeNull()
  })

  it('falls back to URLs printed in a session', () => {
    const urls = localUrlsIn('  ➜  Local:   http://localhost:5173/\n  api on http://127.0.0.1:3001.')
    expect([...urls]).toEqual([[5173, 'http://localhost:5173/'], [3001, 'http://127.0.0.1:3001']])
    const annotated = annotatePorts([listening(5173, '127.0.0.1', 999), listening(8080, '0.0.0.0', null)], {
      roots: new Map(),
      mentioned: new Map([[5173, { sessionId: 'sess_b', url: 'http://localhost:5173/' }]]),
    }, new Map())
    expect(annotated).toEqual([
      { port: 5173, pid: 999, processName: 'node', sessionId: 'sess_b', url: 'http://localhost:5173/' },
      { port: 8080, pid: null, processName: 'node', sessionId: null, url: 'http://localhost:8080' },
    ])
  })
})

describe('frpc config', () => {
  it('parses frps addresses', () => {
    expect(parseFrpsAddr('wss://frp.example-preview.net')).toEqual({ protocol: 'wss', host: 'frp.example-preview.net', port: 443 })
    expect(parseFrpsAddr('ws://10.0.0.2:7000')).toEqual({ protocol: 'websocket', host: '10.0.0.2', port: 7000 })
    expect(parseFrpsAddr('frps.internal:7000')).toEqual({ protocol: 'tcp', host: 'frps.internal', port: 7000 })
    expect(() => parseFrpsAddr('http://x:1')).toThrow(WorkspaceError)
    expect(() => parseFrpsAddr('tcp://nohost')).toThrow(WorkspaceError)
  })

  it('renders one http proxy per preview with the host header rewritten', () => {
    const text = renderFrpcConfig({
      server: { protocol: 'wss', host: 'frp.example.net', port: 443 },
      loginToken: 'login-1',
      admin: { port: 7400, user: 'aa', password: 'secret' },
      proxyUrl: 'http://proxy.corp:3128',
      proxies: [{ previewId: 'pv_1', slug: 'k3x9q2abcd', port: 5173, localIP: '::1', token: 'tok-1' }],
    })
    expect(text).toContain('transport.protocol = "wss"')
    expect(text).toContain('transport.proxyURL = "http://proxy.corp:3128"')
    expect(text).toContain('subdomain = "k3x9q2abcd"')
    expect(text).toContain('localIP = "::1"')
    expect(text).toContain('hostHeaderRewrite = "[::1]:5173"')
    expect(text).toContain('metadatas.previewToken = "tok-1"')
    expect(text).toContain('webServer.addr = "127.0.0.1"')
    expect(() => renderFrpcConfig({ server: { protocol: 'tcp', host: 'h', port: 1 }, loginToken: '', admin: { port: 1, user: 'a', password: 'b' },
      proxies: [{ previewId: 'p', slug: 'Bad Slug"', port: 1, localIP: '127.0.0.1', token: '' }] })).toThrow(WorkspaceError)
  })
})

class FakeChild extends EventEmitter implements ChildLike {
  public killed: string[] = []
  public constructor(public readonly pid: number) {
    super()
  }

  public kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal)
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }

  public crash(): void {
    this.emit('exit', 1, null)
  }
}

describe('FrpcManager', () => {
  let dir: string
  let children: FakeChild[]
  let calls: string[]
  let reloadOk: boolean
  let clock: number
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aa-frpc-'))
    children = []
    calls = []
    reloadOk = true
    clock = Date.parse('2026-11-16T12:00:00Z')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const manager = (frpcPath: string | null = '/opt/aa/frpc') => new FrpcManager({
    frpcPath,
    dir,
    spawn: () => {
      const child = new FakeChild(1000 + children.length)
      children.push(child)
      return child
    },
    fetch: (async (url: string | URL) => {
      const path = new URL(String(url)).pathname
      calls.push(path)
      return new Response('{}', { status: path === '/api/reload' && !reloadOk ? 500 : 200 })
    }) as typeof fetch,
    freePort: async () => 7400 + children.length,
    now: () => clock,
  })
  const spec = (id: string, port: number, extra: Partial<PreviewSpec> = {}): PreviewSpec => ({
    previewId: id, slug: `slug${id.replace(/\W/gu, '')}`, port, localIP: '127.0.0.1', token: `tok-${id}`,
    tokenExpiresAt: '2026-11-16T12:10:00Z', frpsAddr: 'wss://frp.example.net', ...extra,
  })

  it('starts one frpc for the first preview and hot-reloads for the next', async () => {
    const frpc = manager()
    await frpc.open(spec('pv1', 5173))
    await frpc.open(spec('pv2', 3000))
    expect(children).toHaveLength(1)
    expect(calls).toEqual(['/api/status', '/api/reload'])
    const config = readFileSync(join(dir, 'frpc.toml'), 'utf8')
    expect(config).toContain('localPort = 5173')
    expect(config).toContain('localPort = 3000')
    expect(statSync(join(dir, 'frpc.toml')).mode & 0o077).toBe(0)
    expect(frpc.openPreviews().map(p => p.previewId)).toEqual(['pv1', 'pv2'])
  })

  it('stops frpc and deletes the config when the last preview closes', async () => {
    const frpc = manager()
    await frpc.open(spec('pv1', 5173))
    await frpc.open(spec('pv2', 5173))
    expect(await frpc.closePort(5173)).toEqual(['pv1', 'pv2'])
    expect(children[0]!.killed).toEqual(['SIGTERM'])
    expect(existsSync(join(dir, 'frpc.toml'))).toBe(false)
    expect(await frpc.close('pv1')).toBe(false)
  })

  it('restarts when the reload fails or the login token expired', async () => {
    const frpc = manager()
    await frpc.open(spec('pv1', 5173))
    reloadOk = false
    await frpc.open(spec('pv2', 3000))
    expect(children).toHaveLength(2)
    reloadOk = true
    clock = Date.parse('2026-11-16T12:30:00Z')
    await frpc.open(spec('pv3', 4000, { tokenExpiresAt: '2026-11-16T12:40:00Z' }))
    expect(children).toHaveLength(3)
    expect(readFileSync(join(dir, 'frpc.toml'), 'utf8')).toContain('metadatas.token = "tok-pv3"')
  })

  it('is unavailable without a bundled frpc', async () => {
    await expect(manager(null).open(spec('pv1', 5173))).rejects.toMatchObject({ code: 'preview_unavailable' })
  })
})

describe('preview commands', () => {
  it('opens after the PortShare check and closes by id', async () => {
    const opened: PreviewSpec[] = []
    const transport = {
      openPreviews: () => opened,
      open: async (s: PreviewSpec) => { opened.push(s) },
      close: async (id: string) => opened.some(p => p.previewId === id),
      closePort: async () => [],
      closeAll: async () => {},
    }
    const commands = previewCommands({
      transport,
      listening: async () => [listening(5173, '0.0.0.0'), listening(8888, '127.0.0.1', 300)],
      sessionOf: async bindings => (bindings.some(b => b.pid === 100) ? 'sess_a' : null),
    })
    await expect(commands.previewOpen({ previewId: 'pv1', slug: 'abcdefghij', port: 5173, frpToken: 't', frpsAddr: 'wss://f.example', tokenExpiresAt: '2026-11-16T12:10:00Z' }))
      .resolves.toEqual({ previewId: 'pv1', port: 5173, localIP: '127.0.0.1' })
    expect(opened[0]).toMatchObject({ slug: 'abcdefghij', token: 't' })
    await expect(commands.previewOpen({ previewId: 'pv2', slug: 'abcdefghik', port: 9999, frpToken: 't', frpsAddr: 'wss://f.example', tokenExpiresAt: 'x' }))
      .rejects.toMatchObject({ code: 'preview_port_not_allowed' })
    // Listening on loopback, but not a session's: a Server cannot open it.
    await expect(commands.previewOpen({ previewId: 'pv3', slug: 'abcdefghim', port: 8888, frpToken: 't', frpsAddr: 'wss://f.example', tokenExpiresAt: 'x' }))
      .rejects.toMatchObject({ code: 'preview_port_not_allowed', details: { reason: 'not_session' } })
    expect(opened.map(p => p.previewId)).toEqual(['pv1'])
    await expect(commands.previewClose({ previewId: 'pv1', slug: 'abcdefghij' })).resolves.toEqual({ closed: true })
  })
})
