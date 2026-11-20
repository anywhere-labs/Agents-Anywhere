// Session-scoped MCP, local routing, delegated device calls and parent notifications.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CollabSettingsHolder,
  GrantService,
  SupervisionService,
  ToolService,
} from '../application/collab/index.js'
import type { ConversationService } from '../application/conversation-service.js'
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
import { permissionLevelOf } from '../domain/collab/index.js'
import { type ControlPlane, type Egress, HttpError, requestJson } from '../link/index.js'
import { PeerGateway, type PeerRoute } from '../peer/gateway.js'
import { ServerRoute } from '../peer/server-route.js'
import { AgentToolsSocket } from '../tools/socket.js'

const BUSY = new Set(['pending', 'running', 'stopping'])

export interface CollabOptions {
  readonly deviceId: string
  readonly encryptionRequired: () => boolean
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
  const electron = process.versions.electron !== undefined
  return { command: (electron && process.env.AA_ELECTRON_NODE) || process.execPath, args: [script], env: electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} }
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
      encryptionRequired: options.encryptionRequired,
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
  }): void {
    this.conversation = deps.conversation
    const { deviceId, clock, store, ids, log } = this.options
    const local: PeerRoute = {
      request: async (_deviceId, actor, request) => {
        if (this.options.encryptionRequired()) return { status: 403, body: { detail: { code: 'agent_scope_denied' } } }
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
    const gateway = new PeerGateway({
      deviceId,
      local,
      server,
      directory: server.directory,
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
      available: () => !this.options.encryptionRequired(),
      onOutbox: this.options.onOutbox,
      onError: (supervisionId, error) => log('debug', `supervision ${supervisionId}: ${message(error)}`),
    })
    this.supervisions = supervisions
    this.tools = new ToolService({ deviceId, store, clock, ids, grants: this.grants, gateway, facts, supervisions })
    this.stopSettings = this.settings.onChange(() => void this.grants.reconcile().catch(error => log('warn', `collaboration settings: ${message(error)}`)))
  }


  /** `collab.signal`: target signals the Server forwarded. */
  public async onSignals(signals: readonly Record<string, unknown>[]): Promise<{ accepted: number }> {
    if (this.supervisions === null || this.options.encryptionRequired()) return { accepted: 0 }
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
    return { status: 503, body: { detail: { code: request.method === 'GET' ? 'device_offline' : 'command_outcome_unknown', message: message(error) } } }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
