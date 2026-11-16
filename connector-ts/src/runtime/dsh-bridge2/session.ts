/**
 * `dsh-bridge 2.0` as a runtime: commands go to the plugin's `aa.dsh.v2.Bridge`, and the
 * plugin's already-projected notifications go to the local store through the sync relay.
 *
 * Implements the same `RuntimeSession` port as the ACP routes for commands. Its `events`
 * stream carries only `runtime.closed`: a 2.0 plugin projects turns, messages, tools and
 * notices itself, and those reach the store as platform notifications (`Bridge2Ledger`).
 *
 * Not carried over 2.0 by v3: image attachments. 2.0 sends Server upload references
 * (`fileId`/`uploadId`), which v3's inline `PromptInput.images` does not have; the
 * session reports `runtime.attachment` unsupported and rejects images.
 */
import { EventChannel } from '../profiles/dsh/events.js'
import type { Catalogs, CommandResult, ConfigChange, ConfigResult, DeliveryRef, InteractionAnswer, PromptAcceptance,
  PromptInput, RuntimeEvent, RuntimeSession, SessionCapabilities } from '../profiles/dsh/port.js'
import { Bridge2Client, BridgeRpcError, type MeshCalls } from './client.js'
import { Bridge2SyncRelay, type Bridge2Ledger, type Json, type RelayOptions } from './relay.js'

/** A 2.0 mutation the plugin answered with `{ok: false, code, message}`. */
export class Bridge2CommandError extends Error {
  constructor(readonly code: string, message: string, readonly result: Json = {}) { super(message) }
}

function answered(result: Json): Json {
  if (result.ok === false) throw new Bridge2CommandError(String(result.code ?? 'failed'), String(result.message ?? 'The DSH plugin refused the request.'),
    (result.result as Json | undefined) ?? {})
  return result
}

/** 2.0 selection keys a `ConfigChange` maps onto (the IDs are the AA selection IDs). */
const SELECTION_KEYS = new Set(['model', 'permission'])

export interface Bridge2RuntimeOptions {
  mesh: MeshCalls
  ledger: Bridge2Ledger
  connectorId: string
  sessionNamespace: string
  relay?: RelayOptions
  onLost?: (error: Error) => void
}

/** One connected 2.0 plugin: the Bridge client, its sync relay, and the sessions opened on it. */
export class Bridge2Runtime {
  readonly client: Bridge2Client
  readonly relay: Bridge2SyncRelay
  private readonly sessions = new Set<Bridge2Session>()
  private running: Promise<void> | undefined

  private constructor(options: Bridge2RuntimeOptions) {
    this.client = new Bridge2Client(options.mesh, { connectorId: options.connectorId, sessionNamespace: options.sessionNamespace,
      onLost: error => { this.closeSessions(`dsh_bridge_lost: ${error.message}`); options.onLost?.(error) } })
    this.relay = new Bridge2SyncRelay(options.ledger, this.client, options.relay)
  }

  /** Initialize the plugin (bounded discovery wait), then keep its event feed subscribed. */
  static async connect(options: Bridge2RuntimeOptions, discoveryBudgetMs?: number): Promise<Bridge2Runtime> {
    const runtime = new Bridge2Runtime(options)
    await runtime.client.start(discoveryBudgetMs)
    runtime.running = runtime.relay.run(() => runtime.client.connected)
    return runtime
  }

  get initializeResult(): Json { return this.client.initializeResult ?? {} }
  get features(): Json { return (this.initializeResult.features as Json | undefined) ?? {} }
  /** The plugin's event feed has ended for good (it went away); the caller reconnects. */
  get feed(): Promise<void> | undefined { return this.running }

  request(method: string, params?: Json): Promise<Json> { return this.client.request(method, params) }

  /**
   * A session on the plugin. Without `externalSessionId` the first prompt creates it
   * (`createAndStartSession`, whose native ID the plugin derives from `platformSessionId`).
   */
  async open(target: { platformSessionId: string, externalSessionId?: string, cwd: string, agentPreset?: string }): Promise<Bridge2Session> {
    const capabilities = await this.sessionCapabilities(target)
    const session = new Bridge2Session(this, target, capabilities, () => this.sessions.delete(session))
    this.sessions.add(session)
    return session
  }

  private async sessionCapabilities(target: { platformSessionId: string, externalSessionId?: string }): Promise<SessionCapabilities> {
    const raw = target.externalSessionId
      ? await this.request('getSessionCapabilities', { sessionId: target.platformSessionId, externalSessionId: target.externalSessionId })
      : await this.request('getRuntimeCapabilities')
    return capabilitiesOf(raw)
  }

  private closeSessions(reason: string): void {
    for (const session of [...this.sessions]) session.lost(reason)
  }

  async stop(): Promise<void> {
    this.closeSessions('runtime_stopped')
    await this.relay.close()
    await this.running?.catch(() => undefined)
  }
}

/** 2.0 capability sets (`{capabilities: [{capabilityId, supported, available?, metadata?}]}`) keyed by ID. */
export function capabilitiesOf(raw: Json): SessionCapabilities {
  const out: SessionCapabilities = {}
  const list = Array.isArray(raw.capabilities) ? raw.capabilities as Json[] : []
  for (const item of list) {
    const id = item.capabilityId ?? item.id
    if (typeof id !== 'string') continue
    const supported = item.supported === true
    out[id] = { supported, available: item.available === undefined ? supported : item.available === true,
      ...(item.metadata && typeof item.metadata === 'object' ? { metadata: item.metadata as Record<string, unknown> } : {}) }
  }
  // v3 sends images inline; 2.0 needs Server upload references (see the module comment).
  if (out['runtime.attachment']) out['runtime.attachment'] = { ...out['runtime.attachment'], supported: false, available: false }
  return out
}

export class Bridge2Session implements RuntimeSession {
  readonly events = new EventChannel<RuntimeEvent>()
  private external: string | undefined

  constructor(private readonly runtime: Bridge2Runtime,
    private readonly target: { platformSessionId: string, externalSessionId?: string, cwd: string, agentPreset?: string },
    readonly capabilities: SessionCapabilities, private readonly closed: () => void) {
    this.external = target.externalSessionId
  }

  /** Empty until the first prompt created the session on the plugin. */
  get externalSessionId(): string { return this.external ?? '' }

  private ids(): Json {
    return { sessionId: this.target.platformSessionId, ...(this.external ? { externalSessionId: this.external } : {}) }
  }

  async prompt(input: PromptInput, delivery: DeliveryRef): Promise<PromptAcceptance> {
    if (input.images?.length || input.files?.length) throw new Bridge2CommandError('UNSUPPORTED_OPERATION', 'This DSH plugin version cannot receive attachments from this Connector.')
    if (!input.text.trim()) throw new Bridge2CommandError('INVALID_PARAMS', 'A message needs text.')
    const create = !this.external
    // The plugin dedupes by clientMessageId and queues behind a running turn natively.
    const result = answered(await this.runtime.request(create ? 'createAndStartSession' : 'startTurn', {
      ...this.ids(), content: input.text, clientMessageId: delivery.clientMessageId, cwd: this.target.cwd,
      ...(create && this.target.agentPreset ? { agentPreset: this.target.agentPreset } : {}),
    }))
    if (typeof result.externalSessionId === 'string') this.external = result.externalSessionId
    return { status: 'accepted' }
  }

  async cancel(): Promise<void> {
    if (!this.external) return
    await this.runtime.request('interruptSession', this.ids())
  }

  async respond(interactionId: string, answer: InteractionAnswer): Promise<void> {
    answered(await this.runtime.request('respondInteraction', { ...this.ids(), noticeId: interactionId,
      actionId: answer.kind === 'option' ? answer.optionId : 'cancel' }))
  }

  async configure(change: ConfigChange): Promise<ConfigResult> {
    if (!SELECTION_KEYS.has(change.configId)) throw new Bridge2CommandError('INVALID_PARAMS', `DSH bridge 2.0 cannot change ${change.configId}.`)
    answered(await this.runtime.request('updateSelections', { ...this.ids(), selections: { [change.configId]: change.value } }))
    // 2.0 publishes catalog changes as `catalog.*.update` notifications through the sync feed.
    const catalogs: Catalogs = { entries: [] }
    return { catalogs }
  }

  async command(name: string, args?: unknown): Promise<CommandResult> {
    const result = await this.runtime.request('executeCommand', { ...this.ids(), command: name,
      ...(args === undefined ? {} : { args: Array.isArray(args) ? args : [String(args)] }) })
    return { ok: result.ok !== false, ...(typeof result.message === 'string' ? { message: result.message } : {}), data: result }
  }

  lost(reason: string): void {
    this.events.push({ type: 'runtime.closed', reason })
    this.events.end()
    this.closed()
  }

  async close(): Promise<void> {
    this.events.end()
    this.closed()
  }
}

export { BridgeRpcError }
