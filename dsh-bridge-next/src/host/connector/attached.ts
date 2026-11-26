import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { bridgeDirectory } from '../config.js'
import type { BoundDevice } from '../account/binding.js'
import type { RuntimeDiagnostics } from '../dsh-runtime/diagnostics.js'
import { parseRendezvous, type Rendezvous } from '../dsh-runtime/connection.js'
import type { ConnectorProcess, ConnectorState } from './process.js'

/**
 * What this plugin refuses to do to a Connector that a system service starts and owns.
 * Each string is also its locale key: the settings page shows it as is.
 */
export const EXTERNALLY_MANAGED = {
  stop: '本机 Connector 由系统服务管理，不能在插件里停止或重启。',
  settings: '本机 Connector 由系统服务管理，运行环境、网络和同步设置请在该服务的配置里修改。',
  reinstall: '本机 Connector 由系统服务管理，不能在插件里重装依赖环境。',
  reset: '本机 Connector 由系统服务管理，不能在插件里恢复出厂设置。',
  device: '本机 Connector 由系统服务管理：插件不认领、不重新连接、不重新创建设备，也不轮换它的凭据。',
  binding: '本机 Connector 由系统服务管理，而插件里还没有它的设备凭据；插件不会自己认领一台。请把该服务使用的那份凭据（连接器号与令牌）写进插件的绑定记录后重试。',
} as const

export const CONNECTOR_ABSENT = '本机没有正在运行的 Connector。它由系统服务启动，启动后这里会自动连接。'
/** What a start rejects with once stop() has come and gone: the AbortError an aborted start gets. */
const VOID_START: unknown = (() => { const controller = new AbortController(); controller.abort(); return controller.signal.reason })()
const CONNECTOR_LOST = '本机 Connector 已停止。它由系统服务管理，重新启动后这里会自动连接。'

/** True for the two messages that mean no Connector is published right now. That is a state, not a plugin failure. */
export function isConnectorAbsent(error: unknown): boolean {
  return error instanceof Error && (error.message === CONNECTOR_ABSENT || error.message === CONNECTOR_LOST)
}

/** A Connector that is still starting publishes within this time; start() waits that long for it. */
const ATTACH_TIMEOUT_MS = 120_000
/** A replaced Connector (service restart, deploy) publishes again within this time before it counts as lost. */
const LOST_AFTER_MS = 30_000
const POLL_MS = 1_000
/** File timestamps are not sharper than a second everywhere. */
const PUBLISH_SLACK_MS = 1_000

/** EPERM means the process is there, just not ours to signal: a Connector running as another user. */
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** ps prints the elapsed time as [[dd-]hh:]mm:ss, the same in every locale; null when it cannot be told. */
async function processStartedAt(pid: number): Promise<number | null> {
  try {
    const { stdout } = await promisify(execFile)('/bin/ps', ['-o', 'etime=', '-p', String(pid)])
    const [days, clock] = stdout.trim().split('-')
    const parts = (clock ?? days ?? '').split(':').map(Number)
    if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isFinite(part))) return null
    const elapsed = (clock === undefined ? 0 : Number(days ?? 0)) * 86_400 + parts.reduce((total, part) => total * 60 + part, 0)
    return Date.now() - elapsed * 1000
  } catch {
    return null
  }
}

interface Publication {
  rendezvous: Rendezvous
  /** When the file was last written. The process behind it cannot have started after that. */
  publishedAt: number
}

/** What the Connector published, or null while nothing readable is there. Not a liveness check. */
async function readPublication(path: string): Promise<Publication | null> {
  try {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    const rendezvous = parseRendezvous(text)
    return rendezvous ? { rendezvous, publishedAt: info.mtimeMs } : null
  } catch {
    return null
  }
}

/**
 * Whether the process a publication names is the one that wrote it. The publisher starts before it
 * publishes; a process that merely inherited the pid of a crashed Connector started after the file
 * was written. A start time that cannot be read is not a verdict.
 *
 * Only a stale verdict is remembered: that process can never have written that file, whatever happens
 * next. A fresh one is not: the pid can die and be inherited by a younger process while the file stays,
 * and what was true of the number before its death says nothing about the process behind it now. The
 * question is asked on adoption only, not on every poll, so asking it again costs nothing in between.
 */
class Publisher {
  private verdict: { instanceId: string; pid: number; publishedAt: number } | null = null

  constructor(private readonly startedAt: (pid: number) => Promise<number | null>) {}

  async wrote(publication: Publication): Promise<boolean> {
    const { rendezvous, publishedAt } = publication
    const known = this.verdict
    if (known && known.instanceId === rendezvous.instanceId && known.pid === rendezvous.pid && known.publishedAt === publishedAt) return false
    const startedAt = await this.startedAt(rendezvous.pid)
    const stale = startedAt !== null && startedAt > publishedAt + PUBLISH_SLACK_MS
    this.verdict = stale ? { instanceId: rendezvous.instanceId, pid: rendezvous.pid, publishedAt } : null
    return !stale
  }
}

/** The Connector that another supervisor keeps running on this machine, if it published a live rendezvous. */
export async function publishedConnector(path: string, options: Pick<AttachedConnectorOptions, 'processStartedAt'> = {}): Promise<Rendezvous | null> {
  const publication = await readPublication(path)
  if (!publication || !alive(publication.rendezvous.pid)) return null
  return await new Publisher(options.processStartedAt ?? processStartedAt).wrote(publication) ? publication.rendezvous : null
}

/**
 * Where the output journal of a Connector this plugin started is read from. attached mode starts
 * none, so it reads a journal that was never written: an older one would only mislead.
 */
export function connectorOutputDirectory(logsDirectory: string, externallyManaged: boolean): string {
  return externallyManaged ? join(logsDirectory, 'attached') : logsDirectory
}

export interface AttachedConnectorOptions {
  /** Where the Connector publishes its Router. Only ever read. */
  rendezvousPath?: string
  pollMs?: number
  attachTimeoutMs?: number
  lostAfterMs?: number
  diagnostics?: RuntimeDiagnostics
  /** When the process with this pid started, in epoch milliseconds; null when that cannot be told. */
  processStartedAt?: (pid: number) => Promise<number | null>
}

/** The same instance with the same key at the same endpoint: nothing new to follow. */
function sameLink(a: Rendezvous, b: Rendezvous | null): boolean {
  return b !== null && a.instanceId === b.instanceId && a.key === b.key && JSON.stringify(a.endpoint) === JSON.stringify(b.endpoint)
}

/**
 * Follows a Connector that a system service, not this plugin, starts and owns.
 *
 * Nothing under stateRoot is written or removed: the Connector's environment, configuration,
 * credential and state belong to that service. Only its published rendezvous is read. A
 * replaced Connector is followed without the user doing anything, and stop() stops following
 * rather than the Connector.
 */
export class AttachedConnector implements ConnectorProcess {
  private link: Rendezvous | null = null
  private failure: Error | null = null
  private state: ConnectorState = { running: false, authFailed: false }
  /** start() succeeded and stop() has not come since: there is something to vouch for. */
  private followed = false
  /** Shared by the follow loop and assertHealthy(): when the followed Connector was first missed. */
  private absentSince: number | null = null
  private readonly listeners = new Set<(state: ConnectorState) => void>()
  private watcher: AbortController | null = null
  private starting: AbortController | null = null
  private startQueue: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  /** Bumped by every stop(): a start that queued behind an older one is void once a stop came between. */
  private stops = 0
  private readonly rendezvousPath: string
  private readonly publisher: Publisher

  constructor(private readonly options: AttachedConnectorOptions = {}) {
    this.rendezvousPath = options.rendezvousPath ?? join(bridgeDirectory(), 'connector.json')
    this.publisher = new Publisher(options.processStartedAt ?? processStartedAt)
  }

  get running(): boolean { return this.state.running }
  get lastError(): string | null { return this.failure?.message ?? null }
  /** Where the Connector keeps its logs: the directory above the fixed rendezvous. */
  get logsPath(): string { return join(dirname(dirname(this.rendezvousPath)), 'logs') }

  onState(listener: (state: ConnectorState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Nothing to install: the Connector's environment is not this plugin's. */
  async prepare(): Promise<void> {}

  /** Calls queue up, so two of them cannot wait on the same Connector twice; a stop() voids the queued ones. */
  async start(_binding: BoundDevice, _apiBaseUrl: string, signal: AbortSignal): Promise<void> {
    if (this.stopping) await this.stopping
    if (this.running) return
    const previous = this.startQueue
    const stops = this.stops
    const task = (async () => {
      if (previous) await previous.catch(() => undefined)
      if (stops !== this.stops) throw VOID_START
      await this.attach(signal)
    })()
    this.startQueue = task
    try { await task } finally { if (this.startQueue === task) this.startQueue = null }
  }

  private async attach(signal: AbortSignal): Promise<void> {
    if (this.running) return
    signal.throwIfAborted()
    // stop() ends a start that is still waiting, whichever signal the caller passed.
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    this.starting = controller
    try {
      this.failure = null
      this.updateState({ running: false, authFailed: false })
      const deadline = Date.now() + (this.options.attachTimeoutMs ?? ATTACH_TIMEOUT_MS)
      while (!(await this.reconcile(controller.signal))) {
        controller.signal.throwIfAborted()
        if (Date.now() >= deadline) throw new Error(CONNECTOR_ABSENT)
        await delay(this.options.pollMs ?? POLL_MS, undefined, { signal: controller.signal })
      }
      controller.signal.throwIfAborted()
      this.followed = true
      this.updateState({ running: true, authFailed: false })
      this.follow()
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (this.starting === controller) this.starting = null
    }
  }

  async assertHealthy(): Promise<void> {
    if (this.failure) throw this.failure
    // Not following anything: stop() is not undone by a health check.
    if (!this.followed) throw new Error(CONNECTOR_ABSENT)
    if (await this.reconcile()) return
    // Its process is gone and nothing new was published. A replaced Connector publishes again
    // within moments, so this only counts against it once that moment has passed.
    this.absentSince ??= Date.now()
    if (Date.now() - this.absentSince < (this.options.lostAfterMs ?? LOST_AFTER_MS)) return
    throw new Error(CONNECTOR_LOST)
  }

  /** Stops following the Connector. The Connector is not this plugin's to stop. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.detach().finally(() => { this.stopping = null })
    return this.stopping
  }

  /** The environment belongs to the service that runs the Connector: nothing of ours to remove. */
  async resetEnvironment(): Promise<void> {}

  private async detach(): Promise<void> {
    this.stops++
    this.starting?.abort()
    this.starting = null
    this.watcher?.abort()
    this.watcher = null
    this.link = null
    this.followed = false
    this.absentSince = null
    this.failure = null
    this.updateState({ running: false, authFailed: false })
  }

  /**
   * Adopts whichever Connector publishes now; true while there is one to follow. A dead pid behind a
   * stale file is not a Connector, and neither is a live pid that only inherited the number.
   */
  private async reconcile(signal?: AbortSignal): Promise<boolean> {
    const publication = await readPublication(this.rendezvousPath)
    let live: Rendezvous | null = null
    if (publication && alive(publication.rendezvous.pid)) {
      if (sameLink(publication.rendezvous, this.link) || await this.publisher.wrote(publication)) live = publication.rendezvous
    }
    // Past the last await before anything changes. stop() may have landed in the read above or in that call, and
    // a cached verdict comes back without waiting at all: what was read before stop() says nothing about now.
    signal?.throwIfAborted()
    if (publication && !live) this.link = null
    if (live) {
      if (!sameLink(live, this.link)) {
        const replaced = this.link !== null
        this.link = live
        this.options.diagnostics?.log('info', replaced ? 'connector.followed' : 'connector.attached',
          { instanceId: live.instanceId, pid: live.pid })
      }
      this.absentSince = null
      return true
    }
    // Nothing usable published (the file is being replaced): the Connector we follow still
    // counts while its own process is alive. One that published and exited does not.
    return this.link !== null && alive(this.link.pid)
  }

  private follow(): void {
    this.watcher?.abort()
    const controller = new AbortController()
    this.watcher = controller
    const pollMs = this.options.pollMs ?? POLL_MS
    const lostAfterMs = this.options.lostAfterMs ?? LOST_AFTER_MS
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          if (await this.reconcile(controller.signal)) {
            if (!this.state.running) {
              this.failure = null
              this.updateState({ running: true, authFailed: false })
            }
          } else if (this.absentSince === null) {
            this.absentSince = Date.now()
          } else if (this.state.running && Date.now() - this.absentSince >= lostAfterMs) {
            this.link = null
            this.failure = new Error(CONNECTOR_LOST)
            this.updateState({ running: false, authFailed: false })
          }
        } catch (error) {
          // Background work: one failed poll must not end following without a trace.
          if (!controller.signal.aborted) this.options.diagnostics?.log('warn', 'connector.follow_failed', {}, error)
        }
        // Following is background work: it must not keep a process alive by itself.
        await delay(pollMs, undefined, { signal: controller.signal, ref: false }).catch(() => undefined)
      }
    })()
  }

  private updateState(value: ConnectorState): void {
    if (value.running === this.state.running && value.authFailed === this.state.authFailed) return
    this.state = { running: value.running, authFailed: value.authFailed }
    for (const listener of this.listeners) listener({ ...this.state })
  }
}
