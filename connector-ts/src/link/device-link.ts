// ported from effi-crew cloud/agentd/src/mesh.ts @30f8334 (connection loop)
// ported from effi-crew cloud/agentd/src/util.ts @30f8334 (Backoff)
//
// The device's MeshCall link (06-protocols.md §2, contracts/device-meshcall/1.0): say hello over HTTPS for a
// Router token and a connection generation, register aa.device.v1.* as targeted services (instance_id = deviceId),
// call ready so a Server worker holds Link/attach and Link/outbox, and keep it that way: re-register after the
// Router connection drops, say hello again when the token is refused, retry `duplicate instance_id` at a short
// steady interval, call ready again when the holder goes away. The token comes from `POST /api/v3/device/hello`;
// the token is not refreshed while registered, because the Router keeps
// connections past the token's expiry and a new hello would replace the connection generation; the WebSocket goes
// through `RouterBridge` so proxies and the system CAs apply.

import { Mesh, Router, type RpcLogger, type RunningServer } from 'meshcall'

import { commandRoute, type CommandInbox } from '../application/inbound/index.js'
import { rpcLogger } from '../mesh/index.js'
import type { ConversationStore } from '../application/ports/index.js'
import type { LinkWelcome } from '../generated/device-meshcall/v1_0/link-welcome.js'
import type { OutboxSignal } from '../sync/index.js'
import { AttachHub, type AttachEnd } from './attach.js'
import { RouterBridge } from './bridge.js'
import { HttpError } from './http.js'
import { MESH_MAX_FRAME_BYTES, meshGrant, type ControlPlane, type MeshGrant } from './control-plane.js'
import { CONTENT_PRINCIPAL_PREFIX, CONTENT_SERVICE, CONTROL_PRINCIPAL, CONTROL_SERVICES, type DeviceContent } from './content.js'
import type { Egress } from './egress.js'
import { DEFAULT_REGISTRATION, DeviceServices, type DeviceServicesDeps, type E2eeMode, type Registration } from './services.js'

export interface LinkLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const SILENT: LinkLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

/** What the link needs from the Server's handshake endpoints (`ControlPlane`). */
export interface Handshake {
  hello(body: Parameters<ControlPlane['hello']>[0], signal?: AbortSignal): Promise<LinkWelcome>
  ready(connectionId: string, signal?: AbortSignal): Promise<void>
}

export type LinkState = 'stopped' | 'connecting' | 'registered' | 'online'

/** Outbox appends that no commit announces (rare) are found by this poll. */
export const OUTBOX_FALLBACK_POLL_MS = 15_000

export interface DeviceLinkTiming {
  /** meshcall's pong timeout; 30 s instead of its 10 s, so one late pong behind a VPN does not drop the link. */
  readonly pongTimeoutMs?: number
  readonly backoffBaseMs?: number
  readonly backoffMaxMs?: number
  readonly duplicateRetryMs?: number
  readonly duplicatePatienceMs?: number
  readonly monitorMs?: number
  /** `READY_RETRY_MAX_SECONDS`. */
  readonly readyRetryMaxMs?: number
  /** How long after a successful `ready` the attach stream must be open. */
  readonly attachWaitMs?: number
  readonly heartbeatMs?: number
  readonly stallMs?: number
  /** Say hello again before registering when the token expires within this. */
  readonly tokenMarginMs?: number
}

export interface DeviceLinkOptions {
  readonly deviceId: string
  readonly host: 'desktop' | 'cli' | 'dsh-plugin'
  readonly capabilities?: readonly string[]
  readonly handshake: Handshake
  readonly content?: DeviceContent
  readonly store: Pick<ConversationStore, 'sessions'>
  readonly inbox: CommandInbox
  readonly outboxSignal: OutboxSignal
  /** Everything the services need besides the generation check and the attach hub, which the link owns. */
  readonly services: Omit<DeviceServicesDeps, 'connectionId' | 'encryptedControl' | 'attach' | 'inbox' | 'onCommand'>
  readonly egress: () => Egress
  /** Per-mode registration; pass the generated `REGISTERED_SERVICES` of `e2ee-registration.ts` once it is in. */
  readonly registration?: Readonly<Record<E2eeMode, Registration>>
  /** This device's own policy (F's domain/trust); the stricter of it and `LinkWelcome.e2eeMode` applies. */
  readonly localE2eeMode?: () => E2eeMode
  /** `auto`: through the bridge for `wss://` or a proxy, straight for a direct `ws://`. */
  readonly bridge?: 'auto' | 'always' | 'never'
  readonly logger?: LinkLogger
  /** Desired runtimes, device settings and channel switches of a fresh welcome (applied by the host). */
  readonly onWelcome?: (welcome: LinkWelcome) => void | Promise<void>
  readonly onState?: (state: LinkState) => void
  readonly timing?: DeviceLinkTiming
}

/** Exponential backoff with ±25 % jitter. */
export class Backoff {
  private attempt = 0
  public constructor(private readonly baseMs = 1000, private readonly maxMs = 30_000) {}
  public next(): number {
    const delay = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt)
    this.attempt = Math.min(this.attempt + 1, 16)
    return Math.round(delay * (0.75 + Math.random() * 0.5))
  }
  public reset(): void {
    this.attempt = 0
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted === true) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

export function isAuthFailure(error: unknown): boolean {
  const e = error as { code?: string; message?: string }
  return e?.code === 'unauthenticated' || /\b401\b|4401|unauthenticated/iu.test(String(e?.message ?? ''))
}

/**
 * The Router still has our previous connection under this instance_id (`duplicate instance_id`, closed with 1008)
 * until its idle timeout drops it, which is the normal state for a few seconds after every unclean drop: retry at a
 * steady short interval instead of backing off past that timeout.
 */
export function isDuplicateInstance(error: unknown): boolean {
  return /duplicate instance_id/iu.test(String((error as { message?: string })?.message ?? ''))
}

/** The Server no longer knows this generation (or this device): only a new hello helps. */
function needsHello(error: unknown): boolean {
  return error instanceof HttpError && error.code !== 'credential_rejected' && (error.status === 401 || (error.status === 409 && error.code === 'connection_replaced'))
}

function linkRpcLogger(log: LinkLogger): RpcLogger {
  return rpcLogger((level, text) => log[level](text))
}

export class DeviceLink {
  public readonly attach: AttachHub
  private readonly services: DeviceServices
  private readonly log: LinkLogger
  private bridgeInstance: RouterBridge | null = null
  private grant: MeshGrant | null = null
  private generation: string | null = null
  private mode: E2eeMode = 'off'
  private stateValue: LinkState = 'stopped'
  private readyWanted = false
  private readyImmediate = false
  private wakeReady: (() => void) | null = null
  private sessionEnd: AbortController | null = null
  private helloNeeded = false
  public helloCount = 0

  public constructor(private readonly options: DeviceLinkOptions) {
    this.log = options.logger ?? SILENT
    this.attach = new AttachHub({
      ...(options.timing?.heartbeatMs !== undefined ? { heartbeatMs: options.timing.heartbeatMs } : {}),
      ...(options.timing?.stallMs !== undefined ? { stallMs: options.timing.stallMs } : {}),
      onOpened: connectionId => this.attachOpened(connectionId),
      onEnded: (connectionId, reason) => this.attachEnded(connectionId, reason),
    })
    this.services = new DeviceServices({
      ...options.services,
      // Commits wake the outbox stream through the ChangeFeed; polling is only the fallback.
      outbox: { pollMs: OUTBOX_FALLBACK_POLL_MS, ...options.services.outbox },
      connectionId: () => this.generation,
      encryptedControl: () => this.mode === 'required' && options.content !== undefined &&
        this.grant?.services?.includes(CONTENT_SERVICE) === true,
      attach: this.attach,
      inbox: options.inbox,
      onCommand: () => options.outboxSignal.poke(),
    })
  }

  /** The current connection generation (`LinkWelcome.connectionId`), null before the first hello. */
  public get connectionId(): string | null {
    return this.generation
  }

  public get state(): LinkState {
    return this.stateValue
  }

  public get e2eeMode(): E2eeMode {
    return this.mode
  }

  public inflight(kind: Parameters<DeviceServices['inflight']>[0]): number {
    return this.services.inflight(kind)
  }

  private setState(state: LinkState): void {
    if (state === this.stateValue) return
    this.stateValue = state
    this.options.onState?.(state)
  }

  private timing<K extends keyof DeviceLinkTiming>(key: K, fallback: number): number {
    return (this.options.timing?.[key] as number | undefined) ?? fallback
  }

  private attachOpened(connectionId: string): void {
    if (connectionId !== this.generation) return
    this.readyWanted = false
    this.setState('online')
  }

  private attachEnded(connectionId: string, reason: AttachEnd): void {
    if (connectionId !== this.generation || this.sessionEnd === null) return
    if (this.stateValue === 'online') this.setState('registered')
    if (reason === 'closed') return
    if (reason === 'stalled') {
      // The holder stopped granting credit: end the outbox too and let another worker take over.
      this.attach.end('stalled')
      this.services.endOutbox()
    }
    this.log.info(`Link/attach ${reason}; calling ready again`)
    this.requestReady(false)
  }

  private requestReady(immediate: boolean): void {
    this.readyWanted = true
    this.readyImmediate = immediate
    const wake = this.wakeReady
    this.wakeReady = null
    wake?.()
  }

  private routerTarget(grant: MeshGrant): { endpoint: string; viaBridge: boolean } {
    const url = new URL(grant.routerUrl)
    const mode = this.options.bridge ?? 'auto'
    const direct = url.protocol === 'ws:' && this.options.egress().proxy === null
    if (mode === 'never' || (mode === 'auto' && direct)) return { endpoint: grant.routerUrl, viaBridge: false }
    return { endpoint: '', viaBridge: true }
  }

  private async bridge(): Promise<RouterBridge> {
    if (this.bridgeInstance === null) {
      this.bridgeInstance = new RouterBridge(() => new URL(this.grant?.routerUrl ?? 'ws://invalid/'), this.options.egress, error => this.log.debug(`router bridge: ${error.message}`))
    }
    await this.bridgeInstance.start()
    return this.bridgeInstance
  }

  private async hello(signal: AbortSignal): Promise<LinkWelcome> {
    const heads = await this.options.store.sessions.heads()
    this.helloCount++
    const welcome = await this.options.handshake.hello({
      deviceId: this.options.deviceId,
      contractVersions: ['1.0'],
      host: this.options.host,
      ...(this.options.capabilities !== undefined ? { capabilities: [...this.options.capabilities] } : {}),
      sessionsHead: heads,
      ...(this.options.content === undefined ? {} : { meshE2eeKey: this.options.content.publicKey }),
    }, signal)
    // Clocks first: no watch stream of this generation may hand out a sequence number below the Server's floor.
    const jumped = await this.options.store.sessions.applySeqFloors(welcome.seqFloors ?? {})
    if (jumped.length > 0) {
      this.log.info(`session clocks moved past the Server's floors: ${jumped.length}`)
      this.options.outboxSignal.poke()
    }
    this.grant = meshGrant(welcome)
    this.generation = welcome.connectionId
    this.mode = welcome.e2eeMode === 'required' || this.options.localE2eeMode?.() === 'required' ? 'required' : 'off'
    this.attach.setMode(this.mode)
    try {
      await this.options.onWelcome?.(welcome)
    } catch (error) {
      this.log.warn(`applying the desired state failed: ${(error as Error).message}`)
    }
    return welcome
  }

  /** Commands the Server still waits on: run once per welcome; their results go out through the outbox. */
  private replayPending(welcome: LinkWelcome): void {
    for (const pending of welcome.pendingCommands ?? []) {
      const call = { commandId: pending.commandId, deadline: pending.deadline, ...(pending.inputDigest !== undefined ? { inputDigest: pending.inputDigest } : {}), ...(pending.p !== undefined ? { p: pending.p } : {}) }
      this.options.inbox.handle(commandRoute(pending.m), call).then(
        () => this.options.outboxSignal.poke(),
        (error: Error) => this.log.warn(`pending command ${pending.commandId} (${pending.m}) failed: ${error.message}`),
      )
    }
  }

  /**
   * Calls `ready` whenever asked (registration, attach cancelled or stalled), backing off from a random 0–1 s up
   * to `READY_RETRY_MAX_SECONDS`; 401 or a replaced generation end the registration so the loop says hello again.
   */
  private async readyLoop(signal: AbortSignal): Promise<void> {
    let attempt = 0
    const maxMs = this.timing('readyRetryMaxMs', 30_000)
    while (!signal.aborted) {
      if (!this.readyWanted) {
        attempt = 0
        await new Promise<void>(resolve => {
          const done = (): void => {
            signal.removeEventListener('abort', done)
            this.wakeReady = null
            resolve()
          }
          this.wakeReady = done
          signal.addEventListener('abort', done, { once: true })
        })
        continue
      }
      const delay = this.readyImmediate && attempt === 0 ? 0 : attempt === 0 ? Math.random() * 1000 : Math.min(maxMs, 1000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5)
      this.readyImmediate = false
      if (delay > 0) await sleep(delay, signal)
      if (signal.aborted) return
      if (this.attach.isOpen) {
        this.readyWanted = false
        continue
      }
      const generation = this.generation
      if (generation === null) return
      try {
        await this.options.handshake.ready(generation, signal)
        const deadline = Date.now() + this.timing('attachWaitMs', 10_000)
        while (!this.attach.isOpen && Date.now() < deadline && !signal.aborted) await sleep(50, signal)
        if (this.attach.isOpen) {
          this.readyWanted = false
          attempt = 0
          continue
        }
        this.log.warn('ready succeeded but no Link/attach arrived; retrying')
      } catch (error) {
        if (signal.aborted) return
        if (needsHello(error)) {
          this.log.info(`ready refused (${(error as Error).message}); saying hello again`)
          this.helloNeeded = true
          this.sessionEnd?.abort()
          return
        }
        this.log.warn(`ready failed: ${(error as Error).message}`)
      }
      attempt++
    }
  }

  /** Runs until `signal` aborts; rejects only when the Server refuses the device credential (`credential_rejected`). */
  public async run(signal: AbortSignal): Promise<void> {
    const backoff = new Backoff(this.timing('backoffBaseMs', 1000), this.timing('backoffMaxMs', 30_000))
    const registration = this.options.registration ?? DEFAULT_REGISTRATION
    let welcome: LinkWelcome | null = null
    let lastProblem = ''
    let duplicateSince = 0
    const problem = (text: string): void => {
      // A repeated failure is logged once, then retried quietly.
      if (text !== lastProblem) this.log.warn(`${text}; retrying`)
      else this.log.debug(text)
      lastProblem = text
    }
    this.setState('connecting')
    const unsubscribe = this.options.services.watch.feed.subscribe('*', () => this.options.outboxSignal.poke())
    try {
      while (!signal.aborted) {
        let fresh = false
        const grant = this.grant
        if (grant === null || this.helloNeeded || (grant.expiresAt !== null && grant.expiresAt - Date.now() < this.timing('tokenMarginMs', 5_000))) {
          try {
            welcome = await this.hello(signal)
            this.helloNeeded = false
            fresh = true
          } catch (error) {
            if (signal.aborted) break
            // Pairing again is the only cure; the host shows it as an expired credential.
            if ((error as { code?: unknown }).code === 'credential_rejected') throw error
            problem(`hello failed: ${(error as Error).message}`)
            await sleep(backoff.next(), signal)
            continue
          }
        }
        const current = this.grant!
        const { [CONTENT_SERVICE]: contentMethods, ...managementRegistration } = registration[this.mode] as Readonly<Record<string, readonly string[]>>
        const built = this.services.build(managementRegistration, current.services, this.mode)
        const content = this.options.content
        const mountsContent = this.mode === 'required' && contentMethods && current.services?.includes(CONTENT_SERVICE)
        if (built.skipped.length > 0) this.log.warn(`not registering ${built.skipped.join(', ')} (not in the Router token, or no handler on this device)`)
        const target = this.routerTarget(current)
        let mesh: Mesh
        try {
          const endpoint = target.viaBridge ? (await this.bridge()).endpoint : target.endpoint
          mesh = new Mesh(new Router(endpoint), {
            token: current.token,
            reconnect: { enabled: false },
            pingTimeoutMs: this.timing('pongTimeoutMs', 30_000),
            maxFrameSize: current.maxFrameBytes ?? MESH_MAX_FRAME_BYTES,
            logger: linkRpcLogger(this.log),
          })
          if (mountsContent && content) {
            const management = built.services.filter((_, index) => CONTROL_SERVICES.has(built.names[index] ?? ''))
            const other = built.services.filter((_, index) => !CONTROL_SERVICES.has(built.names[index] ?? ''))
            if (other.length > 0) {
              mesh.mount(...other, { instanceId: current.instanceId, accessLog: false, logger: linkRpcLogger(this.log) })
            }
            mesh.mount(...management, {
              instanceId: current.instanceId,
              accessLog: false,
              logger: linkRpcLogger(this.log),
              acceptTunnels: offer => offer.principal === CONTROL_PRINCIPAL,
              requireE2E: true,
              e2ePrivateKey: content.privateKey,
            })
            mesh.mount(content.service, {
              instanceId: current.instanceId,
              accessLog: false,
              logger: linkRpcLogger(this.log),
              acceptTunnels: offer => offer.principal.startsWith(CONTENT_PRINCIPAL_PREFIX),
              requireE2E: true,
              e2ePrivateKey: content.privateKey,
            })
          } else {
            mesh.mount(...built.services, { instanceId: current.instanceId, accessLog: false, logger: linkRpcLogger(this.log) })
          }
        } catch (error) {
          problem(`cannot prepare the MeshCall link: ${(error as Error).message}`)
          await sleep(backoff.next(), signal)
          continue
        }
        let running: RunningServer
        try {
          running = await mesh.startServing()
        } catch (error) {
          await mesh.close().catch(() => undefined)
          if (signal.aborted) break
          if (isAuthFailure(error)) {
            problem(`the Router refused the registration (${(error as Error).message}); getting a new token`)
            this.helloNeeded = true
            if (!fresh) {
              // The Router is up and only forgot an older token (it keeps none across a restart): say hello now
              // rather than wait out the backoff built while it was down. A fresh token refused too backs off.
              backoff.reset()
              await sleep(250, signal)
              continue
            }
          } else if (isDuplicateInstance(error)) {
            if (duplicateSince === 0) duplicateSince = Date.now()
            if (Date.now() - duplicateSince < this.timing('duplicatePatienceMs', 90_000)) {
              problem('the Router still holds our previous connection (duplicate instance_id)')
              backoff.reset()
              await sleep(this.timing('duplicateRetryMs', 1000), signal)
              continue
            }
            problem(`the Router keeps saying duplicate instance_id: another Connector may be using device ${current.instanceId}`)
          } else {
            problem(`cannot reach the Router ${current.routerUrl}: ${(error as Error).message}`)
          }
          await sleep(backoff.next(), signal)
          continue
        }
        backoff.reset()
        duplicateSince = 0
        lastProblem = ''
        this.setState('registered')
        const mounted = mountsContent && content ? [...built.names, CONTENT_SERVICE] : built.names
        this.log.info(`registered ${mounted.map(name => name.replace(/^aa\.device\.v1\./u, '')).join(', ')} at ${current.routerUrl} as ${current.instanceId}` +
          `${target.viaBridge ? ' (via bridge)' : ''}; generation ${this.generation}; e2ee ${this.mode}`)

        const session = new AbortController()
        this.sessionEnd = session
        const sessionSignal = AbortSignal.any([signal, session.signal])
        if (fresh && welcome !== null) this.replayPending(welcome)
        this.requestReady(true)
        const readying = this.readyLoop(sessionSignal)
        let reason: 'lost' | 'hello' | 'stop' = 'stop'
        while (!sessionSignal.aborted) {
          if (!running.server.isRunning || !running.server.routerConnected) {
            reason = 'lost'
            break
          }
          await sleep(this.timing('monitorMs', 1000), sessionSignal)
        }
        if (reason !== 'lost' && this.helloNeeded) reason = 'hello'
        session.abort()
        this.sessionEnd = null
        this.attach.end('closed')
        this.services.endOutbox()
        await readying.catch(() => undefined)
        await running.close({ drain: false }).catch(() => undefined)
        await mesh.close().catch(() => undefined)
        if (signal.aborted) break
        this.setState('connecting')
        if (reason === 'lost') {
          this.log.warn('Router connection lost; registering again')
          await sleep(500, signal)
        } else if (reason === 'hello') {
          this.log.info('registering again under a new connection generation')
        }
      }
    } finally {
      unsubscribe()
      this.attach.close()
      await this.bridgeInstance?.close().catch(() => undefined)
      this.bridgeInstance = null
      this.setState('stopped')
    }
  }
}
