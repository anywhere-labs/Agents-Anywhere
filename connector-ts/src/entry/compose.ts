import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { CommandInbox, runtimeControlCommands, type CommandHandler } from '../application/inbound/index.js'
import {
  ConversationService,
  NativeHistory,
  PreparationService,
  RuntimeRegistry,
  RuntimeScans,
  announceRuntimes,
  applyDesiredRuntimes,
  capabilitySet,
  legacyInstanceSpec,
  nativeSessionId,
  runtimeEvent,
  type RuntimeInstanceSpec,
} from '../application/index.js'
import type { LiveEvents, Log, RuntimeHandle, RuntimeHandleEvent, RuntimeProvider } from '../application/ports/index.js'
import { legacyDataDir, type ConnectorRuntime, type ConnectorSettings, type RuntimeFactory } from '../host/index.js'
import { ControlPlane, DeviceLink, blobLookup, deviceAttachmentFetcher, deviceTransferUploader, readSystemProxySettings, resolveEgress, type Egress, type LinkLogger } from '../link/index.js'
import { openStoreWorker, inProcessStore, openSqliteStore, type RemoteStore } from '../store/index.js'
import { DeviceReaders, DeviceTunnelApi, MemoryChangeFeed, OutboxSignal, plainSealer, type RuntimeFacts, type SessionFacts } from '../sync/index.js'
import { AttachmentCache, FileOps, RootPolicy, ShellOps, Terminals, nodePtySpawner, rootsFromEnv, workspaceMethods } from '../workspace/index.js'
import { importLegacyV2 } from './legacy-import.js'
import { builtinProviders } from './runtimes.js'
import { DeviceTrust, openSealedUpload, type DeviceTrustOptions } from './trust.js'

export type { Log }

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
  /**
   * Device Trust (E2EE): `false` turns it off (the device then never serves an encrypted mode); the object
   * overrides the secrets' vault (tests use `noVault()`), the local confirmation and the device label.
   */
  readonly trust?: false | Partial<Pick<DeviceTrustOptions, 'vault' | 'confirmation' | 'deviceLabel'>>
  /** Workspace roots (default `AGENT_CONNECTOR_WORKSPACE_ROOTS`, else the home directory). */
  readonly workspaceRoots?: readonly string[] | 'any'
  /** Terminals need node-pty; `false` leaves them out (tests, hosts without it). */
  readonly terminals?: boolean
  /** The store in a worker thread (production) or in this thread (tests, tools). */
  readonly storeMode?: 'worker' | 'in-process'
  /** v2's data directory to import once (default `legacyDataDir()`); `false` skips the import. */
  readonly legacyDataDir?: string | false
  /** Told when a link exists (the host wires port events and other live sources to `link.attach`). */
  readonly onLink?: (link: DeviceLink) => void
}

const EGRESS_REFRESH_MS = 60_000

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
export function connectorRuntime(options: ComposeOptions, track?: { store(store: RemoteStore | null): void; trust?(trust: DeviceTrust | null): void }): RuntimeFactory {
  return (settings, hooks): ConnectorRuntime => ({
    async run(outer) {
      // Stops on the host's signal, or when the store worker dies: without its store the Connector can neither
      // acknowledge commands nor drain the outbox, so `run` fails and the host shows (and may restart) it.
      const stop = new AbortController()
      const signal = stop.signal
      const onOuterAbort = (): void => stop.abort()
      if (outer.aborted) stop.abort()
      else outer.addEventListener('abort', onOuterAbort, { once: true })
      let storeFailure: Error | null = null
      const storeOptions = { dataDir: join(options.dataDir, 'store'), durability: 'normal' as const, now: clock.nowIso }
      const store = options.storeMode === 'in-process'
        ? inProcessStore(openSqliteStore(storeOptions))
        : await openStoreWorker(storeOptions, {
          onUnavailable: error => {
            storeFailure = error
            options.log('error', `${error.message}; stopping the Connector`)
            stop.abort()
          },
        })
      track?.store(store)
      let link: DeviceLink | null = null
      const sessionFacts = new SessionFactsHub()
      const outboxSignal = new OutboxSignal()
      // Session facts also go to the session's channel subscribers; attach drops them in encrypted mode.
      const live: LiveEvents = {
        emit: (method, payload) => {
          if (typeof payload.sessionId === 'string') sessionFacts.publish(payload.sessionId, method, payload)
          link?.attach.emit(method, payload)
          // `session.status` follows a commit that queued `session.summary`; a commit without timeline changes (a
          // turn that ended) wakes no feed subscriber, so the outbox is told here.
          if (method === 'runtime.status' && (payload.status as { event?: unknown } | undefined)?.event === 'session.status') outboxSignal.poke()
        },
      }
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
      let service: ConversationService | null = null
      let preparations: PreparationService | null = null
      const history = new NativeHistory({
        store,
        feed,
        runtimes,
        clock,
        sessionIdFor: (_handle, runtimeId, summary) => nativeSessionId(settings.connectorId, runtimes.spec(runtimeId) ?? legacyInstanceSpec(runtimeId), summary),
        isBound: sessionId => service?.isBound(sessionId) ?? false,
        onError: (sessionId, error) => log('warn', `native history${sessionId === null ? '' : ` of ${sessionId}`}: ${(error as Error)?.message ?? String(error)}`),
      })
      const scans = new RuntimeScans(history, ids, log)
      const policy = new RootPolicy({ roots: options.workspaceRoots ?? rootsFromEnv() })
      const files = new FileOps(policy)
      const terminals = await openTerminals(policy, options.terminals !== false, log)
      let trust: DeviceTrust | null = null
      try {
        const egress = await egressFor(settings, signal, options.log)
        const handshake = new ControlPlane({
          serverUrl: settings.serverUrl,
          credential: () => ({ deviceId: settings.connectorId, token: settings.connectorToken }),
          egress,
          connectorVersion: options.connectorVersion,
          os: process.platform,
        })
        const attachments = new AttachmentCache(join(options.dataDir, 'attachments'), deviceAttachmentFetcher(settings.serverUrl, handshake, egress), openSealedUpload, {
          // The file is on disk: the Server may drop its staged copy (06-protocols.md §5).
          onStored: async ({ sessionId, fileId, sha256 }) => {
            try {
              await store.outbox.append('attachment.consumed', sessionId, { fileId, sha256 }, clock.nowIso())
              outboxSignal.poke()
            } catch (error) {
              log('warn', `attachment.consumed for ${fileId}: ${message(error)}`)
            }
          },
        })
        const conversation = new ConversationService({
          store,
          feed,
          live,
          runtimes,
          clock,
          ids,
          history,
          attachments: async (sessionId, ref) => {
            const local = await attachments.resolve(sessionId, ref)
            return { kind: 'file', path: local.path, mimeType: local.mediaType, name: local.name }
          },
        })
        service = conversation
        onRuntimeEvent = (spec, handle, event) => runtimeEvent({ spec, handle, event, live, scans, conversations: conversation, store, connectorId: settings.connectorId, log })
        const facts: RuntimeFacts = {
          sessionCapabilities: async sessionId => {
            const session = await store.sessions.get(sessionId)
            if (session === null) return null
            const bound = conversation.boundSession(sessionId)
            if (bound !== null) return capabilitySet(bound.capabilities, { runtime: session.runtimeType, sessionId })
            const handle = await runtimes.started(session.runtimeId)
            return handle === null || handle === undefined ? null : capabilitySet(handle.capabilities(), { runtime: session.runtimeType, sessionId: null })
          },
          selections: sessionId => history.nativeSelections(sessionId),
          catalogs: async sessionId => {
            const session = await store.sessions.get(sessionId)
            const handle = session === null ? null : await runtimes.started(session.runtimeId)
            return handle === null || handle === undefined ? null : ((await handle.catalogs(sessionId).catch(() => null)) as Record<string, unknown> | null)
          },
        }
        if (options.legacyDataDir !== false) {
          await importLegacyV2(store, {
            legacyRoot: options.legacyDataDir ?? legacyDataDir(),
            connectorId: settings.connectorId,
            runtimeTypeOf: runtimeId => (runtimes.spec(runtimeId) ?? legacyInstanceSpec(runtimeId)).runtimeType,
            log,
            now: clock.nowIso,
          }).catch(error => log('warn', `v2 import failed: ${message(error)}`))
        }
        // Workspace preparation: Agent sessions opened for the new-session page, consumed by the first message.
        const prepared = new PreparationService({
          store,
          runtimes,
          clock,
          ids,
          conversation,
          directoryExists: async cwd => isAbsolute(cwd) && (await stat(cwd).catch(() => null))?.isDirectory() === true,
          onError: (preparationId, error) => log('warn', `workspace preparation ${preparationId}: ${message(error)}`),
        })
        preparations = prepared
        await prepared.recover()
        await conversation.recover()
        prepared.start()
        // Runtime Control 3.0 (runtime.apply, channel.switch, device.settings.apply); a host's own handlers win.
        const control = runtimeControlCommands({ registry: runtimes, deviceSettings: settings => hooks.deviceSettings(settings) })
        const inbox = new CommandInbox(store, clock, conversation, { ...control, ...(options.commands ?? {}) }, prepared)
        const readers = new DeviceReaders(store, clock.nowIso, facts, history, prepared)
        const watch = { store, feed, now: clock.nowIso }
        const workspace = workspaceMethods(files, new ShellOps(policy), terminals ?? undefined)
        const tunnel = new DeviceTunnelApi({
          deviceId: settings.connectorId,
          store,
          readers,
          watch,
          inbox,
          clock,
          workspace,
          ...(terminals !== null ? { terminals } : {}),
          facts: sessionFacts,
          newId: ids.newId,
        })
        if (options.trust !== false) {
          trust = await DeviceTrust.open({
            dataDir: options.dataDir,
            deviceId: settings.connectorId,
            serverUrl: settings.serverUrl,
            log,
            api: tunnel,
            republishSummaries: () => store.sessions.republishSummaries(),
            outbox: store.outbox,
            ...(options.trust ?? {}),
          })
          track?.trust?.(trust)
        }
        const deviceTrust = trust
        const logger: LinkLogger = {
          debug: text => options.log('debug', text),
          info: text => options.log('info', text),
          warn: text => options.log('warn', text),
          error: text => options.log('error', text),
        }
        link = new DeviceLink({
          deviceId: settings.connectorId,
          host: options.host,
          handshake,
          store,
          inbox,
          outboxSignal,
          services: {
            outbox: { outbox: store.outbox, sealer: deviceTrust?.sealer() ?? plainSealer, signal: outboxSignal },
            watch,
            readers,
            blobs: {
              find: blobLookup({ blobs: store.blobs, attachment: (sessionId, fileId) => attachments.find(sessionId, fileId) }),
              upload: deviceTransferUploader(settings.serverUrl, handshake, egress),
            },
            // Normal mode: the same workspace handlers as the secure channel, as `aa.device.v1.Workspace`.
            workspace: {
              methods: workspace,
              ...(terminals !== null ? { terminals } : {}),
              preparedFile: params => files.preparedFile(params),
              upload: deviceTransferUploader(settings.serverUrl, handshake, egress),
              onUploadError: (transferId, error) => log('warn', `file download ${transferId} failed: ${message(error)}`),
            },
            ...(deviceTrust !== null ? { secure: deviceTrust.secure } : {}),
            // Normal mode: the client API the secure channel answers, as `aa.device.v1.Client`.
            client: tunnel,
          },
          egress,
          logger,
          ...(deviceTrust !== null ? { localE2eeMode: () => deviceTrust.localMode() } : {}),
          onWelcome: async welcome => {
            await deviceTrust?.declareServerMode(welcome.e2eeMode)
            const settingsFromServer = welcome.desired?.deviceSettings
            if (settingsFromServer !== undefined && settingsFromServer !== null) hooks.deviceSettings(settingsFromServer)
            await applyDesiredRuntimes(runtimes, welcome.desired, log)
          },
          onState: state => {
            options.log('info', `device link ${state}`)
            if (state === 'online') void announceRuntimes(runtimes, live, log, options.scanOnStart !== false ? spec => void scans.now(spec.runtimeId) : undefined)
          },
        })
        options.onLink?.(link)
        await link.run(signal)
        if (storeFailure !== null) throw storeFailure
      } catch (error) {
        // A use case that failed because the store went away reports the store, not its own symptom.
        throw storeFailure ?? error
      } finally {
        outer.removeEventListener('abort', onOuterAbort)
        scans.close()
        if (trust !== null) track?.trust?.(null)
        await trust?.close().catch(() => undefined)
        await preparations?.close().catch(() => undefined)
        await service?.close().catch(() => undefined)
        terminals?.shutdown()
        await runtimes.close().catch(() => undefined)
        track?.store(null)
        await store.close().catch(() => undefined)
      }
    },
  })
}

/** Live session facts by session, for secure channel subscribers (`SessionFacts`). */
class SessionFactsHub implements SessionFacts {
  private readonly listeners = new Map<string, Set<(method: string, payload: Record<string, unknown>) => void>>()

  public subscribe(sessionId: string, listener: (method: string, payload: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0 && this.listeners.get(sessionId) === set) this.listeners.delete(sessionId)
    }
  }

  public publish(sessionId: string, method: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners.get(sessionId) ?? []) listener(method, payload)
  }
}

/** Terminals when node-pty loads; a device without it still serves files and sessions. */
async function openTerminals(policy: RootPolicy, wanted: boolean, log: Log): Promise<Terminals | null> {
  if (!wanted) return null
  try {
    return new Terminals({ policy, spawn: await nodePtySpawner() })
  } catch (error) {
    log('warn', `terminals are unavailable: ${message(error)}`)
    return null
  }
}

function message(error: unknown): string {
  return (error as Error)?.message ?? String(error)
}
