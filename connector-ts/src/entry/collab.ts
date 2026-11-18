// Agent collaboration composed for one running Connector (docs/agent-collaboration.md): settings from the Server,
// the grants and tool servers injected into sessions, the local agent-tools socket, the session gateway with its
// three routes, supervision, and the people's client API.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CollabPeopleApi,
  CollabSettingsHolder,
  GrantService,
  SupervisionService,
  ToolService,
} from '../application/collab/index.js'
import type { ConversationService } from '../application/conversation-service.js'
import type { CollabClientApi } from '../application/inbound/collab-api.js'
import type { ChannelCaller, TunnelApi } from '../application/inbound/tunnel-api.js'
import type {
  AgentActorRef,
  Clock,
  ConversationStore,
  GatewayRequest,
  GatewayResponse,
  IdSource,
  Log,
  SupervisorFacts,
  ToolServerLaunch,
} from '../application/ports/index.js'
import { ChannelClosedError, ClientSecureChannel, fromB64url, type ChannelItem } from '../channel/index.js'
import { nodeNoiseCrypto } from '../channel/noise/node-crypto.js'
import { permissionLevelOf } from '../domain/collab/index.js'
import { clientIdFor } from '../domain/trust/index.js'
import type { FileAgentPeers } from '../keystore/agent-peers.js'
import { type ControlPlane, type Egress, HttpError, requestJson } from '../link/index.js'
import { PeerGateway, type PeerRoute } from '../peer/gateway.js'
import { ServerRoute } from '../peer/server-route.js'
import { AgentToolsSocket } from '../tools/socket.js'

const BUSY = new Set(['pending', 'running', 'stopping'])

export interface CollabOptions {
  readonly deviceId: string
  readonly dataDir: string
  readonly store: ConversationStore
  readonly clock: Clock
  readonly ids: IdSource
  readonly log: Log
  /** How the tool server is started; default: the bundled `agent-tools.js` with this Node (none from sources). */
  readonly launch?: Omit<ToolServerLaunch, 'endpoint'> | null
  /** Directory of the agent-tools socket (default `~/.agents-anywhere/agent-tools`). */
  readonly socketDir?: string
  /** Whether a runtime instance can host the tools (it declares `runtime.agent_tools.host`). */
  readonly hostsTools: (runtimeId: string) => Promise<boolean>
  readonly localRuntimes: SupervisorFacts['localRuntimes']
  readonly onOutbox: () => void
}

/** The bundled tool server beside this module, started with this Node (Electron runs it as Node). */
export function bundledToolServer(): Omit<ToolServerLaunch, 'endpoint'> | null {
  const script = fileURLToPath(new URL('./agent-tools.js', import.meta.url))
  if (!existsSync(script)) return null
  return { command: process.execPath, args: [script], env: process.versions.electron !== undefined ? { ELECTRON_RUN_AS_NODE: '1' } : {} }
}

/**
 * Built in two steps: `prepare` before the ConversationService (it injects the tool servers when sessions open),
 * `attach` once the client API, the Server credentials and the trust keys exist.
 */
export class CollabWiring {
  public readonly settings = new CollabSettingsHolder()
  public readonly grants: GrantService
  private readonly socket: AgentToolsSocket
  private conversation: ConversationService | null = null
  private supervisions: SupervisionService | null = null
  private tools: ToolService | null = null
  public people: CollabPeopleApi | null = null
  private stopSettings: (() => void) | null = null

  public constructor(private readonly options: CollabOptions) {
    this.socket = new AgentToolsSocket({
      dir: options.socketDir ?? join(homedir(), '.agents-anywhere', 'agent-tools'),
      calls: { call: (secret, tool, args) => this.tools?.call(secret, tool, args) ?? Promise.resolve({ ok: false, code: 'agent_tools_unavailable', message: 'Agents Anywhere is starting.' }) },
      onError: error => options.log('debug', `agent tools socket: ${message(error)}`),
    })
    const launch = options.launch === undefined ? bundledToolServer() : options.launch
    this.grants = new GrantService({
      deviceId: options.deviceId,
      store: options.store,
      clock: options.clock,
      ids: options.ids,
      settings: () => this.settings.get(),
      facts: this.facts(),
      launch: launch === null ? null : { ...launch, endpoint: this.socket.endpoint },
      onOutbox: options.onOutbox,
    })
  }

  /** The facts collaboration reads about this device's own sessions. */
  private facts(): SupervisorFacts {
    return {
      permissionLevel: async sessionId => {
        const bound = this.conversation?.boundSession(sessionId) ?? null
        const option = bound?.configOptions?.find(item => item.category === 'permission')
        return permissionLevelOf(typeof option?.currentValue === 'string' ? option.currentValue : null)
      },
      busy: async sessionId => {
        const session = await this.options.store.sessions.get(sessionId)
        return session !== null && BUSY.has(session.status)
      },
      canHostTools: runtimeId => this.options.hostsTools(runtimeId).catch(() => false),
      localRuntimes: () => this.options.localRuntimes(),
    }
  }

  public attach(deps: {
    readonly conversation: ConversationService
    readonly api: TunnelApi
    readonly handshake: ControlPlane
    readonly egress: () => Egress
    readonly peers: FileAgentPeers | null
    readonly e2eeMode: () => 'off' | 'required'
  }): void {
    this.conversation = deps.conversation
    const { deviceId, clock, store, ids, log } = this.options
    const local: PeerRoute = {
      request: async (_deviceId, actor, request) => {
        const response = await deps.api.request(agentCaller(actor), { method: request.method, path: apiPath(request), body: request.body ?? null })
        return { status: response.status, body: response.body }
      },
    }
    const server = new ServerRoute({
      delegate: async actor => {
        const grant = await store.collab.grant(actor.grantId)
        const response = await deps.handshake.agentDelegation({
          grantId: actor.grantId,
          supervisorSessionId: actor.sessionId,
          ...(grant !== null && grant.scope.devices !== 'account' ? { scope: { devices: grant.scope.devices } } : {}),
        })
        return { token: response.token, expiresAt: Date.parse(response.expiresAt) || clock.nowMs() + 30 * 60_000 }
      },
      http: (request, token) => serverCall(deps.handshake.serverUrl, deps.egress, request, token),
      now: () => clock.nowMs(),
    })
    const secure = deps.peers === null ? null : new SecurePeerRoute(deps.peers, deps.handshake.serverUrl, server, log)
    const gateway = new PeerGateway({
      deviceId,
      local,
      server,
      secure,
      directory: server.directory,
      e2eeMode: deps.e2eeMode,
      now: () => clock.nowIso(),
    })
    const escalations = {
      escalate: (sessionId: string, itemId: string, content: Record<string, unknown>) =>
        deps.conversation.appendSystemItem(sessionId, itemId, { ...content, text: typeof content.question === 'string' ? content.question : '' } as never),
    }
    const facts = this.facts()
    const supervisions = new SupervisionService({
      deviceId,
      store,
      clock,
      ids,
      gateway,
      facts,
      escalations,
      onOutbox: this.options.onOutbox,
      onError: (supervisionId, error) => log('debug', `supervision ${supervisionId}: ${message(error)}`),
    })
    this.supervisions = supervisions
    this.tools = new ToolService({ deviceId, store, clock, ids, grants: this.grants, gateway, facts, supervisions, escalations })
    this.people = new CollabPeopleApi(supervisions, sessionId => this.grants.available(sessionId))
    this.stopSettings = this.settings.onChange(() => void this.grants.reconcile().catch(error => log('warn', `collaboration settings: ${message(error)}`)))
  }


  /** `collab.signal`: target signals the Server forwarded. */
  public async onSignals(signals: readonly Record<string, unknown>[]): Promise<{ accepted: number }> {
    if (this.supervisions === null) return { accepted: 0 }
    const accepted = await this.supervisions.onSignals(signals.map(signal => ({
      supervisionId: String(signal.supervisionId),
      signal: {
        status: (typeof signal.status === 'string' ? signal.status : 'unknown') as never,
        headSeq: Number(signal.headSeq ?? 0),
        resetSeq: Number(signal.resetSeq ?? 0),
        latestTurnEndSeq: typeof signal.latestTurnEndSeq === 'number' ? signal.latestTurnEndSeq : null,
        planState: (signal.planState === 'planning' || signal.planState === 'awaiting_review' ? signal.planState : 'none'),
        goalState: (signal.goalState === 'active' || signal.goalState === 'paused' || signal.goalState === 'completed' ? signal.goalState : 'none'),
        deviceOnline: signal.deviceOnline !== false,
        at: typeof signal.at === 'string' ? signal.at : this.options.clock.nowIso(),
      },
    })))
    return { accepted }
  }

  public async start(): Promise<void> {
    try {
      await this.socket.start()
    } catch (error) {
      this.options.log('warn', `agent tools socket cannot listen: ${message(error)}`)
    }
    this.supervisions?.start()
  }

  public async close(): Promise<void> {
    this.stopSettings?.()
    this.supervisions?.close()
    await this.socket.close().catch(() => undefined)
  }
}

/** The people's collaboration API for the client API adapter; it answers once `attach` ran. */
export function lazyCollabApi(wiring: CollabWiring): CollabClientApi {
  const people = (): CollabPeopleApi => {
    if (wiring.people === null) throw Object.assign(new Error('agent collaboration is starting'), { code: 'runtime_unavailable' })
    return wiring.people
  }
  return {
    view: sessionId => people().view(sessionId),
    supervise: (caller, sessionId, body) => people().supervise(caller, sessionId, body),
    updateSupervision: (caller, sessionId, supervisionId, body) => people().updateSupervision(caller, sessionId, supervisionId, body),
  }
}

function agentCaller(actor: AgentActorRef): ChannelCaller {
  return {
    clientId: `agent:${actor.deviceId}/${actor.sessionId}`,
    label: 'Agent',
    platform: 'agent',
    agent: { deviceId: actor.deviceId, sessionId: actor.sessionId, grantId: actor.grantId, ...(actor.supervisionId != null ? { supervisionId: actor.supervisionId } : {}) },
  }
}

function apiPath(request: GatewayRequest): string {
  const base = `/api/v2/${request.path.replace(/^\/+/u, '')}`
  const query = request.query === undefined ? '' : new URLSearchParams(request.query as Record<string, string>).toString()
  return query === '' ? base : `${base}${base.includes('?') ? '&' : '?'}${query}`
}

async function serverCall(serverUrl: URL, egress: () => Egress, request: GatewayRequest, token: string): Promise<GatewayResponse> {
  try {
    const body = await requestJson<unknown>(egress, {
      method: request.method,
      url: new URL(apiPath(request).replace(/^\//u, ''), serverUrl),
      headers: { authorization: `Bearer ${token}` },
      ...(request.body != null ? { body: request.body } : {}),
      timeoutMs: 30_000,
    })
    return { status: 200, body }
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, body: error.body }
    return { status: 503, body: { detail: { code: 'device_offline', message: message(error) } } }
  }
}

/**
 * Encrypted mode: the client API of another device through a secure channel, as this device's `agent` client. The
 * target must have approved this device's collaboration identity, and a person must have pinned the target's key
 * here; the Server only relays ciphertext.
 */
class SecurePeerRoute implements PeerRoute {
  private readonly channels = new Map<string, Promise<ClientSecureChannel>>()

  public constructor(
    private readonly peers: FileAgentPeers,
    private readonly serverUrl: URL,
    private readonly server: ServerRoute,
    private readonly log: Log,
  ) {}

  public async request(deviceId: string, actor: AgentActorRef, request: GatewayRequest): Promise<GatewayResponse> {
    const peer = await this.peers.pinned(deviceId)
    if (peer === null) return { status: 403, body: { detail: { code: 'agent_peer_not_trusted', message: `This device's Agents are not allowed on device ${deviceId} yet; allow it in the secure connections settings.` } } }
    for (let attempt = 0; ; attempt++) {
      try {
        const channel = await this.channel(deviceId, peer.identityPub, actor)
        return await channel.request(request.method, apiPath(request), request.body ?? null, { deviceId: actor.deviceId, sessionId: actor.sessionId, grantId: actor.grantId })
      } catch (error) {
        this.channels.delete(deviceId)
        if (attempt === 0 && error instanceof ChannelClosedError && error.code !== 'device_pin_mismatch' && error.code !== 'e2ee_not_paired') continue
        const code = error instanceof ChannelClosedError ? (error.code === 'e2ee_not_paired' ? 'agent_peer_not_trusted' : error.code) : 'device_offline'
        return { status: code === 'agent_peer_not_trusted' || code === 'device_pin_mismatch' ? 403 : 503, body: { detail: { code, message: message(error) } } }
      }
    }
  }

  private channel(deviceId: string, devicePub: string, actor: AgentActorRef): Promise<ClientSecureChannel> {
    const known = this.channels.get(deviceId)
    if (known !== undefined) {
      return known.then(channel => (channel.closed === null ? channel : this.open(deviceId, devicePub, actor)))
    }
    return this.open(deviceId, devicePub, actor)
  }

  private open(deviceId: string, devicePub: string, actor: AgentActorRef): Promise<ClientSecureChannel> {
    const opened = (async () => {
      const identity = await this.peers.keyPair()
      const clientId = clientIdFor(identity.publicKey)
      const ch = `agt${Math.random().toString(36).slice(2, 12)}`
      // The tunnel WebSocket authenticates with the same delegation as the Server route.
      const { token } = await this.server.delegation(actor)
      const url = new URL('api/v3/tunnel', this.serverUrl)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[])
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true })
        socket.addEventListener('error', () => reject(new ChannelClosedError('device_offline', 'tunnel WebSocket failed')), { once: true })
      })
      const route = { deviceId, clientId, ch }
      let bound: ClientSecureChannel | null = null
      const early: ChannelItem[] = []
      socket.addEventListener('message', event => {
        let frame: { t?: string; route?: { ch?: string }; n?: number; ct?: string; code?: string }
        try {
          frame = JSON.parse(String(event.data)) as typeof frame
        } catch {
          return
        }
        if (frame.route?.ch !== ch) return
        if (frame.t === 'tun' && typeof frame.n === 'number' && typeof frame.ct === 'string') {
          const item = { n: frame.n, ct: frame.ct }
          if (bound !== null) bound.receive(item)
          else early.push(item)
        } else if (frame.t === 'end') {
          bound?.ended(frame.code ?? 'closed')
        }
      })
      socket.addEventListener('close', () => bound?.ended('closed'))
      const channel = await ClientSecureChannel.connect(deviceId, fromB64url(devicePub), {
        crypto: nodeNoiseCrypto,
        identity,
        ch,
        wire: {
          send: item => socket.send(JSON.stringify({ t: 'tun', route, n: item.n, ct: item.ct })),
          end: code => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'end', route, ...(code !== undefined ? { code } : {}) }))
            socket.close()
          },
        },
        bind: created => {
          bound = created
          for (const item of early.splice(0)) created.receive(item)
        },
      })
      channel.onClose(error => {
        if (this.channels.get(deviceId) === opened) this.channels.delete(deviceId)
        this.log('debug', `agent channel to ${deviceId} closed: ${error.code}`)
      })
      return channel
    })()
    this.channels.set(deviceId, opened)
    opened.catch(() => {
      if (this.channels.get(deviceId) === opened) this.channels.delete(deviceId)
    })
    return opened
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
