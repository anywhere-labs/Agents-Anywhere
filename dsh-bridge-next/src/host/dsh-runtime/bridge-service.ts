import { createRequire } from 'node:module'
import { MeshCallError, dependency, meta, mutates, query, service, stream, z, type RpcContext, type RpcLogger } from 'meshcall'
import type { SyncTransport } from './sync.js'
import { BridgeError, publicError } from './errors.js'
import { PROJECTION_VERSION } from './history.js'
import { RuntimeRouter, type SessionReader } from './router.js'
import { record } from './types.js'
import { errorDetails, type RuntimeDiagnostics } from './diagnostics.js'

export const BRIDGE_SERVICE = 'aa.dsh.v2.Bridge'
export const PROTOCOL_VERSION = '2.0'
/** Call metadata naming the caller's session namespace (1.0 sent it in `initialize`). */
export const NAMESPACE_METADATA = 'aa-session-namespace'

interface CallScope { namespace: string; logger: RpcLogger }
const callScope = dependency((namespace, context): CallScope => {
  if (typeof namespace !== 'string' || !namespace || namespace.length > 512) {
    throw new MeshCallError('INVALID_PARAMS', 'A runtime namespace is required.')
  }
  return { namespace, logger: context.logger }
}, { inject: [meta(NAMESPACE_METADATA)] })

function packageVersion(specifier: string): string {
  try { return String(createRequire(import.meta.url)(specifier).version) || 'unknown' }
  catch { return 'unknown' }
}

/** DSH packages share one release version and the Host resolves this peer to its own copy. */
const RUNTIME_VERSION = packageVersion('@deepseek-ai/dsh-typert-protocol/package.json')
const BRIDGE_VERSION = packageVersion('@agents-anywhere/dsh-bridge-next/package.json')

type Payload = Record<string, unknown>
// 2.0 keeps the 1.0 payload shapes (contracts/dsh-bridge/1.0); per-field schemas are a later revision.
const payload = z.looseObject({}).meta({ id: 'BridgePayload' })
const syncRequest = z.object({
  subscriptionId: z.string().min(1).max(128),
  checkpointVersion: z.int().optional(),
}).meta({ id: 'BridgeSyncRequest' })
const syncEvent = z.object({
  kind: z.literal('subscribed'),
  projectionVersion: z.int(),
  checkpointVersion: z.int().optional(),
}).meta({ id: 'BridgeSyncEvent' })

/** A plugin error as a MeshCall application error: the code is the 1.0 error name. */
export function bridgeFailure(error: unknown): MeshCallError {
  if (error instanceof MeshCallError) return error
  const failure = publicError(error)
  return new MeshCallError(failure.code, failure.message, { retryable: failure.retryable })
}

export interface BridgeBackend {
  reader: SessionReader
  diagnostics?: RuntimeDiagnostics
  /** The Connector's Sync transport for one subscription. */
  transportFor(subscriptionId: string): SyncTransport
}

/** `aa.dsh.v2.Bridge`: the DSH session runtime as the Connector calls it through the local Router. */
@service(BRIDGE_SERVICE, { description: 'DeepSeek Harness sessions for the Agents Anywhere Connector on this machine.' })
export class BridgeService {
  private readonly routers = new Map<string, RuntimeRouter>()

  constructor(private readonly backend: BridgeBackend) {}

  private routerFor(namespace: string): RuntimeRouter {
    let current = this.routers.get(namespace)
    if (!current) this.routers.set(namespace, current = new RuntimeRouter(this.backend.reader, namespace))
    return current
  }

  private async forward(method: string, request: Payload, call: CallScope, context: RpcContext): Promise<Payload> {
    try { return record(await this.routerFor(call.namespace).request(method, request, context.signal)) }
    catch (error) {
      call.logger.warning('rpc.rejected %s', JSON.stringify(errorDetails(error)))
      throw bridgeFailure(error)
    }
  }

  close(): void {
    // Open sync streams end promptly so a Mesh drain does not wait for them.
    for (const router of this.routers.values()) router.shutdown()
    this.routers.clear()
  }

  @query({ description: 'Identify the bridge and the features this DSH offers; checks the protocol major.', request: payload, response: payload })
  async initialize(request: Payload): Promise<Payload> {
    if (typeof request.protocolVersion !== 'string' || !request.protocolVersion.startsWith('2.') || request.runtime !== 'dsh') {
      throw new MeshCallError('PROTOCOL_VERSION_MISMATCH', 'The bridge requires DSH protocol 2.x.')
    }
    const reader = this.backend.reader
    return {
      identity: { runtime: 'dsh', runtimeVersion: RUNTIME_VERSION, bridgeVersion: BRIDGE_VERSION, protocolVersion: PROTOCOL_VERSION, displayName: 'DeepSeek Harness' },
      storage: { mode: 'dsh-native', sameSessionWriterLimit: 1, crossProcessWriterExclusion: false },
      features: { attachments: Boolean(reader.native?.ctx.get('sessionController') && reader.native.ctx.get('attachments')),
        sessionDiscovery: true, timelineSuffixRead: false, approval: reader.native?.approvals.available ?? false, userQuestions: reader.native?.questions.available ?? false,
        readOnly: !reader.native?.ctx.get('sessionController'), snapshotPagination: true, syncMode: reader.native ? 'events' : 'polling', projectionVersion: PROJECTION_VERSION },
    }
  }

  @query({ description: 'Answer while the bridge is serving.', request: payload, response: payload, inject: [callScope] })
  async ping(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('ping', request, call, context) }

  @query({ description: 'The runtime configuration the plugin applies.', request: payload, response: payload, inject: [callScope] })
  async getRuntimeConfig(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('getRuntimeConfig', request, call, context) }

  @query({ description: 'Runtime-wide capabilities.', request: payload, response: payload, inject: [callScope] })
  async getRuntimeCapabilities(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('getRuntimeCapabilities', request, call, context) }

  @query({ description: 'Workspaces DSH knows.', request: payload, response: payload, inject: [callScope] })
  async listWorkspaces(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('listWorkspaces', request, call, context) }

  @query({ description: 'One page of the session inventory; pass nextCursor to continue.', request: payload, response: payload, inject: [callScope] })
  async listSessions(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('listSessions', request, call, context) }

  @query({ description: 'One page of a session timeline snapshot.', request: payload, response: payload, inject: [callScope] })
  async getSessionSnapshot(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('getSessionSnapshot', request, call, context) }

  @query({ description: 'Status, selections and source state of a session.', request: payload, response: payload, inject: [callScope] })
  async getSessionState(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('getSessionState', request, call, context) }

  @query({ description: 'Open questions and approvals of a session.', request: payload, response: payload, inject: [callScope] })
  async getSessionNotices(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('getSessionNotices', request, call, context) }

  @query({ description: 'Capabilities of one session.', request: payload, response: payload, inject: [callScope] })
  async getSessionCapabilities(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('getSessionCapabilities', request, call, context) }

  @query({ description: 'Native commands available in a session.', request: payload, response: payload, inject: [callScope] })
  async listCommands(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('listCommands', request, call, context) }

  @query({ description: 'The model catalog.', request: payload, response: payload, inject: [callScope] })
  async listModels(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('listModels', request, call, context) }

  @query({ description: 'The permission catalog.', request: payload, response: payload, inject: [callScope] })
  async listPermissions(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('listPermissions', request, call, context) }

  @query({ description: 'Agent modes and the default for new sessions.', request: payload, response: payload, inject: [callScope] })
  async listAgentPresets(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('listAgentPresets', request, call, context) }

  @mutates({ description: 'Create a session and send its first message.', request: payload, response: payload, inject: [callScope] })
  async createAndStartSession(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('createAndStartSession', request, call, context) }

  @mutates({ description: 'Send a message to an existing session.', request: payload, response: payload, inject: [callScope] })
  async startTurn(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('startTurn', request, call, context) }

  @mutates({ description: 'Interrupt the running turn of a session.', request: payload, response: payload, inject: [callScope] })
  async interruptSession(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('interruptSession', request, call, context) }

  @mutates({ description: 'Change model, effort or permission selections of a session.', request: payload, response: payload, inject: [callScope] })
  async updateSelections(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('updateSelections', request, call, context) }

  @mutates({ description: 'Answer a question or approval notice.', request: payload, response: payload, inject: [callScope] })
  async respondInteraction(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('respondInteraction', request, call, context) }

  @mutates({ description: 'Run a native command in a session.', request: payload, response: payload, inject: [callScope] })
  async executeCommand(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('executeCommand', request, call, context) }

  @mutates({ description: 'Capture one session again, for example after it was quarantined.', request: payload, response: payload, inject: [callScope] })
  async refreshSync(request: Payload, call: CallScope, context: RpcContext): Promise<Payload> { return this.forward('refreshSync', request, call, context) }

  @stream({
    description: 'Run the event feed of the caller namespace while this call stays open; batches arrive through aa.dsh.v2.Sync.ingestBatch.',
    request: syncRequest, outputItem: syncEvent, inject: [callScope],
  })
  async *sync(request: z.infer<typeof syncRequest>, call: CallScope, context: RpcContext): AsyncIterable<z.infer<typeof syncEvent>> {
    const router = this.routerFor(call.namespace)
    let failure: unknown
    let stopped: () => void = () => undefined
    const ended = new Promise<void>(resolve => { stopped = resolve })
    const feed = router.subscribe(request.subscriptionId, request.checkpointVersion === 1,
      this.backend.transportFor(request.subscriptionId), error => {
        call.logger.bind({ subscriptionId: request.subscriptionId }).error('bridge.sync_failed %s', JSON.stringify(errorDetails(error)))
        failure = error
        stopped()
      })
    const onAbort = () => stopped()
    context.signal.addEventListener('abort', onAbort, { once: true })
    router.closed.addEventListener('abort', onAbort, { once: true })
    try {
      yield { kind: 'subscribed', projectionVersion: PROJECTION_VERSION, ...(request.checkpointVersion === 1 ? { checkpointVersion: 1 } : {}) }
      feed.start()
      await ended
      if (failure !== undefined) throw bridgeFailure(failure instanceof BridgeError ? failure : new BridgeError('INTERNAL_ERROR', 'DSH event sync stopped; resubscribe.', true))
    } finally {
      context.signal.removeEventListener('abort', onAbort)
      router.closed.removeEventListener('abort', onAbort)
      router.unsubscribe(feed)
    }
  }
}
