// A device for client API tests: the real store, use cases, command inbox, readers and workspace, with a scriptable
// opencode-like Runtime (models m1 and m2, permissions ask and auto) and fake terminals.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'vitest'

import { CommandInbox } from '../../src/application/inbound/index.js'
import { ConversationService } from '../../src/application/index.js'
import type { Catalogs, ConfigChange, NativeAppCommandsApi, ConfigOption, ConfigResult, RuntimeCapabilities, RuntimeHandle, RuntimeHandles, SessionCapabilities } from '../../src/application/ports/index.js'
import type { TunnelApiResponse, TunnelCallContext } from '../../src/application/inbound/tunnel-api.js'
import { capabilitySet } from '../../src/application/runtimes/capabilities.js'
import { blobLookup, blobSlices, uploadPreparedDownload } from '../../src/link/index.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { SessionCommandCatalog } from '../../src/sync/client-api/commands.js'
import { DeviceReaders, DeviceTunnelApi, MemoryChangeFeed } from '../../src/sync/index.js'
import { FileOps, RootPolicy, ShellOps, Terminals, workspaceMethods, type Pty, type SpawnPty } from '../../src/workspace/index.js'
import { FakeRuntimeSession } from './fake-runtime-session.js'

export const DEVICE = 'conn_shape'
export const RUNTIME = 'rt_opencode'

export class FakePty implements Pty {
  public readonly pid = 4242
  private data?: (data: string) => void
  public onData(listener: (data: string) => void): void {
    this.data = listener
  }
  public onExit(): void {}
  public write(data: string | Buffer): void {
    this.data?.(Buffer.from(data).toString('utf8'))
  }
  public resize(): void {}
  public kill(): void {}
}

export function configOptions(current: Record<string, string>): ConfigOption[] {
  return [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: current.mode ?? 'default', values: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current.model ?? 'm1', values: [{ value: 'm1', name: 'Model 1' }, { value: 'm2', name: 'Model 2' }] },
    { id: 'permission', name: 'Permission', category: 'permission', type: 'select', currentValue: current.permission ?? 'ask', values: [{ value: 'ask', name: 'Ask' }, { value: 'auto', name: 'Auto' }] },
  ]
}

/** The session capabilities the recording's fake ACP Agent declared. */
export const CAPABILITIES: SessionCapabilities = {
  revision: 1,
  items: [
    { id: 'session.send_message', supported: true },
    { id: 'session.interrupt', supported: true },
    { id: 'session.steer', supported: false },
    { id: 'session.interaction.approval', supported: true },
    { id: 'session.commands', supported: true },
    { id: 'catalog.model', supported: true },
    { id: 'catalog.permission', supported: true },
    { id: 'session.configuration.read', supported: true },
    { id: 'session.configuration.update', supported: true },
    { id: 'runtime.attachment', supported: false },
  ],
}

export class ConfigurableSession extends FakeRuntimeSession {
  public readonly current: Record<string, string> = { mode: 'default', model: 'm1', permission: 'ask' }
  public readonly planningOptionId = 'mode'
  public get configOptions(): readonly ConfigOption[] {
    return configOptions(this.current)
  }
  public override async configure(change: ConfigChange): Promise<ConfigResult> {
    await super.configure(change)
    this.current[change.optionId] = String(change.value)
    return { options: configOptions(this.current), appliesFrom: 'now' }
  }
}

export interface TestDevice {
  readonly base: string
  readonly root: string
  readonly store: RemoteStore
  readonly inbox: CommandInbox
  readonly tunnel: DeviceTunnelApi
  readonly sessions: ConfigurableSession[]
  readonly commands: SessionCommandCatalog
  readonly uploads: Record<string, unknown>[]
  /** What the next opened session declares. */
  capabilities: SessionCapabilities
  request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, context?: TunnelCallContext): Promise<TunnelApiResponse>
  /** Creates and starts `sessionId` with a first message, and lets the Runtime answer it. */
  start(sessionId: string, cwd?: string): Promise<void>
  /** The Runtime runs the turn of the last prompt: started, a reply, ended (unless `keepRunning`). */
  runTurn(reply: string, keepRunning?: boolean): Promise<void>
  close(): Promise<void>
}

export const settle = async (ms = 60): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setTimeout(resolve, ms))
}

export async function testDevice(options: { platform?: NodeJS.Platform; nativeApps?: NativeAppCommandsApi } = {}): Promise<TestDevice> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'aa-client-')))
  const root = join(base, 'workspace')
  mkdirSync(join(root, 'notes'), { recursive: true })
  writeFileSync(join(root, 'notes', 'a.txt'), 'hello\n')
  const store = inProcessStore(openSqliteStore({ dataDir: join(base, 'store'), durability: 'normal', now: () => new Date().toISOString() }))
  const sessions: ConfigurableSession[] = []
  const uploads: Record<string, unknown>[] = []
  const clock = { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() }
  let next = 0
  const ids = { newId: (prefix: string) => `${prefix}${(++next).toString(36)}` }
  const device = { capabilities: CAPABILITIES }
  const catalogs = (sessionId?: string): Catalogs => {
    const current = sessions.find(session => session.sessionId === sessionId)?.current ?? { model: 'm1', permission: 'ask' }
    return {
      models: { runtime: 'opencode', revision: 1, models: [{ id: 'm1', displayName: 'Model 1', selectionId: 'm1', default: true }, { id: 'm2', displayName: 'Model 2', selectionId: 'm2' }] } as never,
      permissions: { runtime: 'opencode', revision: 1, permissions: [] } as never,
      selections: { ...current },
    }
  }
  const handle = (): RuntimeHandle => ({
    type: 'opencode',
    instanceId: RUNTIME,
    capabilities: (): RuntimeCapabilities => device.capabilities,
    catalogs: async sessionId => catalogs(sessionId),
    listNativeSessions: async () => ({ sessions: [] }),
    readNativeHistory: async () => ({ items: [] }),
    open: async (_target, open) => {
      const session = new ConfigurableSession(open.sessionId, `native-${sessions.length + 1}`, device.capabilities)
      sessions.push(session)
      return session
    },
    events: (async function* () {})(),
    stop: async () => undefined,
  })
  const runtimes: RuntimeHandles = { handle: async runtimeId => (runtimeId === RUNTIME ? handle() : null) }
  const service = new ConversationService({ store, feed: new MemoryChangeFeed(), live: { emit: () => undefined }, runtimes, clock, ids })
  const commands = new SessionCommandCatalog()
  const readers = new DeviceReaders(store, clock.nowIso, {
    sessionCapabilities: async sessionId => {
      const bound = service.boundSession(sessionId)
      if (bound === null) return null
      const items = [...bound.capabilities.items, ...(await service.lifecycleCapabilities(sessionId))]
      return capabilitySet({ revision: bound.capabilities.revision, items }, { runtime: 'opencode', sessionId }) as never
    },
    catalogs: async sessionId => catalogs(sessionId) as never,
  })
  const policy = new RootPolicy({ roots: [root] })
  const files = new FileOps(policy, options.platform ?? 'linux')
  const spawn: SpawnPty = () => new FakePty()
  const terminals = new Terminals({ policy, spawn, platform: 'linux', env: { SHELL: '/bin/sh', PATH: process.env.PATH ?? '/usr/bin:/bin' } })
  const shell = new ShellOps(policy)
  const methods = workspaceMethods(files, shell, terminals)
  const inbox = new CommandInbox(store, clock, service)
  const tunnel = new DeviceTunnelApi({
    deviceId: DEVICE,
    store,
    readers,
    watch: { store, feed: new MemoryChangeFeed(), now: clock.nowIso },
    inbox,
    clock,
    workspace: methods,
    newId: ids.newId,
    commands: sessionId => commands.get(sessionId),
    ...(options.nativeApps !== undefined ? { nativeApps: options.nativeApps } : {}),
    runtimes: { catalogs: async runtimeId => (runtimeId === RUNTIME ? { runtimeType: 'opencode', catalogs: catalogs() as Record<string, unknown> } : null) },
    transferUpload: async params => {
      uploads.push(params)
      return uploadPreparedDownload({ preparedFile: p => files.preparedFile(p), upload: async () => undefined }, params)
    },
    platform: options.platform ?? 'linux',
    agent: service,
    blobs: blobSlices(blobLookup({ blobs: store.blobs, attachment: async () => null })),
  })
  const caller = { clientId: 'cl_test', label: 'Test', platform: 'web' }
  const testDevice: TestDevice = {
    base,
    root,
    store,
    inbox,
    tunnel,
    sessions,
    commands,
    uploads,
    get capabilities() {
      return device.capabilities
    },
    set capabilities(value: SessionCapabilities) {
      device.capabilities = value
    },
    request: (method, path, body, context) => tunnel.request(caller, { method, path: `/api/v2${path}`, body: body ?? {} }, context),
    start: async (sessionId, cwd) => {
      const created = await tunnel.request(caller, { method: 'POST', path: '/api/v2/sessions/create-and-start', body: { connectorId: DEVICE, runtime: 'opencode', runtimeId: RUNTIME, cwd: cwd ?? root, content: 'hello e2e', clientMessageId: `cm_${sessionId}` } }, { server: { sessionId } })
      expect(created.status, JSON.stringify(created.body)).toBe(200)
      await testDevice.runTurn('hello e2e')
    },
    runTurn: async (reply, keepRunning = false) => {
      await expect.poll(() => sessions[0]?.calls.filter(call => call.method === 'prompt').length ?? 0).toBeGreaterThan(0)
      const session = sessions[0]!
      const prompts = session.calls.filter(call => call.method === 'prompt')
      const last = prompts[prompts.length - 1] as { delivery: { clientMessageId?: string } }
      const turnId = `t${prompts.length}`
      session.emit({ type: 'turn.started', turnId, origin: 'user', ...(last.delivery.clientMessageId !== undefined ? { clientMessageId: last.delivery.clientMessageId } : {}) })
      session.emit({ type: 'message.completed', turnId, itemId: `a${prompts.length}`, role: 'assistant', text: `echo: ${reply}` })
      if (!keepRunning) session.emit({ type: 'turn.ended', turnId, reason: 'end_turn' })
      await settle()
    },
    close: async () => {
      terminals.shutdown()
      await shell.close()
      await store.close()
      rmSync(base, { recursive: true, force: true })
    },
  }
  return testDevice
}
