import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandInbox } from '../../src/application/inbound/index.js'
import { ConversationService } from '../../src/application/index.js'
import type { RuntimeHandles } from '../../src/application/ports/index.js'
import { AttachHub, ControlPlane, DeviceLink, callClass, rewriteUpgradeHead, secureChannelVia, type Egress, type LinkState, type SecureChannelWire } from '../../src/link/index.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { DeviceReaders, MemoryChangeFeed, OutboxSignal, plainSealer } from '../../src/sync/index.js'
import { ConnectProxy, FakeServer, RouterProcess, routerBinary } from '../support/mesh-harness.js'

async function until(condition: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<number> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return Date.now() - started
}

describe('upgrade head rewrite', () => {
  it('points the request at the real path and host', () => {
    const head = 'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nAuthorization: Bearer mt_x'
    expect(rewriteUpgradeHead(head, new URL('wss://aa.example.com/api/v3/device/mesh?x=1'))).toBe(
      'GET /api/v3/device/mesh?x=1 HTTP/1.1\r\nHost: aa.example.com\r\nUpgrade: websocket\r\nAuthorization: Bearer mt_x',
    )
    expect(rewriteUpgradeHead('GET / HTTP/1.1\r\nUpgrade: websocket', new URL('ws://r:8765/m'))).toBe('GET /m HTTP/1.1\r\nHost: r:8765\r\nUpgrade: websocket')
  })
})

describe('call classes', () => {
  it('keeps creation prompts and the outbox apart from long streams', () => {
    expect(callClass('aa.device.v1.Commands', 'sessionCreationRespond')).toBe('critical')
    expect(callClass('aa.device.v1.Sessions', 'creationGet')).toBe('critical')
    expect(callClass('aa.device.v1.Link', 'outbox')).toBe('critical')
    expect(callClass('aa.device.v1.Commands', 'sessionSync')).toBe('command')
    expect(callClass('aa.device.v1.Sessions', 'watch')).toBe('stream')
    expect(callClass('aa.device.v1.Store', 'readBlob')).toBe('stream')
  })
})

describe('AttachHub', () => {
  it('sends a heartbeat at once, coalesces events and filters by mode', async () => {
    let ended: string | null = null
    const hub = new AttachHub({ heartbeatMs: 60_000, onEnded: (_id, reason) => (ended = reason) })
    hub.emit('runtime.status', { runtimeId: 'r1', status: { state: 'starting' } })
    hub.emit('runtime.status', { runtimeId: 'r1', status: { state: 'ready' } })
    hub.emit('runtime.notice.updated', { sessionId: 's1', notice: { noticeId: 'n1', sessionId: 's1', title: 'Approve', type: 'interaction' } })
    const abort = new AbortController()
    const stream = hub.open('lc_1', abort.signal)
    expect((await stream.next()).value).toEqual({ kind: 'heartbeat' })
    expect((await stream.next()).value).toEqual({ kind: 'event', m: 'runtime.status', p: { runtimeId: 'r1', status: { state: 'ready' } } })
    expect((await stream.next()).value).toEqual({ kind: 'event', m: 'runtime.notice.updated', p: { sessionId: 's1', notice: { noticeId: 'n1', sessionId: 's1', title: 'Approve', type: 'interaction' } } })
    hub.setMode('required')
    hub.emit('runtime.queue.updated', { sessionId: 's1', queue: { sessionId: 's1', revision: 1 } })
    // A session's facts are content in encrypted mode, even on an allowed method; device-level status still goes.
    hub.emit('runtime.status', { runtimeId: 'r1', sessionId: 's1', status: { event: 'planning.state.updated', revision: 1, state: { runtime: 'pi', sessionId: 's1' } } })
    hub.emit('port.listening', { deviceId: 'dev_1', ports: [{ port: 3000 }] })
    expect((await stream.next()).value).toEqual({ kind: 'event', m: 'port.listening', p: { deviceId: 'dev_1', ports: [{ port: 3000 }] } })
    abort.abort()
    expect((await stream.next()).done).toBe(true)
    expect(ended).toBe('cancelled')
    hub.close()
  })

  it('ends the previous stream when a new one opens, and reports a holder that takes no items', async () => {
    const reasons: string[] = []
    const hub = new AttachHub({ heartbeatMs: 60_000, stallMs: 100, onEnded: (_id, reason) => reasons.push(reason) })
    const first = hub.open('lc_1', new AbortController().signal)
    await first.next()
    const second = hub.open('lc_1', new AbortController().signal)
    await second.next()
    expect((await first.next()).done).toBe(true)
    expect(reasons).toEqual([])
    // Nobody asks `second` for its next item: after stallMs it counts as stalled.
    await until(() => reasons.includes('stalled'), 2000, 'stall')
    expect(hub.isOpen).toBe(false)
    expect((await second.next()).done).toBe(true)
    hub.close()
  })
})

describe('secureChannelVia', () => {
  function duplex(items: Record<string, unknown>[]) {
    const sent: Record<string, unknown>[] = []
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    return {
      sent,
      release,
      channel: {
        async *[Symbol.asyncIterator]() {
          yield* items
          await held
        },
        send: async (item: Record<string, unknown>) => void sent.push(item),
        closeSend: async () => undefined,
      },
    }
  }
  const context = () => ({ signal: new AbortController().signal }) as never

  it('feeds items in order and ends the call with the code the channel gives', async () => {
    const received: unknown[] = []
    let wire!: SecureChannelWire
    const hub = {
      open: (_open: { clientId: string; ch: string }, w: SecureChannelWire) => {
        wire = w
        return {
          isClosed: false,
          receive: async (item: { n: number; ct: string }) => {
            received.push(item.n)
            await wire.send({ n: Number(item.n) + 100, ct: item.ct })
            if (item.n === 2) wire.end('not_paired')
          },
          close: async () => undefined,
        }
      },
    }
    const io = duplex([{ n: 1, ct: 'a' }, { n: 2, ct: 'b' }])
    await expect(secureChannelVia(hub)({ clientId: 'cl_1', ch: 'ch_1' }, io.channel as never, context())).rejects.toMatchObject({ code: 'not_paired' })
    expect(received).toEqual([1, 2])
    expect(io.sent).toEqual([{ n: 101, ct: 'a' }, { n: 102, ct: 'b' }])
  })

  it('closes the channel when the client ends its side', async () => {
    const closed: string[] = []
    const hub = { open: () => ({ isClosed: false, receive: async () => undefined, close: async (reason: string) => void closed.push(reason) }) }
    const io = duplex([{ n: 1, ct: 'a' }])
    io.release()
    await secureChannelVia(hub)({ clientId: 'cl_1', ch: 'ch_1' }, io.channel as never, context())
    expect(closed).toEqual(['shutdown'])
  })
})

const binary = routerBinary()

describe.skipIf(binary === null)('DeviceLink against a real Router', () => {
  let dir: string
  let store: RemoteStore
  let router: RouterProcess
  let server: FakeServer
  let link: DeviceLink
  let abort: AbortController
  let running: Promise<void>
  let states: LinkState[]
  let egressValue: Egress
  let service: ConversationService
  const clock = { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() }
  const runtimes: RuntimeHandles = { handle: async () => null }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aa-link-'))
    store = inProcessStore(openSqliteStore({ dataDir: dir, durability: 'normal', now: clock.nowIso }))
    router = new RouterProcess(binary!)
    await router.start()
    server = new FakeServer(router)
    await server.start()
    states = []
    egressValue = { proxy: null, source: 'test' }
  })

  afterEach(async () => {
    abort?.abort()
    await running?.catch(() => undefined)
    await service?.close()
    await server.close()
    await router.close()
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function startLink(timing: Record<string, number> = {}, bridge: 'auto' | 'always' | 'never' = 'auto'): void {
    const feed = new MemoryChangeFeed()
    service = new ConversationService({ store, feed, live: { emit: () => undefined }, runtimes, clock, ids: { newId: (prefix: string) => `${prefix}${Math.random().toString(36).slice(2)}` } })
    const inbox = new CommandInbox(store, clock, service)
    const outboxSignal = new OutboxSignal()
    const stored = server.deviceCredential
    const handshake = new ControlPlane({ serverUrl: server.url, credential: () => stored, egress: () => egressValue, connectorVersion: '3.0.0-test', os: 'darwin' })
    link = new DeviceLink({
      deviceId: server.deviceId,
      host: 'cli',
      handshake,
      store,
      inbox,
      outboxSignal,
      services: {
        outbox: { outbox: store.outbox, sealer: plainSealer, signal: outboxSignal, pollMs: 100 },
        watch: { store, feed, now: clock.nowIso },
        readers: new DeviceReaders(store, clock.nowIso),
      },
      egress: () => egressValue,
      bridge,
      onState: state => states.push(state),
      ...(process.env.AA_LINK_DEBUG ? { logger: { debug: (m: string) => console.log('D', m), info: (m: string) => console.log('I', m), warn: (m: string) => console.log('W', m), error: (m: string) => console.log('E', m) } } : {}),
      timing: { backoffBaseMs: 100, backoffMaxMs: 1000, readyRetryMaxMs: 1000, monitorMs: 50, ...timing },
    })
    abort = new AbortController()
    running = link.run(abort.signal)
  }

  async function makeSession(sessionId = 'sess_1'): Promise<void> {
    await store.sessions.create({ sessionId, runtimeType: 'pi', runtimeId: 'rti_pi', externalSessionId: `native_${sessionId}`, cwd: '/w', nativeTitle: 'T', status: 'idle', sourceAvailability: 'available', takeover: true, at: clock.nowIso() })
  }

  it('says hello, registers, gets held, delivers the outbox and answers reads and commands', async () => {
    await makeSession()
    startLink()
    await until(() => link.state === 'online', 10_000, 'online')
    expect(states).toEqual(['connecting', 'registered', 'online'])
    expect(server.calls.slice(0, 3)).toEqual(['/api/v3/device/auth', '/api/v3/device/hello', '/api/v3/device/ready'])
    // The summary queued when the session was created arrives and is acknowledged.
    await until(() => server.outbox.some(item => item.m === 'session.summary'), 10_000, 'summary')
    // Reads go through.
    expect(await server.call('aa.device.v1.Commands', 'status', { commandId: 'cmd_none' })).toEqual({ commandId: 'cmd_none', known: false, outcome: null })
    // A replaced generation is refused before anything runs.
    await expect(server.call('aa.device.v1.Commands', 'status', { commandId: 'cmd_none' }, 'lc_old')).rejects.toMatchObject({ code: 'failed_precondition', details: { reason: 'connection_replaced' } })
    // An application error keeps its AA code.
    await expect(server.call('aa.device.v1.Sessions', 'creationGet', { createOperationId: 'op_x' })).rejects.toMatchObject({ code: 'workflow_unsupported' })
    // A command settles with a durable receipt; replay returns the same ack; status reads it.
    const call = { commandId: 'cmd_1', deadline: new Date(Date.now() + 30_000).toISOString(), p: { sessionId: 'sess_1', archived: true } }
    const ack = await server.call<{ outcome: string }>('aa.device.v1.Commands', 'sessionSync', call)
    expect(ack.outcome).toBe('accepted')
    expect(await server.call('aa.device.v1.Commands', 'sessionSync', call)).toEqual(ack)
    expect(await server.call('aa.device.v1.Commands', 'status', { commandId: 'cmd_1' })).toMatchObject({ known: true, outcome: 'accepted' })
    await until(() => server.outbox.some(item => item.m === 'command.result' && item.p.commandId === 'cmd_1'), 10_000, 'command.result')
    // Lossy events ride on attach.
    link.attach.emit('runtime.status', { runtimeId: 'rti_pi', status: { state: 'ready' } })
    await until(() => (server.held?.events.length ?? 0) > 0, 5000, 'event')
    expect(server.held?.events[0]).toEqual({ m: 'runtime.status', p: { runtimeId: 'rti_pi', status: { state: 'ready' } } })
  }, 30_000)

  it('runs the commands a welcome still lists and reports them through the outbox', async () => {
    await makeSession()
    server.pendingCommands = [{ commandId: 'cmd_p', deadline: new Date(Date.now() + 30_000).toISOString(), m: 'session.sync', p: { sessionId: 'sess_1', takeover: false } }]
    startLink()
    await until(() => server.outbox.some(item => item.m === 'command.result' && item.p.commandId === 'cmd_p'), 10_000, 'pending result')
    expect((await store.sessions.get('sess_1'))?.takeover).toBe(false)
  }, 20_000)

  it('calls ready again when the holder worker dies, without a new hello', async () => {
    startLink()
    await until(() => link.state === 'online', 10_000, 'online')
    const hellos = server.hellos
    const seen = states.length
    await server.drop()
    // The re-ready can follow within milliseconds, so look for the transition, not the current state.
    await until(() => states.slice(seen).includes('registered'), 5000, 'attach cancelled')
    const recovery = await until(() => link.state === 'online' && server.held !== null, 10_000, 'held again')
    expect(server.hellos).toBe(hellos)
    expect(recovery).toBeLessThan(5000)
  }, 20_000)

  it('says hello again when its token is revoked, and when the Router restarts', async () => {
    startLink()
    await until(() => link.state === 'online', 10_000, 'online')
    const first = link.connectionId
    await server.revokeToken()
    await until(() => link.connectionId !== first && link.state === 'online', 10_000, 'online after revoke')
    const second = link.connectionId
    await router.kill()
    await until(() => link.state !== 'online', 5000, 'offline')
    await router.start()
    await until(() => link.connectionId !== second && link.state === 'online', 15_000, 'online after restart')
  }, 40_000)

  it('registers only Link and the content-free commands in encrypted mode', async () => {
    await makeSession()
    server.e2eeMode = 'required'
    startLink()
    await until(() => link.state === 'online', 10_000, 'online')
    expect(link.e2eeMode).toBe('required')
    expect(await server.call('aa.device.v1.Commands', 'status', { commandId: 'none' })).toMatchObject({ known: false })
    // Content methods are not on the Router at all, so the Server has nothing to send plaintext to.
    await expect(server.call('aa.device.v1.Sessions', 'creationGet', { createOperationId: 'op_1' })).rejects.toBeTruthy()
    await expect(server.call('aa.device.v1.Commands', 'sessionCreationBegin', { commandId: 'c', deadline: new Date().toISOString(), p: {} })).rejects.toBeTruthy()
    // Only the plaintext-safe events ride on attach.
    link.attach.emit('runtime.notice.updated', { sessionId: 'sess_1', notice: { noticeId: 'n1', sessionId: 'sess_1', title: 'secret', type: 'interaction' } })
    link.attach.emit('port.listening', { deviceId: 'dev_1', ports: [{ port: 5173 }] })
    await until(() => (server.held?.events.length ?? 0) > 0, 5000, 'event')
    expect(server.held?.events.map(event => event.m)).toEqual(['port.listening'])
  }, 20_000)

  it('stops with credential_rejected when the Server refuses the device credential', async () => {
    startLink()
    await until(() => link.state === 'online', 10_000, 'online')
    // Pairing replaced the credential elsewhere: the next hello cannot authenticate.
    server.credential = 'ct_rotated'
    await server.revokeToken()
    await expect(running).rejects.toMatchObject({ code: 'credential_rejected' })
    expect(link.state).toBe('stopped')
  }, 20_000)

  it('reaches the Router through an HTTP CONNECT proxy', async () => {
    const proxy = new ConnectProxy()
    await proxy.start()
    try {
      egressValue = { proxy: proxy.url, source: 'test' }
      startLink()
      await until(() => link.state === 'online', 10_000, 'online via proxy')
      // The handshake and the Router connection both went through the proxy.
      expect(proxy.tunnels).toBeGreaterThanOrEqual(3)
      const state = await server.call<{ state: unknown }>('aa.device.v1.Commands', 'status', { commandId: 'none' })
      expect(state).toMatchObject({ known: false })
    } finally {
      abort.abort()
      await running.catch(() => undefined)
      await proxy.close()
    }
  }, 20_000)
})
