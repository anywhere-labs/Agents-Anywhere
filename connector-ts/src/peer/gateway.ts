// The session gateway of agent collaboration (docs/agent-collaboration.md §7): one client API for every session the
// account can reach. Sessions on this device are served in-process; another device is reached through the Server
// with a delegation token in normal mode, or through a secure channel as an `agent` client in encrypted mode. An
// encrypted account never falls back to the Server route.
import type { SessionAddress } from '../domain/collab/index.js'
import type {
  AgentActorRef,
  DirectoryDevice,
  DirectoryRuntime,
  DirectorySession,
  GatewayRequest,
  GatewayResponse,
  ObservedPage,
  OpenNotice,
  SessionGateway,
  TargetView,
} from '../application/ports/index.js'
import { observedItem, targetView } from './observed.js'

type Json = Record<string, unknown>

/** One way of reaching a device's client API. */
export interface PeerRoute {
  request(deviceId: string, actor: AgentActorRef, request: GatewayRequest): Promise<GatewayResponse>
}

/** The Server's account directory (metadata only, the same in both modes). */
export interface PeerDirectory {
  request(actor: AgentActorRef, request: GatewayRequest): Promise<GatewayResponse>
}

export interface PeerGatewayDeps {
  readonly deviceId: string
  /** This device's own client API, in-process. */
  readonly local: PeerRoute
  /** Normal mode: the Server forwards to the target device (`Client/call`). */
  readonly server: PeerRoute | null
  /** Encrypted mode: a secure channel to the target device. */
  readonly secure: PeerRoute | null
  readonly directory: PeerDirectory | null
  /** The account's E2EE mode as the link reported it. */
  readonly e2eeMode: () => 'off' | 'required'
  readonly now: () => string
}

const record = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
const unavailable = (code: string, message: string): GatewayResponse => ({ status: 503, body: { detail: { code, message } } })

export class PeerGateway implements SessionGateway {
  public constructor(private readonly deps: PeerGatewayDeps) {}

  public request(deviceId: string, actor: AgentActorRef, request: GatewayRequest): Promise<GatewayResponse> {
    if (deviceId === this.deps.deviceId) return this.deps.local.request(deviceId, actor, request)
    if (this.deps.e2eeMode() === 'required') {
      if (this.deps.secure === null) return Promise.resolve(unavailable('agent_peer_not_trusted', 'This device cannot open secure channels to other devices.'))
      return this.deps.secure.request(deviceId, actor, request)
    }
    if (this.deps.server === null) return Promise.resolve(unavailable('agent_delegation_unavailable', 'This device is not connected to the Server.'))
    return this.deps.server.request(deviceId, actor, request)
  }

  public async facts(target: SessionAddress, actor: AgentActorRef): Promise<TargetView | null> {
    const response = await this.request(target.deviceId, actor, { method: 'GET', path: `sessions/${encodeURIComponent(target.sessionId)}/meta` })
    if (response.status === 404) return null
    if (response.status >= 300) throw failure(response)
    const view = targetView(target.deviceId, response.body, this.deps.now())
    return view === null ? null : { ...view, address: target }
  }

  public async observe(target: SessionAddress, actor: AgentActorRef, afterSeq: number, limit: number): Promise<ObservedPage> {
    const query = `mode=changes&afterSeq=${Math.max(0, Math.trunc(afterSeq))}&limit=${Math.min(500, Math.max(1, Math.trunc(limit)))}`
    const response = await this.request(target.deviceId, actor, { method: 'GET', path: `sessions/${encodeURIComponent(target.sessionId)}/timeline?${query}` })
    if (response.status >= 300) throw failure(response)
    const body = record(response.body)
    const raw = Array.isArray(body.items) ? body.items : []
    const items = raw.map(observedItem).filter((item): item is NonNullable<typeof item> => item !== null).sort((a, b) => a.seq - b.seq)
    const headSeq = typeof body.nextSeq === 'number' ? body.nextSeq : items.reduce((max, item) => Math.max(max, item.seq), afterSeq)
    return { items, headSeq, resetSeq: typeof body.resetSeq === 'number' ? body.resetSeq : 0, hasMore: body.hasMore === true }
  }

  public async notices(target: SessionAddress, actor: AgentActorRef): Promise<OpenNotice[]> {
    const response = await this.request(target.deviceId, actor, { method: 'GET', path: `sessions/${encodeURIComponent(target.sessionId)}/runtime/notices` })
    if (response.status >= 300) throw failure(response)
    const notices = Array.isArray(record(response.body).notices) ? record(response.body).notices as unknown[] : []
    return notices.map(record).filter(notice => (text(notice.status) ?? 'open') === 'open').map(notice => ({
      id: text(notice.noticeId) ?? '',
      title: text(notice.title) ?? text(notice.message) ?? 'Waiting for an answer',
      kind: text(notice.interactionType) ?? text(notice.type) ?? 'interaction',
      options: (Array.isArray(notice.actions) ? notice.actions : []).map(record).map(action => ({ id: text(action.actionId) ?? '', label: text(action.label) ?? '' })).filter(option => option.id !== ''),
    })).filter(notice => notice.id !== '')
  }

  public async locate(sessionId: string, actor: AgentActorRef): Promise<string | null> {
    if (this.deps.directory === null) return null
    const response = await this.deps.directory.request(actor, { method: 'GET', path: `sessions/${encodeURIComponent(sessionId)}` })
    if (response.status >= 300) return null
    const body = record(response.body)
    const session = Object.keys(record(body.session)).length > 0 ? record(body.session) : body
    return text(session.connectorId) ?? text(session.deviceId)
  }

  public async devices(actor: AgentActorRef): Promise<DirectoryDevice[]> {
    if (this.deps.directory === null) return []
    const response = await this.deps.directory.request(actor, { method: 'GET', path: 'connectors' })
    if (response.status >= 300) return []
    const body = response.body
    const rows = Array.isArray(body) ? body : Array.isArray(record(body).connectors) ? record(body).connectors as unknown[] : Array.isArray(record(body).items) ? record(body).items as unknown[] : []
    return rows.map(record).map(row => ({
      deviceId: text(row.id) ?? text(row.connectorId) ?? text(row.deviceId) ?? '',
      name: text(row.name) ?? text(row.displayName),
      online: row.status === 'online' || row.online === true,
      e2eeMode: text(row.e2eeMode),
    })).filter(device => device.deviceId !== '')
  }

  public async runtimes(actor: AgentActorRef, deviceId: string): Promise<DirectoryRuntime[]> {
    if (this.deps.directory === null) return []
    const response = await this.deps.directory.request(actor, { method: 'GET', path: `connectors/${encodeURIComponent(deviceId)}/runtimes` })
    if (response.status >= 300) return []
    const body = response.body
    const rows = Array.isArray(body) ? body : Array.isArray(record(body).runtimes) ? record(body).runtimes as unknown[] : Array.isArray(record(body).items) ? record(body).items as unknown[] : []
    return rows.map(record).map(row => ({
      runtimeId: text(row.runtimeId) ?? text(row.id) ?? '',
      runtimeType: text(row.runtimeType) ?? text(row.runtime) ?? text(row.type) ?? '',
      name: text(row.name) ?? text(row.displayName),
      deviceId,
    })).filter(runtime => runtime.runtimeId !== '' && runtime.runtimeType !== '')
  }

  public async sessions(actor: AgentActorRef, limit: number): Promise<DirectorySession[]> {
    if (this.deps.directory === null) return []
    const response = await this.deps.directory.request(actor, { method: 'GET', path: `sessions?limit=${Math.min(200, Math.max(1, limit))}` })
    if (response.status >= 300) return []
    const body = record(response.body)
    const rows = Array.isArray(response.body) ? response.body as unknown[] : Array.isArray(body.sessions) ? body.sessions as unknown[] : Array.isArray(body.items) ? body.items as unknown[] : []
    return rows.map(record).map(item => ({
      sessionId: text(item.id) ?? text(item.sessionId) ?? '',
      deviceId: text(item.connectorId) ?? text(item.deviceId) ?? '',
      title: text(item.title),
      runtimeType: text(item.runtimeType) ?? text(item.runtime),
      status: text(item.status),
    })).filter(item => item.sessionId !== '' && item.deviceId !== '')
  }
}

function failure(response: GatewayResponse): Error & { code: string } {
  const body = record(response.body)
  const detail = record(body.detail)
  const error = record(body.error)
  const code = text(detail.code) ?? text(error.code) ?? `http_${response.status}`
  const message = text(detail.message) ?? text(error.message) ?? `the client API answered ${response.status}`
  return Object.assign(new Error(message), { code })
}
