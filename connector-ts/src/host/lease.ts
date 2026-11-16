// The single-instance lease (04-connector.md §9.1): one Connector per OS user, recorded in the shared
// `connector-runtime.json`, with version arbitration between the Connectors bundled by Desktop, the CLI and the
// DSH plugin. The decision is pure (`arbitrate`); asking an older owner to hand over goes through the local
// control interface, which the caller supplies.
import { randomUUID } from 'node:crypto'

import { commandDigest, identityMatches, isV2ConnectorCommand, legacyIdentity, systemProbe, type ProcessProbe } from './processes.js'
import { runtimeTransaction, type RuntimeOwnerRecord } from './runtime-record.js'

export const CONNECTOR_ALREADY_RUNNING = 'connector_already_running'

export type HostKind = 'cli' | 'desktop-workbench' | 'dsh-plugin'

export interface LeaseIdentity {
  readonly kind: HostKind
  /** This Connector's version (`3.0.0`). */
  readonly version: string
  /** The newest local-store schema this code opens. */
  readonly schemaVersion: number
}

/** What to do about a live owner. */
export type Arbitration =
  /** A v2 Connector or an unknown owner: refuse to start (v2 `connector_already_running`). */
  | 'conflict'
  /** An older v3 owner: ask it to hand over, then claim again. */
  | 'request_handover'
  /** A newer (or the same) version, or one whose store this code cannot open: use it instead of starting. */
  | 'use_existing'

export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.replace(/^v/u, '').split(/[.+-]/u).slice(0, 3).map(part => Number.parseInt(part, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

/** Newer takes over (04-connector.md §9.1); old code never opens a newer store. */
export function arbitrate(owner: RuntimeOwnerRecord, me: LeaseIdentity): Arbitration {
  if (owner.connectorVersion === undefined) return 'conflict'
  if (owner.schemaVersion !== undefined && owner.schemaVersion > me.schemaVersion) return 'use_existing'
  return compareVersions(me.version, owner.connectorVersion) > 0 ? 'request_handover' : 'use_existing'
}

export interface OwnerView {
  readonly kind: string
  readonly pid: number
  readonly instanceId: string
  readonly connectorVersion: string | null
}

export type ClaimResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly decision: Arbitration; readonly owner: OwnerView }

export class ConnectorAlreadyRunning extends Error {
  public readonly code = CONNECTOR_ALREADY_RUNNING
  public readonly details: Record<string, unknown>

  public constructor(public readonly owner: OwnerView, public readonly decision: Arbitration) {
    super(`Another Connector is running (${owner.kind}, PID ${owner.pid}). Stop that Connector process, then retry.`)
    this.name = 'ConnectorAlreadyRunning'
    this.details = { reason: CONNECTOR_ALREADY_RUNNING, owner: { kind: owner.kind, pid: owner.pid }, decision }
  }
}

/** Whether the process a record names is still that Connector (pid, start time, command line). */
export async function ownerAlive(owner: RuntimeOwnerRecord, probe: ProcessProbe = systemProbe): Promise<boolean> {
  const check = async (pid: number | undefined, identity: string | undefined): Promise<boolean> => {
    if (pid === undefined || !probe.exists(pid)) return false
    if (identity !== undefined && identity !== '') {
      const started = await probe.startedAt(pid)
      if (started === null) throw new Error('Cannot verify the Connector process start time.')
      if (!identityMatches(identity, started)) return false
    }
    const command = await probe.commandLine(pid)
    if (command === null) return false
    if (owner.commandDigest !== undefined) return commandDigest(command) === owner.commandDigest
    return isV2ConnectorCommand(command)
  }
  return (await check(owner.pid, owner.processStartedAt)) || (await check(owner.childPid, owner.childStartedAt))
}

function view(owner: RuntimeOwnerRecord): OwnerView {
  return { kind: owner.kind, pid: owner.pid, instanceId: owner.instanceId, connectorVersion: owner.connectorVersion ?? null }
}

export interface RuntimeLeaseOptions {
  readonly path: string
  readonly identity: LeaseIdentity
  readonly probe?: ProcessProbe
  readonly pid?: number
  readonly now?: () => Date
}

export class RuntimeLease {
  public readonly instanceId = randomUUID()
  private acquired = false
  private readonly probe: ProcessProbe
  private readonly pid: number

  public constructor(private readonly options: RuntimeLeaseOptions) {
    this.probe = options.probe ?? systemProbe
    this.pid = options.pid ?? process.pid
  }

  public get held(): boolean {
    return this.acquired
  }

  /**
   * Claims the machine for this process, or reports the live owner and what to do about it. With a
   * `connectorId` the id is appended to the shared history in the same transaction (v2 rule 4).
   */
  public async claim(binding: { connectorId?: string; serverUrl?: string } = {}): Promise<ClaimResult> {
    const [startedAt, command] = await Promise.all([this.probe.startedAt(this.pid), this.probe.commandLine(this.pid)])
    return runtimeTransaction(this.options.path, async state => {
      const owner = state.runtime
      if (owner !== undefined && owner.instanceId !== this.instanceId && (await ownerAlive(owner, this.probe))) {
        return { ok: false, decision: arbitrate(owner, this.options.identity), owner: view(owner) } as const
      }
      let mine: RuntimeOwnerRecord
      if (owner !== undefined && owner.instanceId === this.instanceId) mine = owner
      else {
        mine = {
          instanceId: this.instanceId,
          pid: this.pid,
          kind: this.options.identity.kind,
          startedAt: (this.options.now?.() ?? new Date()).toISOString(),
          ...(startedAt !== null ? { processStartedAt: legacyIdentity(startedAt) } : {}),
          connectorVersion: this.options.identity.version,
          schemaVersion: this.options.identity.schemaVersion,
          ...(command !== null ? { commandDigest: commandDigest(command) } : {}),
        }
      }
      if (binding.connectorId !== undefined) {
        mine.connectorId = binding.connectorId
        state.connectorIds = [...new Set([...state.connectorIds, binding.connectorId])]
      }
      if (binding.serverUrl !== undefined) mine.serverUrl = binding.serverUrl
      state.runtime = mine
      this.acquired = true
      return { ok: true } as const
    })
  }

  /** `claim`, throwing `connector_already_running` (with the arbitration decision) when it is not ours. */
  public async acquire(binding: { connectorId?: string; serverUrl?: string } = {}): Promise<void> {
    const result = await this.claim(binding)
    if (!result.ok) throw new ConnectorAlreadyRunning(result.owner, result.decision)
  }

  /** Clears the record's owner if it is still this instance; history and installation info stay. */
  public async release(): Promise<void> {
    if (!this.acquired) return
    await runtimeTransaction(this.options.path, state => {
      if (state.runtime?.instanceId === this.instanceId) delete state.runtime
    })
    this.acquired = false
  }
}
