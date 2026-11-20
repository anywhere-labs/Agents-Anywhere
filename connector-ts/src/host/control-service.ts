// ported from Agents-Anywhere v2 connector/connector/mesh/control.py @98dd0e6e5 (ControlService, ControlEvents)
// ported from Agents-Anywhere v2 connector/connector/mesh/logs.py @98dd0e6e5 (LogsService)
//
// aa.local.v2.Control and aa.local.v2.Logs (contracts/local-machine/2.0) on the local Router, plus
// `Control/requestHandover` (04-connector.md §9.1).
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { InvalidArgumentError, Mesh, MeshCallError, Router, type RpcContext } from 'meshcall'

import { defineService, type MethodDef } from '../mesh/index.js'
import type { TrustListView } from '../application/ports/trust.js'
import type { ConnectorSettings } from './config.js'
import type { ConfirmationEvent, LocalConfirmations } from './confirmations.js'
import type { ConnectorController, ConnectorState, PairingStatus } from './controller.js'
import { EventHub } from './events.js'
import type { OwnerView } from './lease.js'
import { CONTROL_SERVICE, LOGS_SERVICE, routerDirectory, writePrivateJson, type LocalDescriptor, type LocalEndpoint } from './local-hub.js'
import type { LogSource, LogStore, LogWrite } from './logs.js'

export const CONNECTOR_ERROR = 'connector_error'

export interface ControlEvent {
  seq: number
  kind: 'state' | 'pairing'
  state: ConnectorState | null
  pairing: PairingStatus | null
}

/** Controller notifications as ordered, replayable events; only the newest state and pairing matter. */
export class ControlEvents {
  public readonly hub = new EventHub<ConnectorState | PairingStatus>({ history: 1000, capacity: 64, coalescing: ['state', 'pairing'] })

  public publish(kind: 'state' | 'pairing', payload: ConnectorState | PairingStatus): void {
    this.hub.publish(kind, payload)
  }
}

/** The fields local-machine 2.0 declares (its clients validate responses against them). */
function wireSettings(settings: ConnectorSettings): Omit<ConnectorSettings, 'proxy'> {
  const { proxy: _proxy, ...rest } = settings
  return rest
}

function wirePairing(status: PairingStatus): PairingStatus {
  return status.config === undefined || status.config === null ? status : { ...status, config: wireSettings(status.config) as ConnectorSettings }
}

/** Client pairing failures a host can act on (say what to do), passed through with their code. */
const PAIRING_CODES = new Set(['connector_not_running', 'connector_offline', 'e2ee_off', 'pairing_limit', 'not_available'])

/** The error mapping local-machine 2.0 hosts expect: AA codes stay; `connector_busy` is not retryable; bad input is invalid_argument; the rest connector_error. */
function asControlError(error: unknown): unknown {
  if (error instanceof MeshCallError) return error
  const code = (error as { code?: unknown })?.code
  const message = (error as Error)?.message || String(error)
  if (code === 'connector_busy') return new MeshCallError('connector_busy', message, { retryable: false })
  if (code === 'connector_already_running') return new MeshCallError(code, message, { details: (error as { details?: Record<string, unknown> }).details ?? {} })
  if (code === 'invalid_argument') return new InvalidArgumentError(message)
  if (typeof code === 'string' && PAIRING_CODES.has(code)) return new MeshCallError(code, message, { retryable: false })
  return new MeshCallError(CONNECTOR_ERROR, message)
}

/** A client pairing invitation (contracts/e2ee/1.0 `PairingPayload`): the QR code content and when it expires. */
export interface ClientPairingInvitation {
  readonly uri: string
  readonly deviceId: string
  readonly pairingId: string
  readonly expiresAt: string
  /** The device identity key's fingerprint, for comparing on the client before pairing. */
  readonly fingerprint: string
}

/** A client this computer's host vouches for directly (§7.1: Desktop next to the Connector, no QR code). */
export interface LocalClientGrant {
  readonly clientId: string
  readonly label: string
  readonly identityPubFingerprint: string
}

/** Device Trust as the local control interface exposes it; wired by entry/ to the running Connector's trust. */
export interface ClientTrustControl {
  /** A pairing invitation of the running Connector (`DeviceTrustService.startPairing` with the Server's mode). */
  startClientPairing(): Promise<ClientPairingInvitation>
  listClientGrants(): Promise<TrustListView>
  revokeClientGrant(request: { deviceId: string; clientId: string; grantedAt: string }): Promise<TrustListView>
  /** Writes a grant without a pairing (`DeviceTrustService.grantLocally`); `host` role only. */
  grantLocalClient(request: { clientIdentityPub: string; label: string; platform: string | null }): Promise<LocalClientGrant>
}

export interface ControlExtras {
  readonly trust?: ClientTrustControl
  readonly confirmations?: LocalConfirmations
}

function notAvailable(what: string): never {
  throw Object.assign(new Error(`${what} is not available in this Connector`), { code: 'not_available' })
}

function requiredString(request: Record<string, unknown>, name: string): string {
  const value = request[name]
  if (typeof value !== 'string' || value === '') throw new InvalidArgumentError(`${name} is required`)
  return value
}

function unary(name: string, description: string, run: (request: Record<string, unknown>, context: RpcContext) => unknown, extra: Partial<MethodDef> = {}): MethodDef {
  return {
    name,
    kind: 'unary',
    description,
    ...extra,
    handler: (async (request: Record<string, unknown>, context: RpcContext) => {
      try {
        return await run(request, context)
      } catch (error) {
        throw asControlError(error)
      }
    }) as never,
  }
}

function optionalConfig(request: Record<string, unknown>): unknown {
  return request.config === null || request.config === undefined ? undefined : request.config
}

/**
 * `aa.local.v2.Control`: what the host (Desktop, the DSH plugin manager) calls with the `host` key. Control commands
 * are never declared idempotent, so the SDK never replays one (a repeated restart or startPairing is a second user
 * action).
 */
export function controlService(controller: ConnectorController, events: ControlEvents, extras: ControlExtras = {}): object {
  return defineService(CONTROL_SERVICE, 'Configure, start and stop this Connector, and follow its state.', [
    unary('getState', 'The runtime status and the last error it reported.', () => controller.getState(), { readOnly: true }),
    unary('getPaths', 'Where this Connector keeps its configuration and the machine runtime record.', () => controller.getPaths(), { readOnly: true }),
    unary('acquireOwnership', 'Reserve the machine for this Connector; fails with connector_already_running.', () => controller.acquireOwnership(), { readOnly: false, destructive: false }),
    unary('getConfig', 'The saved configuration, or the defaults when none is saved.', () => wireSettings(controller.getConfig()), { readOnly: true }),
    unary('saveConfig', 'Validate and save the configuration; claims the machine first.', async request => wireSettings(await controller.saveConfig(request.config)), { readOnly: false, destructive: false }),
    unary('start', 'Start the runtime with the given or the saved configuration.', request => controller.start(optionalConfig(request)), { readOnly: false, destructive: false }),
    unary('stop', 'Stop the runtime; the machine stays reserved for this process.', () => controller.stop(), { readOnly: false, destructive: false }),
    unary('restart', 'Stop, then start with the given or the saved configuration.', request => controller.restart(optionalConfig(request)), { readOnly: false, destructive: false }),
    unary('startPairing', 'Start a pairing against server; progress arrives as pairing events.', async request => wirePairing(await controller.startPairing(request)), { readOnly: false, destructive: false }),
    unary('cancelPairing', 'Cancel the pairing in progress, if any.', () => controller.cancelPairing(), { readOnly: false, destructive: false }),
    unary('requestHandover', 'A newer Connector on this machine asks this one to hand over (04-connector.md §9.1).', request => controller.requestHandover(request), { readOnly: false, destructive: false }),
    unary('startClientPairing', 'Create a pairing invitation for a client in encrypted mode (QR code link, 10 minutes, one use).', () => (extras.trust ?? notAvailable('client pairing')).startClientPairing(), { readOnly: false, destructive: false }),
    unary('listClientGrants', 'List client grants on this computer.', () =>
      (extras.trust ?? notAvailable('client grants')).listClientGrants(), { readOnly: true }),
    unary('revokeClientGrant', 'Revoke the selected grant on this computer.', request =>
      (extras.trust ?? notAvailable('client grants')).revokeClientGrant({
        deviceId: requiredString(request, 'deviceId'), clientId: requiredString(request, 'clientId'),
        grantedAt: requiredString(request, 'grantedAt'),
      }), { readOnly: false, destructive: true }),
    unary('grantLocalClient', 'Authorise a client on this computer directly, without a pairing code (host only).', request => {
      const platform = request.platform
      return (extras.trust ?? notAvailable('client pairing')).grantLocalClient({
        clientIdentityPub: requiredString(request, 'clientIdentityPub'),
        label: typeof request.label === 'string' ? request.label : '',
        platform: typeof platform === 'string' ? platform : null,
      })
    }, { readOnly: false, destructive: false }),
    unary('answerConfirmation', 'Answer a confirmation request from the confirmations stream; anything but approved: true refuses.', request => {
      const confirmations = extras.confirmations ?? notAvailable('local confirmation')
      return { accepted: confirmations.answer(requiredString(request, 'confirmationId'), request.approved === true) }
    }, { readOnly: false, destructive: false }),
    {
      name: 'confirmations',
      kind: 'server_stream',
      description: 'Requests that need the person at this computer (a client approved by another client), pending ones first; unanswered requests time out as refused.',
      readOnly: true,
      handler: (async function* (_request: Record<string, unknown>, context: RpcContext): AsyncGenerator<ConfirmationEvent> {
        const confirmations = extras.confirmations
        if (confirmations === undefined) throw asControlError(Object.assign(new Error('local confirmation is not available in this Connector'), { code: 'not_available' }))
        yield* confirmations.follow(context.signal)
      }) as never,
    },
    {
      name: 'events',
      kind: 'server_stream',
      description: 'State and pairing events after since; read getState for the current state.',
      readOnly: true,
      handler: (async function* (request: Record<string, unknown>, context: RpcContext): AsyncGenerator<ControlEvent> {
        const since = typeof request.since === 'number' ? request.since : null
        for await (const event of events.hub.subscribe(since, context.signal)) {
          const payload = event.item
          yield event.kind === 'state'
            ? { seq: event.seq, kind: 'state', state: payload as ConnectorState, pairing: null }
            : { seq: event.seq, kind: 'pairing', state: null, pairing: wirePairing(payload as PairingStatus) }
        }
      }) as never,
    },
  ], { targeted: false })
}

/** Where an owner publishes how to ask it for a client pairing: `<router dir>/<lease instance id>.pairing.json` (0600). */
export function clientPairingPath(leaseInstanceId: string, directory = routerDirectory()): string {
  return join(directory, `${leaseInstanceId}.pairing.json`)
}

/** The `client-pairing` role key, for `anywhere-cli pair-client` while another host owns the machine. */
export function publishClientPairing(leaseInstanceId: string, connectorVersion: string, descriptor: LocalDescriptor, directory?: string): () => void {
  return publishLocalDescriptor(clientPairingPath(leaseInstanceId, directory), connectorVersion, descriptor)
}

export function publishClientAdmin(leaseInstanceId: string, connectorVersion: string, descriptor: LocalDescriptor, directory: string): () => void {
  return publishLocalDescriptor(join(directory, `${leaseInstanceId}.client-admin.json`), connectorVersion, descriptor)
}

function publishLocalDescriptor(path: string, connectorVersion: string, descriptor: LocalDescriptor): () => void {
  writePrivateJson(path, { version: 1, connectorVersion, pid: descriptor.pid, endpoint: descriptor.endpoint, key: descriptor.key } satisfies HandoverRendezvous)
  return () => rmSync(path, { force: true })
}

/**
 * Asks the Connector that owns the machine for a client pairing invitation (`Control/startClientPairing` with the
 * `client-pairing` key it published). Throws with a message for the user when it cannot.
 */
export async function requestClientPairing(owner: OwnerView, directory?: string): Promise<ClientPairingInvitation> {
  let rendezvous: HandoverRendezvous
  try {
    rendezvous = JSON.parse(readFileSync(clientPairingPath(owner.instanceId, directory), 'utf8')) as HandoverRendezvous
  } catch {
    throw new Error(`the Connector running on this computer (${owner.kind}, PID ${owner.pid}) cannot create client pairings; create the pairing link in that app, or stop it and run this command again`)
  }
  return callLocalControl(rendezvous, 'startClientPairing', {})
}

export async function requestClientGrants(owner: OwnerView, directory: string, revoke?: { deviceId: string; clientId: string; grantedAt: string }): Promise<TrustListView> {
  const path = join(directory, `${owner.instanceId}.client-admin.json`)
  const descriptor: HandoverRendezvous = JSON.parse(readFileSync(path, 'utf8'))
  return callLocalControl(descriptor, revoke ? 'revokeClientGrant' : 'listClientGrants', revoke ?? {})
}

async function callLocalControl<T>(rendezvous: HandoverRendezvous, method: string, input: Record<string, unknown>): Promise<T> {
  const router = new Router('unixPath' in rendezvous.endpoint ? { unixPath: rendezvous.endpoint.unixPath } : { pipe: rendezvous.endpoint.pipe })
  const mesh = new Mesh(router, { token: rendezvous.key, reconnect: { enabled: false }, retry: false })
  try {
    return await mesh.unary<Record<string, unknown>, T>(CONTROL_SERVICE, method, input, { timeoutMs: 30_000 })
  } finally {
    await mesh.close().catch(() => undefined)
  }
}

const SOURCES = new Set<LogSource>(['connector', 'bridge'])

function source(value: unknown): LogSource | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && SOURCES.has(value as LogSource)) return value as LogSource
  throw new InvalidArgumentError('source must be connector or bridge')
}

function seq(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

/** `aa.local.v2.Logs` over the Connector's log store (dsh-bridge 2.0 `logs.md`): the host may clear, the bridge may not. */
export function logsService(logs: LogStore): object {
  return defineService(LOGS_SERVICE, 'Write, read and follow Connector-owned persistent runtime logs.', [
    unary('write', 'Commit a Bridge batch; stable producer/eventId pairs deduplicate retries.', async request => {
      const entries = Array.isArray(request.entries) ? (request.entries as LogWrite[]) : []
      if (entries.length > 64) throw new InvalidArgumentError('at most 64 entries per batch')
      for (const entry of entries) {
        if (typeof entry?.producer !== 'string' || entry.producer === '' || typeof entry.eventId !== 'string' || entry.eventId === '') {
          throw new InvalidArgumentError('every entry needs producer and eventId')
        }
      }
      return { accepted: await logs.append(entries, 'bridge') }
    }, { readOnly: false, destructive: false }),
    unary('read', 'Read a bounded page of persisted runtime records.', request => {
      const limit = typeof request.limit === 'number' ? request.limit : 200
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new InvalidArgumentError('limit must be 1..1000')
      return logs.read({ source: source(request.source), beforeSeq: seq(request.beforeSeq), afterSeq: seq(request.afterSeq), limit })
    }, { readOnly: true }),
    unary('clear', 'Clear runtime records without resetting their sequence; host only.', () => logs.clear(), { readOnly: false, destructive: false }),
    {
      name: 'tail',
      kind: 'server_stream',
      description: 'Replay persisted history then follow new records, marking retention gaps.',
      readOnly: true,
      handler: (async function* (request: Record<string, unknown>, context: RpcContext) {
        yield* logs.tail(seq(request.since), source(request.source), context.signal)
      }) as never,
    },
  ], { targeted: false })
}

/** Where an owner publishes how to ask it for a handover: `<router dir>/<lease instance id>.handover.json` (0600). */
export function handoverPath(leaseInstanceId: string, directory = routerDirectory()): string {
  return join(directory, `${leaseInstanceId}.handover.json`)
}

export interface HandoverRendezvous {
  readonly version: number
  readonly connectorVersion: string
  readonly pid: number
  readonly endpoint: LocalEndpoint
  /** The `handover` role key: it may call `Control/requestHandover` and nothing else. */
  readonly key: string
}

export function publishHandover(leaseInstanceId: string, connectorVersion: string, descriptor: LocalDescriptor, directory?: string): () => void {
  const path = handoverPath(leaseInstanceId, directory)
  writePrivateJson(path, { version: 1, connectorVersion, pid: descriptor.pid, endpoint: descriptor.endpoint, key: descriptor.key } satisfies HandoverRendezvous)
  return () => rmSync(path, { force: true })
}

/** Asks the owner named by the lease record to hand over to `myVersion`; false when it cannot be reached or refuses. */
export function handoverRequester(myVersion: string, directory?: string, log?: (message: string) => void): (owner: OwnerView) => Promise<boolean> {
  return async owner => {
    let rendezvous: HandoverRendezvous
    try {
      rendezvous = JSON.parse(readFileSync(handoverPath(owner.instanceId, directory), 'utf8')) as HandoverRendezvous
    } catch {
      log?.(`the owning Connector (PID ${owner.pid}) publishes no handover endpoint`)
      return false
    }
    const router = new Router('unixPath' in rendezvous.endpoint ? { unixPath: rendezvous.endpoint.unixPath } : { pipe: rendezvous.endpoint.pipe })
    const mesh = new Mesh(router, { token: rendezvous.key, reconnect: { enabled: false }, retry: false })
    try {
      const answer = await mesh.unary<Record<string, unknown>, { accepted?: boolean; reason?: string }>(CONTROL_SERVICE, 'requestHandover', { version: myVersion }, { timeoutMs: 10_000 })
      if (answer.accepted !== true) log?.(`the owning Connector refused to hand over: ${answer.reason ?? 'unknown'}`)
      return answer.accepted === true
    } catch (error) {
      log?.(`handover request failed: ${(error as Error).message}`)
      return false
    } finally {
      await mesh.close().catch(() => undefined)
    }
  }
}
