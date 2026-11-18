// aa.device.v1.Client against a real TS device over a real Router: route checks and lanes, chunked bodies,
// command receipts and replays, cancellation, terminal subscriptions, the size limits and the encrypted mode.
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RpcStream } from 'meshcall'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConversationService } from '../../src/application/index.js'
import { CommandInbox } from '../../src/application/inbound/index.js'
import type { RuntimeHandle, RuntimeHandles, SessionCapabilities } from '../../src/application/ports/index.js'
import { capabilitySet } from '../../src/application/runtimes/capabilities.js'
import type { ClientCallChunk, ClientCallHead } from '../../src/generated/device-meshcall/v1_0/client-call-item.js'
import type { TerminalStreamItem } from '../../src/generated/device-meshcall/v1_0/terminal-stream-item.js'
import {
  AttachHub,
  CLIENT_SERVICE,
  ControlPlane,
  DEFAULT_REGISTRATION,
  DeviceLink,
  DeviceServices,
  callClass,
  clientCall,
  type ClientLimits,
  type TerminalSource,
} from '../../src/link/index.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { DeviceReaders, DeviceTunnelApi, MemoryChangeFeed, OutboxSignal, joinChunks, plainSealer } from '../../src/sync/index.js'
import { FileOps, RootPolicy, ShellOps, Terminals, workspaceMethods, type Pty, type SpawnPty } from '../../src/workspace/index.js'
import { FakeRuntimeSession } from '../support/fake-runtime-session.js'
import { FakeServer, RouterProcess, routerBinary } from '../support/mesh-harness.js'

class FakePty implements Pty {
  public readonly pid = 4242
  private data?: (data: string) => void
  private exit?: (event: { exitCode: number }) => void
  public onData(listener: (data: string) => void): void {
    this.data = listener
  }
  public onExit(listener: (event: { exitCode: number }) => void): void {
    this.exit = listener
  }
  public write(): void {}
  public resize(): void {}
  public kill(): void {}
  public print(text: string): void {
    this.data?.(text)
  }
  public end(exitCode: number): void {
    this.exit?.({ exitCode })
  }
}

const SESSION_CAPABILITIES: SessionCapabilities = {
  revision: 1,
  items: ['session.send_message', 'session.interrupt', 'session.interaction.approval', 'catalog.model'].map(id => ({ id: id as never, supported: true })),
}

/** A gate the test opens: commands wait at the inbox until then. */
class Gate {
  public entered = 0
  private open: Promise<void> = Promise.resolve()
  private release: () => void = () => undefined
  public close(): void {
    this.open = new Promise(resolve => (this.release = resolve))
  }
  public pass(): void {
    this.release()
  }
  public async wait(): Promise<void> {
    this.entered++
    await this.open
  }
}

const binary = routerBinary()
const b64 = (text: string): string => Buffer.from(text).toString('base64')
const deadline = (): string => new Date(Date.now() + 30_000).toISOString()

async function poll(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe.skipIf(binary === null)('aa.device.v1.Client over a real Router', () => {
  let base: string
  let root: string
  let store: RemoteStore
  let router: RouterProcess
  let server: FakeServer
  let link: DeviceLink
  let abort: AbortController
  let running: Promise<void>
  let service: ConversationService
  let sessions: FakeRuntimeSession[]
  let ptys: FakePty[]
  let terminals: Terminals
  let releases: number
  let gate: Gate
  const clock = { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() }

  function runtimeHandle(): RuntimeHandle {
    return {
      type: 'codex',
      instanceId: 'codex',
      capabilities: () => ({ revision: 1, items: [] }),
      catalogs: async () => ({}),
      listNativeSessions: async () => ({ sessions: [] }),
      readNativeHistory: async () => ({ items: [] }),
      open: async (target, options) => {
        const session = new FakeRuntimeSession(options.sessionId, target.kind === 'existing' ? target.ref.nativeSessionId : `thr_${sessions.length + 1}`, SESSION_CAPABILITIES)
        sessions.push(session)
        return session
      },
      events: (async function* () {})(),
      stop: async () => undefined,
    }
  }

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'aa-client-')))
    root = join(base, 'repo')
    mkdirSync(root, { recursive: true })
    store = inProcessStore(openSqliteStore({ dataDir: join(base, 'store'), durability: 'normal', now: clock.nowIso }))
    sessions = []
    ptys = []
    releases = 0
    gate = new Gate()
    const spawn: SpawnPty = () => {
      const pty = new FakePty()
      ptys.push(pty)
      return pty
    }
    terminals = new Terminals({ policy: new RootPolicy({ roots: [root] }), spawn, platform: 'linux', env: { SHELL: '/bin/sh', PATH: process.env.PATH ?? '/usr/bin:/bin' } })
    router = new RouterProcess(binary!)
    await router.start()
    server = new FakeServer(router)
    await server.start()
  })

  afterEach(async () => {
    abort?.abort()
    await running?.catch(() => undefined)
    await service?.close()
    terminals.shutdown()
    await server.close()
    await router.close()
    await store.close()
    rmSync(base, { recursive: true, force: true })
  })

  async function startDevice(options: { limits?: Partial<Record<'critical' | 'command' | 'read' | 'stream', number>>; clientLimits?: Partial<ClientLimits> } = {}): Promise<void> {
    const feed = new MemoryChangeFeed()
    const runtimes: RuntimeHandles = { handle: async runtimeId => (runtimeId === 'codex' ? runtimeHandle() : null) }
    const ids = { newId: (prefix: string) => `${prefix}${randomBytes(6).toString('hex')}` }
    service = new ConversationService({ store, feed, live: { emit: () => undefined }, runtimes, clock, ids })
    const inbox = new CommandInbox(store, clock, service)
    // The tunnel's commands pass the gate first; Commands/* use the inbox directly.
    const gated = {
      handle: async (...args: Parameters<CommandInbox['handle']>) => {
        await gate.wait()
        return inbox.handle(...args)
      },
      createAndStart: async (...args: Parameters<CommandInbox['createAndStart']>) => {
        await gate.wait()
        return inbox.createAndStart(...args)
      },
    } as unknown as CommandInbox
    // The session capabilities the client routes check (sending, interrupting, answering notices, selections).
    const readers = new DeviceReaders(store, clock.nowIso, {
      sessionCapabilities: async sessionId => {
        const bound = service?.boundSession(sessionId) ?? null
        return bound === null ? null : (capabilitySet(bound.capabilities, { runtime: 'codex', sessionId }) as never)
      },
      catalogs: async () => null,
    })
    const watch = { store, feed, now: clock.nowIso }
    const policy = new RootPolicy({ roots: [root] })
    const methods = workspaceMethods(new FileOps(policy), new ShellOps(policy), terminals)
    const source: TerminalSource = {
      attach: (params, sink) => terminals.attach(params, sink),
      release: (params, sink) => {
        releases++
        return terminals.release(params, sink)
      },
      snapshot: (params, includeScrollback) => terminals.snapshot(params, includeScrollback),
    }
    const tunnel = new DeviceTunnelApi({ deviceId: server.deviceId, store, readers, watch, inbox: gated, clock, workspace: methods, terminals, newId: ids.newId })
    const outboxSignal = new OutboxSignal()
    const stored = server.deviceCredential
    const egress = () => ({ proxy: null, source: 'test' }) as const
    link = new DeviceLink({
      deviceId: server.deviceId,
      host: 'cli',
      handshake: new ControlPlane({ serverUrl: server.url, credential: () => stored, egress, connectorVersion: '3.0.0-test', os: 'darwin' }),
      store,
      inbox,
      outboxSignal,
      services: {
        outbox: { outbox: store.outbox, sealer: plainSealer, signal: outboxSignal, pollMs: 100 },
        watch,
        readers,
        workspace: { terminals: source },
        client: tunnel,
        ...(options.limits !== undefined ? { limits: options.limits } : {}),
        ...(options.clientLimits !== undefined ? { clientLimits: options.clientLimits } : {}),
      },
      egress,
      timing: { backoffBaseMs: 100, backoffMaxMs: 1000, readyRetryMaxMs: 1000, monitorMs: 50 },
    })
    abort = new AbortController()
    running = link.run(abort.signal)
    await poll(() => link.state === 'online', 'the link to come online', 10_000)
  }

  function open<T>(method: 'call' | 'subscribe', request: Record<string, unknown>): { stream: RpcStream<T>; close: () => Promise<void> } {
    const worker = server.worker()
    const stream = worker.serverStream<Record<string, unknown>, T>(CLIENT_SERVICE, method, request, { instance: server.deviceId, metadata: { 'aa-connection-id': server.connectionId ?? '' }, timeoutMs: 15_000 })
    return { stream, close: () => worker.close().catch(() => undefined) }
  }

  async function call(request: Record<string, unknown>): Promise<{ head: ClientCallHead; chunks: ClientCallChunk[]; body: unknown }> {
    const { stream, close } = open<ClientCallHead | ClientCallChunk>('call', { caller: { userId: 'usr_1', clientId: 'web_1' }, ...request })
    try {
      const items: (ClientCallHead | ClientCallChunk)[] = []
      for await (const item of stream) items.push(item)
      const [head, ...chunks] = items as [ClientCallHead, ...ClientCallChunk[]]
      expect(head.kind).toBe('head')
      return { head, chunks, body: joinChunks(chunks) }
    } finally {
      await close()
    }
  }

  const dev = (): string => server.deviceId
  const sessionPath = (sessionId: string, rest: string): string => `/api/v2/sessions/${sessionId}/${rest}`

  async function createSession(sessionId: string): Promise<void> {
    const created = await call({
      route: 'session.createAndStart',
      method: 'POST',
      path: '/api/v2/sessions/create-and-start',
      body: { connectorId: dev(), runtime: 'codex', cwd: root, content: 'hello', clientMessageId: `cm_${sessionId}` },
      command: { commandId: `cm_${sessionId}`, inputDigest: `sha256:create-${sessionId}`, deadline: deadline() },
      server: { sessionId },
    })
    expect(created.head).toMatchObject({ status: 200, command: { commandId: `cm_${sessionId}`, outcome: 'accepted' } })
    expect(created.body).toMatchObject({ session: { id: sessionId, connectorId: dev() } })
    // The first turn ends, so the next message goes straight to the Runtime.
    await poll(() => sessions.some(session => session.sessionId === sessionId && session.calls.length > 0), 'the first prompt')
    const runtime = sessions.find(session => session.sessionId === sessionId)!
    runtime.emit({ type: 'turn.started', turnId: 't1', origin: 'user', clientMessageId: `cm_${sessionId}` })
    runtime.emit({ type: 'turn.ended', turnId: 't1', reason: 'end_turn' })
    await new Promise(resolve => setTimeout(resolve, 150))
  }

  it('refuses a route the device does not answer, or a method or path that is not the route\'s, before any lane', async () => {
    await startDevice()
    const cases = [
      { route: 'session.meta.get', method: 'GET', path: sessionPath('s1', 'meta') },
      { route: 'session.nope', method: 'GET', path: sessionPath('s1', 'snapshot') },
      { route: 'session.snapshot', method: 'POST', path: sessionPath('s1', 'snapshot') },
      { route: 'session.snapshot', method: 'GET', path: sessionPath('s1', 'runtime/notices') },
      { route: 'session.runtime.notices', method: 'GET', path: sessionPath('s1', 'runtime/notices/x') },
      { route: 'session.plans.get', method: 'GET', path: sessionPath('s1', 'plans/%2E%2E/1') },
      { route: 'session.snapshot', method: 'GET', path: `${sessionPath('s1', 'snapshot')}?limit=5` },
    ]
    for (const request of cases) {
      await expect(call(request), JSON.stringify(request)).rejects.toMatchObject({ code: 'invalid_argument' })
    }
    // A command route needs its receipt identity, a route without a receipt takes none, and the body agrees with it.
    await expect(call({ route: 'session.runtime.interrupt', method: 'POST', path: sessionPath('s1', 'runtime/interrupt'), body: {} })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(call({ route: 'connector.fs.list', method: 'POST', path: `/api/v2/connectors/${dev()}/fs/list`, body: { root }, command: { commandId: 'c_1', inputDigest: 'sha256:x', deadline: deadline() } })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(call({ route: 'session.runtime.messages', method: 'POST', path: sessionPath('s1', 'runtime/messages'), body: { clientMessageId: 'cm_a', content: 'x' }, command: { commandId: 'cm_b', inputDigest: 'sha256:x', deadline: deadline() } })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(gate.entered).toBe(0)
    expect(callClass(CLIENT_SERVICE, 'call', { route: 'session.runtime.notices.respond', method: 'POST', path: sessionPath('s1', 'runtime/notices/n1/respond') })).toBe('critical')
    expect(callClass(CLIENT_SERVICE, 'call', { route: 'session.runtime.messages', method: 'POST', path: sessionPath('s1', 'runtime/messages') })).toBe('command')
    expect(callClass(CLIENT_SERVICE, 'call', { route: 'session.snapshot', method: 'GET', path: sessionPath('s1', 'snapshot') })).toBe('read')
    // A shell task's wait is held open for up to its timeout: it waits on the stream lane, not among the reads.
    expect(callClass(CLIENT_SERVICE, 'call', { route: 'connector.shell.tasks.wait', method: 'GET', path: '/api/v2/connectors/d1/shell/tasks/sht_1/wait' })).toBe('stream')
    expect(callClass(CLIENT_SERVICE, 'subscribe')).toBe('stream')
  }, 30_000)

  it('answers a read with a head and its body in chunks of at most 512 KiB, the query passed through', async () => {
    await startDevice()
    const content = '终端输出 line\n'.repeat(70_000)
    writeFileSync(join(root, 'big.txt'), content)
    const read = await call({ route: 'connector.fs.readText', method: 'POST', path: `/api/v2/connectors/${dev()}/fs/readText`, body: { root, path: 'big.txt', maxBytes: 4 * 1024 * 1024 } })
    expect(read.head).toEqual({ kind: 'head', status: 200, contentType: 'application/json' })
    expect(read.chunks.length).toBeGreaterThan(2)
    for (const chunk of read.chunks) expect(Buffer.byteLength(String(chunk.chunk), 'utf8')).toBeLessThanOrEqual(512 * 1024)
    expect(read.chunks.map(chunk => chunk.seq)).toEqual(read.chunks.map((_chunk, index) => index))
    expect(read.chunks.at(-1)!.end).toBe(true)
    expect(read.body).toMatchObject({ content })

    // An error answer is a head with its status and the `{detail}` body.
    const missing = await call({ route: 'session.snapshot', method: 'GET', path: sessionPath('sess_none', 'snapshot'), query: { limit: '5' } })
    expect(missing.head.status).toBe(404)
    expect(missing.body).toEqual({ detail: { code: 'session_not_found', message: 'session not found' } })
    const badQuery = await call({ route: 'session.timeline', method: 'GET', path: sessionPath('sess_none', 'timeline'), query: { mode: 'sideways' } })
    expect(badQuery.head.status).toBe(422)
  }, 30_000)

  it('settles a command under the Server\'s commandId and replays it without running it again', async () => {
    await startDevice()
    await createSession('sess_srv1')
    const message = {
      route: 'session.runtime.messages',
      method: 'POST',
      path: sessionPath('sess_srv1', 'runtime/messages'),
      body: { content: 'second', queue: 'auto' },
      command: { commandId: 'cm_2', inputDigest: 'sha256:message-2', deadline: deadline() },
    }
    const first = await call(message)
    expect(first.head).toMatchObject({ status: 200, command: { commandId: 'cm_2', outcome: 'accepted' } })
    expect(first.body).toMatchObject({ ok: true })
    const receipt = await store.commands.get('cm_2')
    expect(receipt).toMatchObject({ outcome: 'accepted', inputDigest: 'sha256:message-2' })
    const ranOnce = gate.entered
    const prompts = (): number => sessions.flatMap(session => session.calls).filter(entry => entry.method === 'prompt' || entry.method === 'steer').length
    const before = prompts()
    const replay = await call(message)
    expect(replay.head).toEqual(first.head)
    expect(replay.body).toEqual(first.body)
    expect(gate.entered).toBe(ranOnce + 1)
    expect(prompts()).toBe(before)
    expect((await store.commands.get('cm_2'))?.updatedAt).toBe(receipt?.updatedAt)

    // The same commandId with another input is a conflict.
    const conflict = await call({ ...message, command: { ...message.command, inputDigest: 'sha256:other' } })
    expect(conflict.head).toMatchObject({ status: 409, command: { commandId: 'cm_2', outcome: 'rejected', e: { code: 'command_conflict' } } })

    // A rejected command reports its error; the replay reports the same one.
    const respond = {
      route: 'session.runtime.notices.respond',
      method: 'POST',
      path: sessionPath('sess_srv1', 'runtime/notices/ntc_missing/respond'),
      body: { actionId: 'allow', responseId: 'rsp_1' },
      command: { commandId: 'rsp_1', inputDigest: 'sha256:respond-1', deadline: deadline() },
    }
    const rejected = await call(respond)
    expect(rejected.head.command).toMatchObject({ commandId: 'rsp_1', outcome: 'rejected' })
    const code = rejected.head.command!.e!.code
    // A notice that is gone is not an HTTP error for the client (`{ok: false, error}`, as the Server answered).
    expect(rejected.head.status).toBe(200)
    expect(rejected.body).toMatchObject({ ok: false, error: { code } })
    expect(await store.commands.get('rsp_1')).toMatchObject({ outcome: 'rejected' })
    expect((await call(respond)).head).toEqual(rejected.head)

    // Selections are one command under the generated commandId.
    const select = await call({
      route: 'session.runtime.selections',
      method: 'PATCH',
      path: sessionPath('sess_srv1', 'runtime/selections'),
      body: { selections: { model: null } },
      command: { commandId: 'c_sel1', inputDigest: 'sha256:sel-1', deadline: deadline() },
    })
    expect(select.head.command).toMatchObject({ commandId: 'c_sel1' })
    expect(await store.commands.get('c_sel1')).not.toBeNull()

    // Refused before the inbox (a missing message id under a body the route checks): rejected, nothing recorded.
    const refused = await call({
      route: 'session.runtime.queue.update',
      method: 'PATCH',
      path: sessionPath('sess_srv1', 'runtime/queue/msg_none'),
      body: { content: 'x', attachments: [{ name: 'no id' }] },
      command: { commandId: 'c_q1', inputDigest: 'sha256:q-1', deadline: deadline() },
    })
    expect(refused.head).toMatchObject({ status: 422, command: { commandId: 'c_q1', outcome: 'rejected', e: { code: 'invalid_argument' } } })
    expect(await store.commands.get('c_q1')).toBeNull()
  }, 30_000)

  it('lets a started command settle when the call is cancelled', async () => {
    await startDevice()
    await createSession('sess_srv2')
    const prompts = (): number => sessions.flatMap(session => session.calls).filter(entry => entry.method === 'prompt' || entry.method === 'steer').length
    const before = prompts()
    gate.close()
    const entered = gate.entered
    const { stream, close } = open<ClientCallHead | ClientCallChunk>('call', {
      route: 'session.runtime.messages',
      method: 'POST',
      path: sessionPath('sess_srv2', 'runtime/messages'),
      caller: { userId: 'usr_1' },
      body: { clientMessageId: 'cm_cancel', content: 'keep going' },
      command: { commandId: 'cm_cancel', inputDigest: 'sha256:cancel', deadline: deadline() },
    })
    const pending = stream.next().catch(error => error)
    await poll(() => gate.entered > entered, 'the command to reach the inbox')
    await stream.cancel('client left')
    await pending
    await close()
    expect(await store.commands.get('cm_cancel')).toBeNull()
    gate.pass()
    await poll(async () => (await store.commands.get('cm_cancel'))?.outcome === 'accepted', 'the receipt')
    await poll(() => prompts() > before, 'the message to reach the Runtime')
    await poll(() => link.inflight('command') === 0, 'the command lane to be free')
  }, 30_000)

  it('puts critical routes in the critical lane, which reads and commands do not use', async () => {
    await startDevice({ limits: { critical: 3, command: 1 } })
    // The interrupt reaches the inbox only for a session the device holds.
    await createSession('sess_crit')
    // Link/attach and Link/outbox hold two critical slots for the whole connection.
    await poll(() => link.inflight('critical') === 2, 'the link streams')
    gate.close()
    const interrupt = call({
      route: 'session.runtime.interrupt',
      method: 'POST',
      path: sessionPath('sess_crit', 'runtime/interrupt'),
      body: {},
      command: { commandId: 'c_int1', inputDigest: 'sha256:int-1', deadline: deadline() },
    })
    await poll(() => link.inflight('critical') === 3, 'the interrupt in the critical lane')
    expect(link.inflight('command')).toBe(0)
    // Another critical route is refused; a read and a command still run beside it.
    await expect(call({ route: 'session.runtime.notices', method: 'GET', path: sessionPath('sess_x', 'runtime/notices') })).rejects.toMatchObject({ code: 'resource_exhausted' })
    // Answered (the session does not exist), not refused for want of a slot.
    expect((await call({ route: 'session.runtime.state', method: 'GET', path: sessionPath('sess_x', 'runtime/state') })).head.status).toBe(404)
    expect((await call({ route: 'connector.terminals.list', method: 'GET', path: `/api/v2/connectors/${dev()}/terminals-v2` })).head.status).toBe(200)
    expect((await call({ route: 'connector.fs.write', method: 'POST', path: `/api/v2/connectors/${dev()}/fs/write`, body: { root, path: 'note.txt', content: 'hi' } })).head.status).toBe(200)
    gate.pass()
    expect((await interrupt).head.command).toMatchObject({ commandId: 'c_int1' })
    await poll(() => link.inflight('critical') === 2, 'the critical lane to be free')
  }, 30_000)

  it('streams a terminal to several subscribers and releases it when the last one leaves', async () => {
    await startDevice()
    const created = await call({ route: 'connector.terminals.create', method: 'POST', path: `/api/v2/connectors/${dev()}/terminals-v2`, body: { root, cwd: '.' } })
    expect(created.head.status).toBe(200)
    const terminalId = (created.body as { result: { terminalId: string } }).result.terminalId
    ptys[0]!.print('$ ')
    const a = open<TerminalStreamItem>('subscribe', { stream: 'terminal', terminalId, fromSeq: 0 })
    expect((await a.stream.next()).value).toEqual({ type: 'replay', data: b64('$ '), seq: 1 })
    ptys[0]!.print('ls\n')
    expect((await a.stream.next()).value).toEqual({ type: 'output', data: b64('ls\n'), seq: 2 })
    const b = open<TerminalStreamItem>('subscribe', { stream: 'terminal', terminalId })
    expect((await b.stream.next()).value).toEqual({ type: 'replay', data: b64('$ ls\n'), seq: 2 })
    // Input goes through Client/call; both readers see the output.
    const written = await call({ route: 'connector.terminals.write', method: 'POST', path: `/api/v2/connectors/${dev()}/terminals-v2/${terminalId}/write`, body: { dataBase64: b64('pwd\n') } })
    expect(written.head.status).toBe(200)
    ptys[0]!.print('/repo\n')
    expect((await a.stream.next()).value).toEqual({ type: 'output', data: b64('/repo\n'), seq: 3 })
    expect((await b.stream.next()).value).toEqual({ type: 'output', data: b64('/repo\n'), seq: 3 })
    // One reader leaving keeps the terminal attached for the other.
    await a.stream.cancel('closed')
    await a.close()
    await poll(() => link.inflight('stream') === 1, 'the first subscription to end')
    expect(releases).toBe(0)
    ptys[0]!.end(3)
    expect((await b.stream.next()).value).toEqual({ type: 'exit', exitCode: 3, reason: 'exit' })
    expect((await b.stream.next()).done).toBe(true)
    await b.close()
    await poll(() => releases === 1, 'the terminal to be released')
    await poll(() => link.inflight('stream') === 0, 'the stream lane to be free')
  }, 30_000)

  it('unsubscribes when the subscription is cancelled, and refuses an unknown terminal', async () => {
    await startDevice()
    const created = await call({ route: 'connector.terminals.create', method: 'POST', path: `/api/v2/connectors/${dev()}/terminals-v2`, body: { root, cwd: '.' } })
    const terminalId = (created.body as { result: { terminalId: string } }).result.terminalId
    const sub = open<TerminalStreamItem>('subscribe', { stream: 'terminal', terminalId })
    expect((await sub.stream.next()).value).toMatchObject({ type: 'replay', seq: 0 })
    expect(link.inflight('stream')).toBe(1)
    await sub.stream.cancel('closed')
    await sub.close()
    await poll(() => releases === 1, 'the terminal to be released')
    await poll(() => link.inflight('stream') === 0, 'the stream lane to be free')

    const unknown = open<TerminalStreamItem>('subscribe', { stream: 'terminal', terminalId: 'trm_none' })
    await expect(unknown.stream.next()).rejects.toMatchObject({ code: 'terminal_not_found' })
    await unknown.close()
  }, 30_000)

  it('answers 413 to a request body over the limit and 500 to a response over it, running nothing', async () => {
    await startDevice({ clientLimits: { maxResponseBytes: 64 * 1024 } })
    const big = await call({
      route: 'session.runtime.messages',
      method: 'POST',
      path: sessionPath('sess_x', 'runtime/messages'),
      body: { clientMessageId: 'cm_big', content: 'x'.repeat(1024 * 1024 + 1) },
      command: { commandId: 'cm_big', inputDigest: 'sha256:big', deadline: deadline() },
    })
    expect(big.head).toMatchObject({ status: 413, command: { commandId: 'cm_big', outcome: 'rejected', e: { code: 'request_too_large' } } })
    expect(big.body).toMatchObject({ detail: { code: 'request_too_large' } })
    expect(gate.entered).toBe(0)
    expect(await store.commands.get('cm_big')).toBeNull()

    writeFileSync(join(root, 'wide.txt'), 'y'.repeat(100 * 1024))
    const wide = await call({ route: 'connector.fs.readText', method: 'POST', path: `/api/v2/connectors/${dev()}/fs/readText`, body: { root, path: 'wide.txt' } })
    expect(wide.head).toEqual({ kind: 'head', status: 500, contentType: 'application/json' })
    expect(wide.body).toMatchObject({ detail: { code: 'response_too_large' } })
  }, 30_000)
})

describe('aa.device.v1.Client registration', () => {
  function services(client: boolean): DeviceServices {
    return new DeviceServices({
      connectionId: () => 'lc_1',
      attach: new AttachHub({}),
      outbox: {} as never,
      watch: {} as never,
      readers: {} as never,
      inbox: {} as never,
      ...(client ? { client: { request: async () => ({ status: 200, body: {} }), subscribe: async () => () => undefined } } : {}),
    })
  }

  it('is registered in normal mode and never in encrypted mode', () => {
    expect(DEFAULT_REGISTRATION.off[CLIENT_SERVICE]).toEqual(['call', 'subscribe'])
    expect(Object.keys(DEFAULT_REGISTRATION.required)).not.toContain(CLIENT_SERVICE)
    expect(services(true).build(DEFAULT_REGISTRATION.off, null, 'off').names).toContain(CLIENT_SERVICE)
    expect(services(true).build(DEFAULT_REGISTRATION.required, null, 'required').names).not.toContain(CLIENT_SERVICE)
    // Without a client API the service is left out rather than registered empty.
    const without = services(false).build(DEFAULT_REGISTRATION.off, null, 'off')
    expect(without.names).not.toContain(CLIENT_SERVICE)
    expect(without.skipped).toContain(CLIENT_SERVICE)
  })
})

describe('clientCall bodies', () => {
  async function answer(response: { status: number; body: unknown; contentType?: string }): Promise<(ClientCallHead | ClientCallChunk)[]> {
    const api = { request: async () => response, subscribe: async () => () => undefined }
    const items: (ClientCallHead | ClientCallChunk)[] = []
    const request = { route: 'session.plans.markdown', method: 'GET', path: '/api/v2/sessions/sess_1/plans/plan_1/2/markdown', caller: { userId: 'usr_1' } }
    for await (const item of clientCall(api as never, request)) items.push(item)
    return items
  }

  it('sends a text body as it is under its own media type, and JSON otherwise', async () => {
    const [head, ...chunks] = await answer({ status: 200, body: '# Plan\n\n- step', contentType: 'text/markdown; charset=utf-8' })
    expect(head).toEqual({ kind: 'head', status: 200, contentType: 'text/markdown; charset=utf-8' })
    expect(chunks.map(chunk => (chunk as ClientCallChunk).chunk).join('')).toBe('# Plan\n\n- step')
    const [jsonHead, ...jsonChunks] = await answer({ status: 200, body: { markdown: 'x' } })
    expect(jsonHead).toEqual({ kind: 'head', status: 200, contentType: 'application/json' })
    expect(joinChunks(jsonChunks as ClientCallChunk[])).toEqual({ markdown: 'x' })
    // A media type without a text body stays JSON.
    const [objectHead] = await answer({ status: 200, body: { a: 1 }, contentType: 'text/plain' })
    expect((objectHead as ClientCallHead).contentType).toBe('application/json')
  })
})
