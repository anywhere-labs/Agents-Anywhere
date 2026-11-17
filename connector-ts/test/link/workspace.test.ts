import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RpcContext } from 'meshcall'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandInbox } from '../../src/application/inbound/index.js'
import { ConversationService } from '../../src/application/index.js'
import type { RuntimeHandles } from '../../src/application/ports/index.js'
import {
  AttachHub,
  CONNECTION_METADATA,
  ControlPlane,
  DEFAULT_REGISTRATION,
  DeviceLink,
  DeviceServices,
  SessionCommandCatalog,
  TERMINAL_OUTPUT_ITEM_BYTES,
  WORKSPACE_METHODS,
  callClass,
  type BlobTransfer,
  type TerminalOutputItem,
  type UploadFile,
  type WorkspaceServiceDeps,
} from '../../src/link/index.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { DeviceReaders, MemoryChangeFeed, OutboxSignal, plainSealer } from '../../src/sync/index.js'
import { FileOps, RootPolicy, ShellOps, TERMINAL_SCROLLBACK_MAX_BYTES, Terminals, workspaceMethods, type Pty, type SpawnPty } from '../../src/workspace/index.js'
import { FakeServer, RouterProcess, routerBinary } from '../support/mesh-harness.js'

/** What the Server sends (server/tests/test_device_workspace.py writes it from the Server's real requests). */
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/server-workspace-calls.json', import.meta.url), 'utf8')) as {
  calls: { method: string; params: Record<string, unknown> }[]
  terminalOutput: Record<string, unknown>
}

class FakePty implements Pty {
  public readonly pid = 4242
  public readonly written: Buffer[] = []
  public killed = false
  private data?: (data: string) => void
  private exit?: (event: { exitCode: number }) => void

  public onData(listener: (data: string) => void): void {
    this.data = listener
  }
  public onExit(listener: (event: { exitCode: number }) => void): void {
    this.exit = listener
  }
  public write(data: string | Buffer): void {
    this.written.push(Buffer.from(data))
  }
  public resize(): void {}
  public kill(): void {
    this.killed = true
  }
  public print(text: string): void {
    this.data?.(text)
  }
  public end(exitCode: number): void {
    this.exit?.({ exitCode })
  }
}

const WORKSPACE_REGISTRATION = { 'aa.device.v1.Workspace': ['call', 'terminalOutput'], 'aa.device.v1.Runtime': ['catalogs'] }

let base: string
let root: string
let spawned: FakePty[]
let terminals: Terminals
let uploads: { transfer: BlobTransfer; file: UploadFile }[]

const spawn: SpawnPty = () => {
  const pty = new FakePty()
  spawned.push(pty)
  return pty
}

function workspaceDeps(): WorkspaceServiceDeps {
  const policy = new RootPolicy({ roots: [root] })
  const files = new FileOps(policy)
  return {
    methods: workspaceMethods(files, new ShellOps(policy), terminals),
    terminals,
    preparedFile: params => files.preparedFile(params),
    upload: async (transfer, file) => void uploads.push({ transfer, file }),
  }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aa-ws-')))
  root = join(base, 'repo')
  mkdirSync(join(root, 'notes'), { recursive: true })
  spawned = []
  uploads = []
  terminals = new Terminals({ policy: new RootPolicy({ roots: [root] }), spawn, platform: 'linux', env: { SHELL: '/bin/sh', PATH: process.env.PATH ?? '/usr/bin:/bin' } })
})

afterEach(() => {
  terminals.shutdown()
  rmSync(base, { recursive: true, force: true })
})

/** The fixture with its placeholders filled in for this device and root. */
function fill<T>(value: T, names: Record<string, string>): T {
  return JSON.parse(JSON.stringify(value).replace(/\{(\w+)\}/gu, (match, name: string) => names[name] ?? match)) as T
}

describe('aa.device.v1.Workspace handlers', () => {
  const context = (signal = new AbortController().signal) => ({ signal, metadata: { [CONNECTION_METADATA]: 'lc_1' } }) as unknown as RpcContext
  let catalog: SessionCommandCatalog
  let attach: AttachHub

  type Handlers = Record<string, (request: Record<string, unknown>, context: RpcContext) => unknown>

  function services(): { workspace: Handlers; runtime: Handlers } {
    catalog = new SessionCommandCatalog()
    attach = new AttachHub()
    const built = new DeviceServices({
      connectionId: () => 'lc_1',
      attach,
      outbox: {} as never,
      watch: {} as never,
      readers: { catalogs: async (request: { sessionId: string }) => ({ sessionId: request.sessionId, catalogs: { models: [{ id: 'm1' }] } }) } as never,
      inbox: {} as never,
      workspace: workspaceDeps(),
      sessionCommands: sessionId => catalog.get(sessionId),
    }).build(WORKSPACE_REGISTRATION, null)
    expect(built.names).toEqual(['aa.device.v1.Workspace', 'aa.device.v1.Runtime'])
    const [workspace, runtime] = built.services as Handlers[]
    return { workspace: workspace!, runtime: runtime! }
  }

  const call = async (svc: ReturnType<typeof services>, method: string, params: Record<string, unknown>) =>
    ((await svc.workspace.call!({ method, params }, context())) as { result: Record<string, unknown> }).result

  it('refuses every method outside the whitelist before running anything', async () => {
    const svc = services()
    for (const method of ['shell.task.start', 'shell.task.cancel', 'fs.readRange', 'terminal.relay.connect', 'terminal.release', 'session.sendMessage', '']) {
      await expect(svc.workspace.call!({ method, params: { root } }, context())).rejects.toMatchObject({ code: 'invalid_argument' })
    }
    expect(WORKSPACE_METHODS).not.toContain('shell.task.start')
    expect(callClass('aa.device.v1.Workspace', 'terminalOutput')).toBe('stream')
    expect(callClass('aa.device.v1.Workspace', 'call')).toBe('read')
    // A replaced connection generation is refused like every other call.
    await expect(svc.workspace.call!({ method: 'fs.readDir', params: { root } }, { signal: new AbortController().signal, metadata: { [CONNECTION_METADATA]: 'lc_old' } } as never)).rejects.toMatchObject({ code: 'failed_precondition' })
  })

  it('writes, lists and reads files with the v2 shapes, and keeps to the allowed roots', async () => {
    const svc = services()
    const scope = { sessionId: 'browse_dev_1', root }
    expect(await call(svc, 'fs.writeFile', { ...scope, path: join(root, 'notes/a.txt'), content: 'hello\n', encoding: 'utf8' })).toMatchObject({ bytesWritten: 6 })
    expect(await call(svc, 'fs.readDir', { ...scope, path: join(root, 'notes') })).toMatchObject({ entries: [{ name: 'a.txt', type: 'file' }] })
    expect(await call(svc, 'fs.readText', { ...scope, path: 'notes/a.txt', maxBytes: 1024 })).toMatchObject({ content: 'hello\n', truncated: false })
    await expect(call(svc, 'fs.readText', { ...scope, path: join(base, 'outside.txt') })).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('prepares a download and sends it to the Server path in the background', async () => {
    const svc = services()
    const scope = { sessionId: 'browse_dev_1', root, path: 'big.bin' }
    await call(svc, 'fs.writeFile', { ...scope, content: 'x'.repeat(5000) })
    expect(await call(svc, 'fs.prepareDownload', scope)).toMatchObject({ name: 'big.bin', size: 5000 })
    const answer = await call(svc, 'fs.uploadPreparedDownload', { ...scope, transferId: 'tr_1', token: 'tt_1', uploadUrl: '/api/v3/device/transfers/tr_1' })
    expect(answer).toEqual({ transferId: 'tr_1', uploadStarted: true })
    await new Promise(resolve => setImmediate(resolve))
    expect(uploads).toEqual([{ transfer: { transferId: 'tr_1', token: 'tt_1', path: '/api/v3/device/transfers/tr_1' }, file: { path: join(root, 'big.bin'), size: 5000, mediaType: 'application/octet-stream' } }])
    for (const uploadUrl of ['https://elsewhere.example/x', '//elsewhere.example/x']) {
      await expect(call(svc, 'fs.uploadPreparedDownload', { ...scope, transferId: 'tr_2', token: 't', uploadUrl })).rejects.toMatchObject({ code: 'invalid_argument' })
    }
    await expect(call(svc, 'fs.uploadPreparedDownload', { ...scope, transferId: 'tr_3', token: 't', path: 'missing.bin' })).rejects.toMatchObject({ code: 'not_found' })
    expect(uploads).toHaveLength(1)
  })

  it('streams a terminal to several readers: replay, output, unsubscribe, close', async () => {
    const svc = services()
    const scope = { sessionId: 'browse_dev_1', terminalId: 'trm_1' }
    await call(svc, 'terminal.create', { ...scope, root, cols: 100, rows: 30, outputTransport: 'relay' })
    const pty = spawned[0]!
    pty.print('$ ')
    const first = new AbortController()
    const a = (svc.workspace.terminalOutput!(scope, context(first.signal)) as AsyncGenerator<TerminalOutputItem>)
    expect((await a.next()).value).toMatchObject({ m: 'terminal.replay', p: { terminalId: 'trm_1', seq: 1, dataBase64: Buffer.from('$ ').toString('base64') } })
    pty.print('ls\n')
    expect((await a.next()).value).toEqual({ m: 'terminal.output', p: { terminalId: 'trm_1', seq: 2, dataBase64: Buffer.from('ls\n').toString('base64') } })

    // A second reader gets its own replay; both see what follows.
    const second = new AbortController()
    const b = (svc.workspace.terminalOutput!(scope, context(second.signal)) as AsyncGenerator<TerminalOutputItem>)
    expect((await b.next()).value).toMatchObject({ m: 'terminal.replay', p: { seq: 2, dataBase64: Buffer.from('$ ls\n').toString('base64') } })
    pty.print('a')
    pty.print('b')
    expect((await a.next()).value).toEqual({ m: 'terminal.output', p: { terminalId: 'trm_1', seq: 4, dataBase64: Buffer.from('ab').toString('base64') } })
    expect((await b.next()).value).toMatchObject({ m: 'terminal.output', p: { seq: 4 } })

    // Input goes through Workspace/call.
    expect(await call(svc, 'terminal.write', { ...scope, dataBase64: Buffer.from('pwd\n').toString('base64') })).toEqual({ terminalId: 'trm_1', bytesWritten: 4 })
    expect(pty.written.map(chunk => chunk.toString())).toEqual(['pwd\n'])

    // Cancelling the call unsubscribes that reader only.
    first.abort()
    expect((await a.next()).done).toBe(true)
    pty.print('c')
    expect((await b.next()).value).toMatchObject({ m: 'terminal.output', p: { seq: 5 } })

    // Another scope cannot read it.
    const other = svc.workspace.terminalOutput!({ ...scope, sessionId: 'browse_other' }, context()) as AsyncGenerator<TerminalOutputItem>
    await expect(other.next()).rejects.toMatchObject({ code: 'terminal_not_found' })

    // Closing the terminal ends the stream with its exit.
    expect(await call(svc, 'terminal.close', scope)).toEqual({ terminalId: 'trm_1', closed: true })
    expect((await b.next()).value).toEqual({ m: 'terminal.exited', p: { terminalId: 'trm_1', exitCode: null, reason: 'closed' } })
    expect((await b.next()).done).toBe(true)
    const gone = svc.workspace.terminalOutput!(scope, context()) as AsyncGenerator<TerminalOutputItem>
    await expect(gone.next()).rejects.toMatchObject({ code: 'terminal_not_found' })
  })

  it('reports the exit and replays the scrollback to a reader that fell behind it', async () => {
    const svc = services()
    const scope = { sessionId: 'browse_dev_1', terminalId: 'trm_2' }
    await call(svc, 'terminal.create', { ...scope, root, outputTransport: 'relay' })
    const pty = spawned[0]!
    const reader = svc.workspace.terminalOutput!(scope, context()) as AsyncGenerator<TerminalOutputItem>
    expect((await reader.next()).value).toMatchObject({ m: 'terminal.replay', p: { seq: 0 } })
    // More than the scrollback arrives before the reader asks again.
    const block = 'x'.repeat(64 * 1024)
    const count = TERMINAL_SCROLLBACK_MAX_BYTES / block.length + 2
    for (let i = 0; i < count; i++) pty.print(block)
    const next = (await reader.next()).value as TerminalOutputItem
    expect(next.m).toBe('terminal.replay')
    expect(next.p.seq).toBe(count)
    expect(Buffer.from(String(next.p.dataBase64), 'base64').length).toBe(TERMINAL_SCROLLBACK_MAX_BYTES)
    // Within the scrollback, the chunks a reader missed arrive merged (never above the item limit).
    for (let i = 0; i < 3; i++) pty.print(block)
    const merged = (await reader.next()).value as TerminalOutputItem
    expect(merged).toMatchObject({ m: 'terminal.output', p: { seq: count + 3 } })
    expect(Buffer.from(String(merged.p.dataBase64), 'base64').length).toBe(3 * block.length)
    expect(3 * block.length).toBeLessThanOrEqual(TERMINAL_OUTPUT_ITEM_BYTES)
    pty.end(3)
    expect((await reader.next()).value).toEqual({ m: 'terminal.exited', p: { terminalId: 'trm_2', exitCode: 3, reason: 'exit' } })
    expect((await reader.next()).done).toBe(true)
  })

  it('adds the session slash commands the Runtime reported to Runtime/catalogs', async () => {
    const svc = services()
    expect(await svc.runtime.catalogs!({ sessionId: 'sess_1' }, context())).toEqual({ sessionId: 'sess_1', catalogs: { models: [{ id: 'm1' }], commands: [] } })
    // What ConversationService emits for a Runtime's `commands.updated`.
    catalog.observe('runtime.status', { runtimeId: 'rti_1', sessionId: 'sess_1', status: { event: 'commands.updated', commands: [{ name: 'review', description: 'Review the diff', inputHint: 'files' }, { name: 'init' }, { description: 'nameless' } as never] } })
    catalog.observe('runtime.status', { runtimeId: 'rti_1', sessionId: 'sess_2', status: { event: 'config.updated', options: [], commands: [{ name: 'x' }] } })
    expect(await svc.runtime.catalogs!({ sessionId: 'sess_1' }, context())).toEqual({
      sessionId: 'sess_1',
      catalogs: { models: [{ id: 'm1' }], commands: [{ name: 'review', description: 'Review the diff', inputHint: 'files' }, { name: 'init' }] },
    })
    expect(catalog.get('sess_2')).toEqual([])
  })
})

const binary = routerBinary()

describe.skipIf(binary === null)('the Server requests against a real TS device over a Router', () => {
  let store: RemoteStore
  let router: RouterProcess
  let server: FakeServer
  let link: DeviceLink
  let abort: AbortController
  let running: Promise<void>
  let service: ConversationService
  const clock = { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() }
  const runtimes: RuntimeHandles = { handle: async () => null }

  beforeEach(async () => {
    store = inProcessStore(openSqliteStore({ dataDir: join(base, 'store'), durability: 'normal', now: clock.nowIso }))
    router = new RouterProcess(binary!)
    await router.start()
    server = new FakeServer(router)
    await server.start()
  })

  afterEach(async () => {
    abort?.abort()
    await running?.catch(() => undefined)
    await service?.close()
    await server.close()
    await router.close()
    await store.close()
  })

  it('runs every Workspace/call and terminalOutput request the Server sends, as the Server sends it', async () => {
    const feed = new MemoryChangeFeed()
    service = new ConversationService({ store, feed, live: { emit: () => undefined }, runtimes, clock, ids: { newId: (prefix: string) => `${prefix}${Math.random().toString(36).slice(2)}` } })
    const outboxSignal = new OutboxSignal()
    const stored = server.deviceCredential
    const egress = () => ({ proxy: null, source: 'test' }) as const
    link = new DeviceLink({
      deviceId: server.deviceId,
      host: 'cli',
      handshake: new ControlPlane({ serverUrl: server.url, credential: () => stored, egress, connectorVersion: '3.0.0-test', os: 'darwin' }),
      store,
      inbox: new CommandInbox(store, clock, service),
      outboxSignal,
      services: {
        outbox: { outbox: store.outbox, sealer: plainSealer, signal: outboxSignal, pollMs: 100 },
        watch: { store, feed, now: clock.nowIso },
        readers: new DeviceReaders(store, clock.nowIso),
        workspace: workspaceDeps(),
      },
      // The generated table gains Workspace with the next contract export; until then it is added here.
      registration: { off: { ...DEFAULT_REGISTRATION.off, ...WORKSPACE_REGISTRATION }, required: DEFAULT_REGISTRATION.required },
      egress,
      timing: { backoffBaseMs: 100, backoffMaxMs: 1000, readyRetryMaxMs: 1000, monitorMs: 50 },
    })
    abort = new AbortController()
    running = link.run(abort.signal)
    const started = Date.now()
    while (link.state !== 'online') {
      if (Date.now() - started > 10_000) throw new Error('the link did not come online')
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    const names = { root, deviceId: server.deviceId, terminalId: 'trm_fixture', transferId: 'tr_fixture', token: 'tt_fixture' }
    const results = new Map<string, Record<string, unknown>>()
    for (const { method, params } of fill(FIXTURE.calls, names)) {
      if (method === 'terminal.close') continue
      const response = await server.call<{ result: Record<string, unknown> }>('aa.device.v1.Workspace', 'call', { method, params })
      results.set(method, response.result)
    }
    expect(results.get('fs.writeFile')).toMatchObject({ bytesWritten: 6 })
    expect(results.get('fs.readDir')).toMatchObject({ entries: [{ name: 'a.txt' }] })
    expect(results.get('fs.readText')).toMatchObject({ content: 'hello\n' })
    expect(results.get('fs.prepareDownload')).toMatchObject({ name: 'a.txt', size: 6 })
    expect(results.get('fs.uploadPreparedDownload')).toEqual({ transferId: 'tr_fixture', uploadStarted: true })
    expect(uploads[0]?.transfer).toEqual({ transferId: 'tr_fixture', token: 'tt_fixture', path: '/api/v3/device/transfers/tr_fixture' })
    expect(results.get('terminal.create')).toMatchObject({ terminalId: 'trm_fixture', sessionId: `browse_${server.deviceId}`, cols: 100, rows: 30, label: 'Build' })
    expect(results.get('terminal.list')).toMatchObject({ terminals: [{ terminalId: 'trm_fixture', label: 'Build' }] })
    expect(results.get('terminal.rename')).toMatchObject({ terminalId: 'trm_fixture', label: 'Renamed' })
    expect(results.get('terminal.setPersistent')).toMatchObject({ persistent: true })
    expect(results.get('terminal.resize')).toEqual({ terminalId: 'trm_fixture', cols: 120, rows: 40 })
    expect(results.get('terminal.write')).toEqual({ terminalId: 'trm_fixture', bytesWritten: 8 })
    expect(results.get('terminal.snapshot')).toMatchObject({ terminal: { terminalId: 'trm_fixture' }, seq: 0 })
    expect(results.get('shell.exec')).toMatchObject({ exitCode: 0, stdout: 'hi\n' })
    expect(spawned[0]!.written.map(chunk => chunk.toString())).toEqual(['echo hi\n'])

    // The output stream the terminal WebSocket opens.
    spawned[0]!.print('done\n')
    const worker = server.worker()
    try {
      const stream = worker.serverStream<Record<string, unknown>, TerminalOutputItem>('aa.device.v1.Workspace', 'terminalOutput', fill(FIXTURE.terminalOutput, names), { instance: server.deviceId, metadata: { 'aa-connection-id': server.connectionId ?? '' }, timeoutMs: 10_000 })
      const first = await stream.next()
      expect(first.value).toMatchObject({ m: 'terminal.replay', p: { terminalId: 'trm_fixture', seq: 1, dataBase64: Buffer.from('done\n').toString('base64') } })
      const close = fill(FIXTURE.calls.find(entry => entry.method === 'terminal.close')!, names)
      expect(await server.call('aa.device.v1.Workspace', 'call', close)).toEqual({ result: { terminalId: 'trm_fixture', closed: true } })
      expect((await stream.next()).value).toMatchObject({ m: 'terminal.exited', p: { reason: 'closed' } })
    } finally {
      await worker.close().catch(() => undefined)
    }
  }, 30_000)
})

describe('Sessions/state', () => {
  it('passes the requested part to the readers and refuses an unknown one', async () => {
    const seen: unknown[] = []
    const built = new DeviceServices({
      connectionId: () => 'lc_1',
      attach: new AttachHub({}),
      outbox: {} as never,
      watch: {} as never,
      readers: { sessionState: async (request: unknown) => (seen.push(request), { ok: true }) } as never,
      inbox: {} as never,
    }).build({ 'aa.device.v1.Sessions': ['state'] }, null)
    const sessions = built.services[0] as Record<string, (request: Record<string, unknown>, context: RpcContext) => Promise<unknown>>
    const context = { signal: new AbortController().signal, metadata: { [CONNECTION_METADATA]: 'lc_1' } } as unknown as RpcContext
    await sessions.state!({ sessionId: 's1', part: 'planning' }, context)
    await sessions.state!({ sessionId: 's1', part: 'goal' }, context)
    await sessions.state!({ sessionId: 's1' }, context)
    expect(seen).toEqual([{ sessionId: 's1', part: 'planning' }, { sessionId: 's1', part: 'goal' }, { sessionId: 's1' }])
    await expect(sessions.state!({ sessionId: 's1', part: 'queue' }, context)).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})
