import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { CommandInbox, type CommandHandler } from '../application/inbound/index.js'
import { ConversationService, NativeHistory } from '../application/index.js'
import type { LiveEvents, RuntimeHandle, RuntimeHandleEvent, RuntimeProvider } from '../application/ports/index.js'
import type { ConnectorRuntime, ConnectorSettings, RuntimeFactory } from '../host/index.js'
import { ControlPlane, DeviceLink, readSystemProxySettings, resolveEgress, type Egress, type LinkLogger, type SecureChannelHandler } from '../link/index.js'
import { openStoreWorker, inProcessStore, openSqliteStore, type RemoteStore } from '../store/index.js'
import { DeviceReaders, MemoryChangeFeed, OutboxSignal, capabilitySet, plainSealer, type DisplaySealer, type RuntimeFacts } from '../sync/index.js'
import { builtinProviders, nativeSessionId, RuntimeRegistry, type RuntimeInstanceSpec } from './runtimes.js'

export type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void

export interface ComposeOptions {
  readonly dataDir: string
  readonly host: 'desktop' | 'cli' | 'dsh-plugin'
  readonly connectorVersion: string
  readonly log: Log
  /** The Runtime providers; default the profiles this build ships (`builtinProviders`). */
  readonly providers?: readonly RuntimeProvider[]
  /** Scan native sessions of installed Runtimes when the link comes online (default true). */
  readonly scanOnStart?: boolean
  /** Extra command handlers (preview, runtime/apply, device settings), by business method name. */
  readonly commands?: Readonly<Record<string, CommandHandler>>
  /** F's display sealer for encrypted mode; plain by default. */
  readonly sealer?: DisplaySealer
  /** F's `Secure/channel` handler (`secureChannelVia(hub)`), registered in encrypted mode. */
  readonly secure?: SecureChannelHandler
  /** The store in a worker thread (production) or in this thread (tests, tools). */
  readonly storeMode?: 'worker' | 'in-process'
  /** Told when a link exists (the host wires port events and other live sources to `link.attach`). */
  readonly onLink?: (link: DeviceLink) => void
}

const EGRESS_REFRESH_MS = 60_000
/** Native session changes arrive in bursts (a CLI writes many records); one scan per quiet second. */
const SCAN_DEBOUNCE_MS = 1000

const clock = { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() }
const ids = { newId: (prefix: string) => `${prefix}${randomBytes(12).toString('base64url')}` }

/** The route to the Server, re-read every minute so switching a system proxy on or off needs no restart. */
async function egressFor(settings: ConnectorSettings, signal: AbortSignal, log: Log): Promise<() => Egress> {
  const resolveNow = async (): Promise<Egress> => resolveEgress(settings.serverUrl, { configured: settings.proxy ?? null, system: await readSystemProxySettings() })
  let current = await resolveNow()
  log('info', `network egress: ${current.proxy === null ? 'direct' : 'proxy'} (${current.source})`)
  const timer = setInterval(() => {
    resolveNow().then(next => {
      if (next.proxy !== current.proxy) log('info', `network egress changed: ${next.proxy === null ? 'direct' : 'proxy'} (${next.source})`)
      current = next
    }, () => undefined)
  }, EGRESS_REFRESH_MS)
  timer.unref()
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })
  return () => current
}

/** Turns from `turn.started` to `turn.ended` on this device (a handover waits for zero). */
export async function activeTurns(store: RemoteStore): Promise<number> {
  return (await store.sessions.list()).filter(session => session.activeTurn !== null).length
}

/**
 * The composition root of a configured Connector (04-connector.md §2): the local store, the use cases, the device
 * link and the Runtime providers, wired once per `start`. Everything else in `entry/` is process plumbing.
 */
export function connectorRuntime(options: ComposeOptions, track?: { store(store: RemoteStore | null): void }): RuntimeFactory {
  return (settings, hooks): ConnectorRuntime => ({
    async run(signal) {
      const storeOptions = { dataDir: join(options.dataDir, 'store'), durability: 'normal' as const, now: clock.nowIso }
      const store = options.storeMode === 'in-process' ? inProcessStore(openSqliteStore(storeOptions)) : await openStoreWorker(storeOptions)
      track?.store(store)
      let link: DeviceLink | null = null
      const live: LiveEvents = { emit: (method, payload) => link?.attach.emit(method, payload) }
      const feed = new MemoryChangeFeed()
      const log = options.log
      // Assigned below; Runtime events only arrive after an instance started, which needs the service.
      let onRuntimeEvent: (spec: RuntimeInstanceSpec, handle: RuntimeHandle, event: RuntimeHandleEvent) => void = () => undefined
      const runtimes = new RuntimeRegistry({
        connectorId: settings.connectorId,
        providers: options.providers ?? builtinProviders({ log }),
        log,
        onEvent: (spec, handle, event) => onRuntimeEvent(spec, handle, event),
      })
      let service!: ConversationService
      const history = new NativeHistory({
        store,
        feed,
        runtimes,
        clock,
        sessionIdFor: (_handle, runtimeId, summary) => nativeSessionId(settings.connectorId, runtimes.spec(runtimeId) ?? legacySpec(runtimeId), summary),
        isBound: sessionId => service.isBound(sessionId),
        onError: (sessionId, error) => log('warn', `native history${sessionId === null ? '' : ` of ${sessionId}`}: ${(error as Error)?.message ?? String(error)}`),
      })
      service = new ConversationService({ store, feed, live, runtimes, clock, ids, history })
      const scans = new RuntimeScans(history, log)
      onRuntimeEvent = (spec, handle, event) => runtimeEvent({ spec, handle, event, live, scans, service, store, connectorId: settings.connectorId, log })
      const facts: RuntimeFacts = {
        sessionCapabilities: async sessionId => {
          const session = await store.sessions.get(sessionId)
          if (session === null) return null
          const bound = service.boundSession(sessionId)
          if (bound !== null) return capabilitySet(bound.capabilities, { runtime: session.runtimeId, sessionId })
          const handle = await runtimes.started(session.runtimeId)
          return handle === null || handle === undefined ? null : capabilitySet(handle.capabilities(), { runtime: session.runtimeId, sessionId: null })
        },
        catalogs: async sessionId => {
          const session = await store.sessions.get(sessionId)
          const handle = session === null ? null : await runtimes.started(session.runtimeId)
          return handle === null || handle === undefined ? null : ((await handle.catalogs().catch(() => null)) as Record<string, unknown> | null)
        },
      }
      try {
        await service.recover()
        const egress = await egressFor(settings, signal, options.log)
        const inbox = new CommandInbox(store, clock, service, options.commands ?? {})
        const outboxSignal = new OutboxSignal()
        const logger: LinkLogger = {
          debug: text => options.log('debug', text),
          info: text => options.log('info', text),
          warn: text => options.log('warn', text),
          error: text => options.log('error', text),
        }
        link = new DeviceLink({
          deviceId: settings.connectorId,
          host: options.host,
          handshake: new ControlPlane({
            serverUrl: settings.serverUrl,
            credential: () => ({ deviceId: settings.connectorId, token: settings.connectorToken }),
            egress,
            connectorVersion: options.connectorVersion,
            os: process.platform,
          }),
          store,
          inbox,
          outboxSignal,
          services: {
            outbox: { outbox: store.outbox, sealer: options.sealer ?? plainSealer, signal: outboxSignal },
            watch: { store, feed, now: clock.nowIso },
            readers: new DeviceReaders(store, clock.nowIso, facts, history),
            ...(options.secure !== undefined ? { secure: options.secure } : {}),
          },
          egress,
          logger,
          onWelcome: welcome => {
            const settingsFromServer = welcome.desired?.deviceSettings
            if (settingsFromServer !== undefined && settingsFromServer !== null) hooks.deviceSettings(settingsFromServer)
            runtimes.apply(welcome.desired?.runtimes ?? [])
          },
          onState: state => {
            options.log('info', `device link ${state}`)
            if (state === 'online') void announceRuntimes(runtimes, live, options.scanOnStart !== false ? scans : null, log)
          },
        })
        options.onLink?.(link)
        await link.run(signal)
      } finally {
        scans.close()
        await service.close().catch(() => undefined)
        await runtimes.close().catch(() => undefined)
        track?.store(null)
        await store.close().catch(() => undefined)
      }
    },
  })
}

function legacySpec(runtimeId: string): RuntimeInstanceSpec {
  return { runtimeId, runtimeType: runtimeId, settings: {}, sourceKey: null, enabled: true }
}

function message(error: unknown): string {
  return (error as Error)?.message ?? String(error)
}

/** Native session scans, one at a time per Runtime and debounced, so a burst of changes is one scan. */
class RuntimeScans {
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private closed = false

  public constructor(private readonly history: NativeHistory, private readonly log: Log) {}

  public soon(runtimeId: string, delayMs = SCAN_DEBOUNCE_MS): void {
    if (this.closed) return
    clearTimeout(this.timers.get(runtimeId))
    const timer = setTimeout(() => {
      this.timers.delete(runtimeId)
      void this.now(runtimeId)
    }, delayMs)
    timer.unref()
    this.timers.set(runtimeId, timer)
  }

  public now(runtimeId: string): Promise<unknown> {
    const previous = this.chains.get(runtimeId) ?? Promise.resolve()
    const next = previous.then(async () => {
      if (this.closed) return
      const result = await this.history.scan(runtimeId, ids.newId('scan_'))
      this.log('debug', `native sessions of ${runtimeId}: ${result.sessions}${result.complete ? '' : ' (incomplete)'}`)
    }).catch(error => this.log('warn', `scanning native sessions of ${runtimeId} failed: ${message(error)}`))
    this.chains.set(runtimeId, next)
    return next
  }

  public close(): void {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

/** Every instance's installation facts as `runtime.status` (lossy; sent again whenever the link is online). */
async function announceRuntimes(runtimes: RuntimeRegistry, live: LiveEvents, scans: RuntimeScans | null, log: Log): Promise<void> {
  try {
    for (const { spec, facts, error } of await runtimes.discover()) {
      live.emit('runtime.status', {
        runtimeId: spec.runtimeId,
        status: {
          runtimeType: spec.runtimeType,
          enabled: spec.enabled,
          installed: facts?.installed ?? false,
          ...(facts !== null ? { displayName: facts.displayName, instancePolicy: facts.instancePolicy, processScope: facts.processScope, problems: facts.problems } : {}),
          ...(facts?.agentVersion !== undefined ? { agentVersion: facts.agentVersion } : {}),
          ...(facts?.adapterVersion !== undefined ? { adapterVersion: facts.adapterVersion } : {}),
          ...(facts?.extraVersions !== undefined ? { extraVersions: facts.extraVersions } : {}),
          ...(facts?.configSchema !== undefined ? { configSchema: facts.configSchema } : {}),
          ...(error !== null ? { error: { code: 'runtime_discovery_failed', message: error } } : {}),
        },
      })
      if (scans !== null && spec.enabled && facts?.installed === true && facts.problems.length === 0) void scans.now(spec.runtimeId)
    }
  } catch (error) {
    log('warn', `runtime discovery failed: ${message(error)}`)
  }
}

interface RuntimeEventContext {
  readonly spec: RuntimeInstanceSpec
  readonly handle: RuntimeHandle
  readonly event: RuntimeHandleEvent
  readonly live: LiveEvents
  readonly scans: RuntimeScans
  readonly service: ConversationService
  readonly store: RemoteStore
  readonly connectorId: string
  readonly log: Log
}

/** Runtime-level events: status and capabilities go to the Server live; native changes rescan; follow opens. */
function runtimeEvent(context: RuntimeEventContext): void {
  const { spec, handle, event, live } = context
  switch (event.type) {
    case 'status':
      live.emit('runtime.status', { runtimeId: spec.runtimeId, status: { state: event.status, ...(event.error !== undefined ? { error: event.error } : {}) } })
      return
    case 'capabilities.changed':
      live.emit('runtime.status', { runtimeId: spec.runtimeId, status: { event: 'capabilities.changed' }, capabilities: capabilitySet(event.capabilities, { runtime: spec.runtimeId, sessionId: null }) as Record<string, unknown> })
      return
    case 'catalogs.changed':
      live.emit('runtime.status', { runtimeId: spec.runtimeId, status: { event: 'catalogs.changed', catalogs: event.catalogs as Record<string, unknown> } })
      return
    case 'native_sessions.changed':
      context.scans.soon(spec.runtimeId)
      return
    case 'native_session.follow_suggested': {
      // The companion saw a native session that should be followed (a thread the Codex App opened): make sure it
      // is a Conversation, then open it so its live events are projected.
      const sessionId = nativeSessionId(context.connectorId, spec, { nativeSessionId: event.ref.nativeSessionId, ...(event.ref.locator !== undefined ? { locator: event.ref.locator } : {}) })
      void (async () => {
        if ((await context.store.sessions.get(sessionId)) === null) await context.scans.now(spec.runtimeId)
        if ((await context.store.sessions.get(sessionId)) === null) {
          context.log('info', `not following ${handle.type} session ${event.ref.nativeSessionId}: not in the native session list`)
          return
        }
        await context.service.binding(sessionId)
        context.log('info', `following ${handle.type} session ${event.ref.nativeSessionId} (${event.reason})`)
      })().catch(error => context.log('warn', `following ${event.ref.nativeSessionId} failed: ${message(error)}`))
      return
    }
  }
}
