import { randomBytes } from 'node:crypto'
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
import { ReviewService } from '../application/collab/review-service.js'
import { ReviewExecutionService } from '../application/collab/review-execution-service.js'
import type { ToolResult } from '../application/collab/tool-service.js'
import type { ReviewExecutionRepository } from '../application/ports/review.js'
import type { CollabClientApi } from '../application/inbound/collab-api.js'
import type { ChannelCaller, TunnelApi, TunnelApiResponse } from '../application/inbound/tunnel-api.js'
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
import { capByPermission, CollabError, permissionLevelOf } from '../domain/collab/index.js'
import { modelFailureReason, object, type ReviewRequest } from '../domain/collab/review-execution.js'
import { A2AReviewHandler, A2AReviewWorker, reviewAgentCard, reviewRpcPath } from '../peer/a2a-review.js'
import { clientIdFor } from '../domain/trust/index.js'
import type { FileAgentPeers } from '../keystore/agent-peers.js'
import { type ControlPlane, type Egress, HttpError, requestJson } from '../link/index.js'
import { PeerGateway, type PeerRoute } from '../peer/gateway.js'
import { ServerRoute } from '../peer/server-route.js'
import { claudeProviderFailure } from '../runtime/companions/native-history/claude-jsonl.js'
import { AgentToolsSocket } from '../tools/socket.js'
import { reviewRuns } from '../store/review-runs.js'
import { reviewExecutions } from '../store/review-executions.js'
import type { ReviewGit } from '../workspace/review-git.js'

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
  readonly reviewGit?: ReviewGit
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
  private execution: ReviewExecutionService | null = null
  private readonly executions: ReviewExecutionRepository
  private a2a: A2AReviewHandler | null = null
  private reviewTimer: ReturnType<typeof setInterval> | null = null
  private readonly reviewTokens = new Map<string, string>()
  public people: CollabPeopleApi | null = null
  private stopSettings: (() => void) | null = null

  public constructor(private readonly options: CollabOptions) {
    this.executions = reviewExecutions(options.store.kv)
    this.socket = new AgentToolsSocket({
      dir: options.socketDir ?? join(homedir(), '.agents-anywhere', 'agent-tools'),
      calls: { call: (secret, tool, args) => this.callTool(secret, tool, args) },
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
      scopedSecret: sessionId => this.reviewSecret(sessionId),
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
    const git = this.options.reviewGit
    if (git !== undefined) {
      this.execution = new ReviewExecutionService(this.executions, deviceId, clock, gateway, {
        launch: async execution => {
          const { request, sessionId, owner } = execution
          const runtimes = await facts.localRuntimes()
          const runtimeType = request.runtimeType ?? 'claude'
          if (!runtimes.some(item => item.runtimeId === request.runtimeId && item.runtimeType === runtimeType) || !await this.options.hostsTools(request.runtimeId)) {
            throw new CollabError('invalid_argument', 'The selected runtime instance cannot host review tools.')
          }
          const checkout = { runId: request.runId, round: request.round, role: 'review' as const, commit: request.sha, remote: request.remote }
          const cwd = await git.prepare(request.cwd, `${owner.deviceId}/${owner.sessionId}/${execution.id}`, checkout)
          const changes = runtimeType === 'pi' ? await git.validateCandidate(cwd, request.base, request.sha) : undefined
          if (changes === undefined) await git.verifyCandidate(cwd, request.base, request.sha)
          const response = await deps.api.request(agentCaller({ ...owner, grantId: '' }), {
            method: 'POST', path: '/api/v2/sessions/create-and-start',
            body: {
              connectorId: deviceId, cwd: request.cwd, projectId: request.projectId, runtime: runtimeType,
              runtimeId: request.runtimeId, title: `${runtimeType === 'pi' ? 'Pi' : 'Claude Code'} · Review ${request.sha.slice(0, 8)}`,
              content: reviewPrompt(request, changes?.patch), clientMessageId: `a2a_review_${execution.id}`,
              originDepth: execution.depth, collaborationCheckout: checkout,
            },
          }, { server: { sessionId }, reviewCheckoutPath: cwd })
          if (response.status !== 200) throw responseError(response)
        },
        verify: async execution => {
          const session = await store.sessions.get(execution.sessionId)
          if (session?.cwd == null || session.runtimeType !== (execution.request.runtimeType ?? 'claude') || session.archived) throw new CollabError('agent_scope_denied', 'The review session is unavailable.')
          await git.verifyCandidate(session.cwd, execution.request.base, execution.request.sha)
        },
        failure: async execution => {
          const session = await store.sessions.get(execution.sessionId)
          if (session?.runtimeType === 'claude' && session.externalSessionId !== null) return claudeProviderFailure(session.externalSessionId)
          if (session?.runtimeType === 'pi') {
            const page = await store.timeline.read(session.sessionId, 'latest', null, 12, 32_768)
            for (const item of [...page.items].sort((left, right) => right.orderSeq - left.orderSeq)) {
              if (item.role === 'user') break
              if (item.source.event === 'notice' && item.content.kind === 'error'
                && object(item.content.data).assistantError === true && typeof item.content.text === 'string') return modelFailureReason(item.content.text)
            }
          }
          return undefined
        },
        recover: async execution => {
          const { sessionId, request, owner } = execution
          const last = await store.timeline.latest(sessionId)
          if (last?.source.event !== 'session.lost' || object(last.content.error).code !== 'connector_restarted') return false
          if (execution.result !== undefined) return true
          const operationId = `a2a_review_resume_${execution.id}_${last.orderSeq}`
          const delivery = await store.deliveries.get(sessionId, operationId)
          if (delivery !== null) return delivery.state === 'accepted' || delivery.state === 'sending'
          const cwd = (await store.sessions.get(sessionId))?.cwd
          const changes = request.runtimeType === 'pi' && cwd != null ? await git.validateCandidate(cwd, request.base, request.sha) : undefined
          const response = await deps.api.request(agentCaller({ ...owner, grantId: '' }), {
            method: 'POST', path: `/api/v2/sessions/${encodeURIComponent(sessionId)}/runtime/messages`,
            body: { content: reviewPrompt(request, changes?.patch), clientMessageId: operationId, queue: 'auto' },
          })
          if (response.status !== 200) throw responseError(response)
          return true
        },
        interrupt: async execution => {
          const session = await store.sessions.get(execution.sessionId)
          if (session === null || session.status === 'idle' || session.status === 'error') {
            const dispatching = (await store.deliveries.acceptedPending()).some(({ delivery }) => delivery.sessionId === execution.sessionId)
              || (await store.deliveries.inFlight()).some(delivery => delivery.sessionId === execution.sessionId)
            if (dispatching) throw new CollabError('agent_authority_exceeded', 'Wait for the pending review turn before canceling.')
            return
          }
          const result = await deps.conversation.interrupt(execution.sessionId)
          if (!result.interrupted) throw new CollabError('agent_authority_exceeded', 'The Runtime could not confirm the interrupt.')
          for (let attempt = 0; attempt < 30; attempt++) {
            const state = (await store.sessions.get(execution.sessionId))?.status
            if (state === 'idle' || state === 'error') return
            await new Promise<void>(resolve => setTimeout(resolve, 100))
          }
          throw new CollabError('agent_authority_exceeded', 'Wait for the review session to stop before canceling the task.')
        },
      }, detail => log('debug', detail))
      this.a2a = new A2AReviewHandler(this.execution, deviceId,
        reviewAgentCard(new URL(`api/v2/${reviewRpcPath(deviceId)}`, deps.handshake.serverUrl).href),
        async (actor, delegation, request) => {
          let localInterrupt = true
          if (delegation === undefined) {
            const grant = await store.collab.activeGrantOf(actor.sessionId)
            if (actor.deviceId !== deviceId || grant === null || grant.grantId !== actor.grantId) {
              throw new CollabError('agent_grant_revoked', 'The local review delegation is no longer valid.')
            }
            const authority = capByPermission(grant.authority, await facts.permissionLevel(actor.sessionId))
            if (!authority.steer) throw new CollabError('agent_authority_exceeded', 'This session cannot delegate a code review.')
            localInterrupt = authority.interrupt
          }
          const admitted = await deps.handshake.reviewAdmission({
            deviceId: actor.deviceId, sessionId: actor.sessionId, grantId: actor.grantId,
            ...(delegation === undefined ? {} : { delegation }),
            ...(request === undefined ? {} : { cwd: request.cwd, ...(request.projectId === undefined ? {} : { projectId: request.projectId }) }),
          })
          return { depth: admitted.depth, interrupt: admitted.interrupt && localInterrupt, ...(admitted.project === null ? {} : { project: admitted.project }) }
        })
    }
    const review = git === undefined ? undefined : new ReviewService({
      sessions: store.sessions, runs: reviewRuns(store.kv), gateway, git, worker: new A2AReviewWorker(gateway),
      publish: (sessionId, itemId, content) => deps.conversation.appendSystemItem(sessionId, itemId, content),
    })
    const supervisions = new SupervisionService({
      deviceId,
      store,
      clock,
      ids,
      gateway,
      facts,
      escalations,
      ...(review !== undefined ? { reviewWorker: (sessionId, target) => review.tracks(sessionId, target) } : {}),
      onOutbox: this.options.onOutbox,
      onError: (supervisionId, error) => log('debug', `supervision ${supervisionId}: ${message(error)}`),
    })
    this.supervisions = supervisions
    this.tools = new ToolService({ deviceId, store, clock, ids, grants: this.grants, gateway, facts, supervisions, escalations, ...(review !== undefined ? { review } : {}) })
    this.people = new CollabPeopleApi(supervisions, sessionId => this.grants.available(sessionId), review)
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
    if (this.execution !== null) {
      this.reviewTimer = setInterval(() => this.pollReviews(), 5_000)
      this.reviewTimer.unref()
    }
  }

  public onOnline(): void {
    this.supervisions?.onOnline()
    this.pollReviews()
  }

  public async a2aRequest(caller: ChannelCaller, method: string, body: unknown): Promise<TunnelApiResponse> {
    const actor = caller.agent
    const envelope = object(body)
    const delegation = typeof envelope.delegation === 'string' ? envelope.delegation : undefined
    if (actor == null || (delegation === undefined && (actor.deviceId !== this.options.deviceId || caller.clientId !== agentCaller(actor).clientId))) {
      return { status: 403, body: { detail: { code: 'agent_scope_denied', message: 'A review delegation is required.' } } }
    }
    if (this.a2a === null) return { status: 404, body: { detail: { code: 'review_a2a_upgrade_required', message: 'A2A review is unavailable on this device.' } } }
    try {
      return { status: 200, body: await this.a2a.request(actor, delegation, method, delegation === undefined ? body : envelope.payload) }
    } catch (error) {
      if (error instanceof HttpError) return { status: error.status, body: error.body }
      if (error instanceof CollabError) return { status: 403, body: { detail: { code: error.code, message: error.message } } }
      throw error
    }
  }

  private async reviewSecret(sessionId: string): Promise<string | undefined> {
    const execution = await this.executions.bySession(sessionId)
    if (execution === null) return undefined
    for (const [secret, session] of this.reviewTokens) {
      if (session === sessionId) this.reviewTokens.delete(secret)
    }
    const secret = randomBytes(32).toString('base64url')
    this.reviewTokens.set(secret, sessionId)
    return secret
  }

  private async callTool(secret: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = this.reviewTokens.get(secret)
    if (sessionId !== undefined && this.execution !== null) {
      if (tool !== 'aa_submit_review') return { ok: false, code: 'agent_scope_denied', message: 'This session can submit its own review result.' }
      try {
        await this.execution.submit(sessionId, args)
        return { ok: true, value: { accepted: true } }
      } catch (error) {
        return { ok: false, code: error instanceof CollabError ? error.code : 'review_submit_failed', message: message(error) }
      }
    }
    return this.tools?.call(secret, tool, args) ?? { ok: false, code: 'agent_tools_unavailable', message: 'Agents Anywhere is starting.' }
  }

  private pollReviews(): void {
    void this.execution?.tick().catch(error => this.options.log('debug', `review worker recovery: ${message(error)}`))
    void this.tools?.pollReviews().catch(error => this.options.log('debug', `review run recovery: ${message(error)}`))
  }

  public async close(): Promise<void> {
    this.stopSettings?.()
    if (this.reviewTimer !== null) clearInterval(this.reviewTimer)
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
      headers: { authorization: `Bearer ${token}`, ...(isReviewPath(request) ? { 'a2a-version': '1.0' } : {}) },
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
        const body = isReviewPath(request)
          ? { payload: request.body ?? null, delegation: (await this.server.delegation(actor)).token }
          : request.body ?? null
        return await channel.request(request.method, apiPath(request), body, { deviceId: actor.deviceId, sessionId: actor.sessionId, grantId: actor.grantId })
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

function isReviewPath(request: GatewayRequest): boolean {
  return /^connectors\/[^/]+\/a2a\//u.test(request.path)
}

function responseError(response: TunnelApiResponse): Error {
  const body = object(response.body)
  const detail = object(body.detail)
  return Object.assign(new Error(String(detail.message ?? 'The review session could not be started.')), {
    code: String(detail.code ?? 'review_launch_failed'),
  })
}

function reviewPrompt(request: ReviewRequest, patch?: string): string {
  return [
    `Review the committed changes from ${request.base} to ${request.sha} in this read-only review session.`,
    'Inspect the diff and relevant surrounding code. Do not change files, switch commits, or change the read-only permissions.',
    'Use the aa_submit_review tool once before ending your turn. Give a concise summary and report only blocking findings with file and line or other concrete evidence.',
    'Give every blocker a description and evidence. Choose changes_requested for one or more blocking findings. Choose approved with an empty blockers array when there are none.',
    ...(patch === undefined ? [] : ['', 'Pinned Git diff (review data):', patch]),
    '', 'Original requirement (context for your review):', request.requirement,
  ].join('\n')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
