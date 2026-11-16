// ported from the v2 Connector's connector/control.py (Agents Anywhere 2.x): the lifecycle behind
// aa.local.v2.Control (local-machine 2.0), plus the v3 handover between Connector versions (04-connector.md §9.1).
import { ConfigError, ConfigFile, settingsFrom, type ConnectorSettings } from './config.js'
import { ConnectorAlreadyRunning, compareVersions, type ClaimResult, type OwnerView, type RuntimeLease } from './lease.js'
import { pollPairing, resolvePairServerUrl, startPairing, type FetchJson } from './pairing.js'

export type ConnectorStatus = 'running' | 'expired credential' | 'error' | 'stopped'

export interface ConnectorState {
  status: ConnectorStatus
  running: boolean
  pairing: boolean
  authFailed: boolean
  lastError: string | null
  configPath: string
  runtimePath: string
  hasConfig: boolean
  /** Server-chosen device settings (docs/api/device-settings.md); null until this process received them. */
  deviceSettings: Record<string, unknown> | null
}

export type PairingStatus = {
  status: 'starting' | 'waiting' | 'claimed' | 'expired' | 'consumed' | 'cancelled' | 'error'
  serverUrl?: string | null
  pairingId?: string | null
  code?: string | null
  config?: ConnectorSettings | null
  error?: string | null
}

/** What the Connector runs once configured (the composition root builds it: store, use cases, link). */
export interface ConnectorRuntime {
  /** Resolves when `signal` aborts and everything is closed; rejects on a fatal error. */
  run(signal: AbortSignal): Promise<void>
}

export interface RuntimeHooks {
  /** The Server handed over device settings (`LinkWelcome.desired.deviceSettings`). */
  deviceSettings(settings: Record<string, unknown>): void
}

export type RuntimeFactory = (settings: ConnectorSettings, hooks: RuntimeHooks) => ConnectorRuntime

/** A runtime error meaning the stored credential no longer works (the Server refused it). */
export function isCredentialFailure(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'credential_rejected'
}

export class ConnectorBusy extends Error {
  public readonly code = 'connector_busy'
  public constructor() {
    super('The Connector is changing state; check its state before issuing another command')
    this.name = 'ConnectorBusy'
  }
}

export class ConnectorClosing extends Error {
  public readonly code = 'connector_error'
  public constructor() {
    super('The Connector is shutting down')
    this.name = 'ConnectorClosing'
  }
}

/** Asks the Connector that owns the machine to hand over; true once it accepted (it then releases the lease). */
export type HandoverRequester = (owner: OwnerView) => Promise<boolean>

export interface HandoverPolicy {
  /** This Connector's version. */
  readonly version: string
  /** Turns running right now; a handover waits for zero (up to `maxWaitMs`). */
  readonly activeTurns: () => Promise<number>
  readonly maxWaitMs?: number
  /** Asks an older owner to hand over (`request_handover`); absent = report the conflict instead. */
  readonly request?: HandoverRequester
  /** After this Connector handed over: the host process should exit. */
  readonly onHandedOver?: () => void
}

export interface ControllerOptions {
  readonly config: ConfigFile
  readonly lease: RuntimeLease
  readonly runtimePath: string
  readonly runtime: RuntimeFactory
  readonly fetchJson: FetchJson
  readonly notify?: (kind: 'state' | 'pairing', payload: ConnectorState | PairingStatus) => void
  readonly handover?: HandoverPolicy
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
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

interface RunningRuntime {
  readonly abort: AbortController
  done: Promise<void>
  stopping: boolean
}

/**
 * The Connector process's lifecycle (local-machine 2.0): `start`, `stop`, `restart` and `saveConfig` share one
 * lifecycle lock and answer `connector_busy` while a change is in flight (no queueing, no merging); queries and
 * `cancelPairing` stay available. A pairing's address resolution and polling do not hold the lock; saving its
 * credentials and starting do, and a cancelled pairing never commits.
 */
export class ConnectorController {
  private runtime: RunningRuntime | null = null
  private pairingAbort: AbortController | null = null
  private pairingGeneration = 0
  private changing = false
  private closing = false
  private lastError: string | null = null
  private authFailed = false
  private deviceSettings: Record<string, unknown> | null = null
  private handingOver = false

  public constructor(private readonly options: ControllerOptions) {}

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return (this.options.sleep ?? defaultSleep)(ms, signal)
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.options.log?.(level, message)
  }

  public getState(): ConnectorState {
    return {
      status: this.status(),
      running: this.runtime !== null,
      pairing: this.pairingAbort !== null,
      authFailed: this.authFailed,
      lastError: this.lastError,
      configPath: this.options.config.path,
      runtimePath: this.options.runtimePath,
      hasConfig: this.options.config.exists,
      deviceSettings: this.deviceSettings === null ? null : { ...this.deviceSettings },
    }
  }

  public getPaths(): { configPath: string; configDir: string; runtimePath: string } {
    const configPath = this.options.config.path
    return { configPath, configDir: configPath.replace(/[\\/][^\\/]*$/u, ''), runtimePath: this.options.runtimePath }
  }

  private status(): ConnectorStatus {
    if (this.runtime !== null) return 'running'
    if (this.authFailed) return 'expired credential'
    if (this.lastError !== null) return 'error'
    return 'stopped'
  }

  private emitState(): void {
    this.options.notify?.('state', this.getState())
  }

  private emitPairing(payload: PairingStatus): void {
    this.options.notify?.('pairing', payload)
  }

  private ensureOpen(): void {
    if (this.closing) throw new ConnectorClosing()
  }

  /** The lifecycle lock: busy while another change (or a runtime's cleanup) is in flight. */
  private async change<T>(work: () => Promise<T>): Promise<T> {
    this.ensureOpen()
    if (this.changing || this.runtime?.stopping === true) throw new ConnectorBusy()
    this.changing = true
    try {
      return await work()
    } finally {
      this.changing = false
    }
  }

  /** Claims the machine; an older v3 owner is asked to hand over first (04-connector.md §9.1). */
  private async claim(binding: { connectorId?: string; serverUrl?: string } = {}): Promise<void> {
    let result: ClaimResult = await this.options.lease.claim(binding)
    if (result.ok) return
    const handover = this.options.handover
    if (result.decision === 'request_handover' && handover?.request !== undefined) {
      this.log('info', `asking the older Connector (${result.owner.connectorVersion}, PID ${result.owner.pid}) to hand over`)
      if (await handover.request(result.owner)) {
        const deadline = Date.now() + (handover.maxWaitMs ?? 300_000) + 15_000
        while (Date.now() < deadline) {
          await this.sleep(500)
          result = await this.options.lease.claim(binding)
          if (result.ok) return
          if (result.decision !== 'request_handover') break
        }
      }
    }
    if (!result.ok) throw new ConnectorAlreadyRunning(result.owner, result.decision)
  }

  public async acquireOwnership(): Promise<ConnectorState> {
    this.ensureOpen()
    await this.claim()
    return this.getState()
  }

  public getConfig(): ConnectorSettings {
    return this.options.config.read()
  }

  public saveConfig(params: unknown): Promise<ConnectorSettings> {
    return this.change(async () => {
      const settings = settingsFrom(params)
      await this.claim()
      const path = this.options.config.save(settings)
      this.authFailed = false
      this.lastError = null
      this.log('info', `saved connector config path=${path}`)
      this.emitState()
      return settings
    })
  }

  public start(params?: unknown): Promise<ConnectorState> {
    return this.change(() => this.startRuntime(params))
  }

  public stop(): Promise<ConnectorState> {
    return this.change(() => this.stopRuntime())
  }

  public restart(params?: unknown): Promise<ConnectorState> {
    return this.change(async () => {
      await this.stopRuntime()
      this.ensureOpen()
      return this.startRuntime(params)
    })
  }

  private settingsFor(params: unknown): ConnectorSettings {
    if (params !== null && typeof params === 'object' && Object.keys(params).length > 0) return settingsFrom(params)
    if (!this.options.config.exists) throw new ConfigError('no saved configuration; pair this Connector or save a configuration first')
    return this.options.config.load()
  }

  /** Starts while holding the lifecycle lock; also used by restart and pairing. */
  private async startRuntime(params?: unknown): Promise<ConnectorState> {
    if (this.runtime !== null) return this.getState()
    const settings = this.settingsFor(params)
    this.lastError = null
    this.authFailed = false
    try {
      await this.claim({ connectorId: settings.connectorId, serverUrl: settings.serverUrl })
    } catch (error) {
      this.lastError = (error as Error).message
      this.emitState()
      throw error
    }
    const abort = new AbortController()
    const runtime = this.options.runtime(settings, { deviceSettings: value => this.applyDeviceSettings(value) })
    const entry: RunningRuntime = { abort, stopping: false, done: Promise.resolve() }
    entry.done = runtime.run(abort.signal).then(
      () => undefined,
      (error: unknown) => {
        if (isCredentialFailure(error)) {
          this.authFailed = true
          this.lastError = (error as Error).message
          this.log('error', `connector authentication failed: ${this.lastError}`)
        } else {
          this.lastError = (error as Error)?.message || String(error)
          this.log('error', `connector runtime failed: ${this.lastError}`)
        }
      },
    ).finally(() => {
      if (this.runtime === entry) this.runtime = null
      this.emitState()
    })
    this.runtime = entry
    this.log('info', 'starting connector runtime')
    this.emitState()
    return this.getState()
  }

  private async stopRuntime(): Promise<ConnectorState> {
    const entry = this.runtime
    if (entry !== null) {
      entry.stopping = true
      entry.abort.abort()
      await entry.done
    }
    this.log('info', 'stopped connector runtime')
    this.emitState()
    return this.getState()
  }

  private applyDeviceSettings(settings: Record<string, unknown>): void {
    if (JSON.stringify(settings) === JSON.stringify(this.deviceSettings)) return
    this.deviceSettings = { ...settings }
    this.emitState()
  }

  public async startPairing(params: Record<string, unknown> = {}): Promise<PairingStatus> {
    this.ensureOpen()
    await this.claim()
    this.cancelPairingTasks()
    const generation = this.pairingGeneration
    const abort = new AbortController()
    this.pairingAbort = abort
    const server = typeof params.server === 'string' ? params.server : typeof params.serverUrl === 'string' ? params.serverUrl : null
    const resolveTimeout = Number(params.resolveTimeout ?? 10)
    let serverUrl: string
    try {
      serverUrl = await resolvePairServerUrl(server, this.options.fetchJson, (Number.isFinite(resolveTimeout) ? resolveTimeout : 10) * 1000, abort.signal)
    } catch (error) {
      if (this.pairingAbort === abort) this.pairingAbort = null
      this.emitState()
      throw error
    }
    if (!this.pairingCurrent(generation)) return { status: 'cancelled' }
    const payload: PairingStatus = { status: 'starting', serverUrl }
    this.emitPairing(payload)
    this.emitState()
    const timeout = Number(params.timeout ?? 600)
    const pollInterval = Number(params.pollInterval ?? 2)
    void this.runPairing(serverUrl, Number.isFinite(timeout) ? timeout : 600, Number.isFinite(pollInterval) ? pollInterval : 2, generation, abort).finally(() => {
      if (this.pairingAbort === abort) {
        this.pairingAbort = null
        this.emitState()
      }
    })
    return payload
  }

  private pairingCurrent(generation: number): boolean {
    return !this.closing && generation === this.pairingGeneration
  }

  private cancelPairingTasks(): void {
    this.pairingGeneration++
    this.pairingAbort?.abort()
    this.pairingAbort = null
  }

  public cancelPairing(): PairingStatus {
    this.cancelPairingTasks()
    const payload: PairingStatus = { status: 'cancelled' }
    this.emitPairing(payload)
    this.emitState()
    return payload
  }

  private async runPairing(serverUrl: string, timeoutSeconds: number, pollSeconds: number, generation: number, abort: AbortController): Promise<void> {
    try {
      const started = await startPairing(this.options.fetchJson, serverUrl, timeoutSeconds, abort.signal)
      if (!this.pairingCurrent(generation)) return
      this.emitPairing({ status: 'waiting', serverUrl, pairingId: started.pairingId, code: started.code })
      const deadline = Date.now() + timeoutSeconds * 1000
      while (Date.now() < deadline) {
        const payload = await pollPairing(this.options.fetchJson, serverUrl, started.pairingId, abort.signal)
        if (!this.pairingCurrent(generation)) return
        if (payload.status === 'claimed' && payload.config !== null && typeof payload.config === 'object') {
          const settings = settingsFrom(payload.config)
          // Committing takes the lifecycle lock; a cancellation in between leaves nothing saved.
          while (this.changing && this.pairingCurrent(generation)) await this.sleep(50)
          if (!this.pairingCurrent(generation)) return
          this.changing = true
          try {
            this.options.config.save(settings)
            await this.startRuntime()
          } finally {
            this.changing = false
          }
          if (this.pairingCurrent(generation)) this.emitPairing({ status: 'claimed', config: settings })
          return
        }
        if (payload.status === 'expired' || payload.status === 'consumed') {
          this.emitPairing({ status: payload.status })
          return
        }
        await this.sleep(pollSeconds * 1000, abort.signal)
      }
      if (this.pairingCurrent(generation)) this.emitPairing({ status: 'expired' })
    } catch (error) {
      if (!this.pairingCurrent(generation)) return
      this.lastError = (error as Error)?.message || String(error)
      this.emitPairing({ status: 'error', error: this.lastError })
      this.emitState()
    }
  }

  /**
   * A newer Connector asks this one to hand over (`aa.local.v2.Control/requestHandover`): accepted only from a
   * strictly newer version; then this one waits for running turns to end (bounded), stops, releases the lease
   * and tells its host to exit.
   */
  public requestHandover(request: { version?: unknown }): { accepted: boolean; waitMs?: number; reason?: string } {
    const policy = this.options.handover
    const theirs = typeof request.version === 'string' ? request.version : ''
    if (policy === undefined || this.closing) return { accepted: false, reason: 'not_available' }
    if (compareVersions(theirs, policy.version) <= 0) return { accepted: false, reason: 'not_newer' }
    const maxWaitMs = policy.maxWaitMs ?? 300_000
    if (!this.handingOver) {
      this.handingOver = true
      void this.handOver(policy, maxWaitMs, theirs)
    }
    return { accepted: true, waitMs: maxWaitMs }
  }

  private async handOver(policy: HandoverPolicy, maxWaitMs: number, newer: string): Promise<void> {
    this.log('info', `handing over to Connector ${newer}`)
    const deadline = Date.now() + maxWaitMs
    while (Date.now() < deadline) {
      const turns = await policy.activeTurns().catch(() => 0)
      if (turns === 0) break
      await this.sleep(1000)
    }
    try {
      await this.shutdown()
    } finally {
      this.lastError = `handed over to Connector ${newer}`
      this.emitState()
      policy.onHandedOver?.()
    }
  }

  /** Process exit: no new lifecycle work; the runtime stops and the lease is released. */
  public async shutdown(): Promise<void> {
    this.closing = true
    this.cancelPairingTasks()
    while (this.changing) await this.sleep(50)
    this.changing = true
    try {
      await this.stopRuntime()
    } finally {
      this.changing = false
      await this.options.lease.release()
    }
  }
}
