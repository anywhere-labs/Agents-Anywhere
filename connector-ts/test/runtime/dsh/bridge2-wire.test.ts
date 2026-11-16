/**
 * The 2.0 wire against a real MeshCall Router (DSH-3): a stand-in plugin registers
 * `aa.dsh.v2.Bridge` with the `dsh-bridge` key from the published rendezvous and calls
 * the TS Connector's `aa.dsh.v2.Sync` through the plugin's own generated client.
 * The full plugin runs against this layer in dsh-bridge-next `bridge2-ts-connector.test.ts`.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Mesh, MeshCallError, Router, mutates, query, service, stream, z, type RpcContext } from 'meshcall'
import { afterEach, describe, expect, test } from 'vitest'
import { Bridge2Router, Bridge2Runtime, CONNECTOR_METADATA, NAMESPACE_METADATA, checkpointKey,
  type Bridge2Rendezvous } from '../../../src/runtime/dsh-bridge2/index.js'
import { MemoryLedger } from '../../fixtures/bridge2-ledger.js'
import { SyncServiceClient } from '../../fixtures/dsh-sync-client.js'

const payload = z.looseObject({})
const syncRequest = z.object({ subscriptionId: z.string(), checkpointVersion: z.int().optional() })
const syncEvent = z.object({ kind: z.literal('subscribed'), projectionVersion: z.int(), checkpointVersion: z.int().optional() })

/** What the plugin's `aa.dsh.v2.Bridge` answers, recording what the Connector asked. */
@service('aa.dsh.v2.Bridge', { description: 'Stand-in DSH plugin.' })
class FakeBridge {
  readonly calls: { method: string, request: Record<string, unknown>, namespace: string | undefined, connector: string | undefined }[] = []
  subscriptions: string[] = []
  private readonly onSubscribe: ((id: string) => void)[] = []
  private readonly streams = new Set<() => void>()

  /** BridgeService.close(): open sync streams end so a Mesh drain does not wait for them. */
  stop(): void { for (const end of this.streams) end() }

  subscribed(): Promise<string> {
    const last = this.subscriptions.at(-1)
    return last ? Promise.resolve(last) : new Promise(resolve => this.onSubscribe.push(resolve))
  }

  private record(method: string, request: Record<string, unknown>, context: RpcContext) {
    this.calls.push({ method, request, namespace: context.metadata[NAMESPACE_METADATA], connector: context.metadata[CONNECTOR_METADATA] })
  }

  @query({ description: 'initialize', request: payload, response: payload })
  async initialize(request: Record<string, unknown>, context: RpcContext) {
    this.record('initialize', request, context)
    return { identity: { runtime: 'dsh', protocolVersion: '2.0', runtimeVersion: '0.2.2-rc.3', bridgeVersion: '2.4.0' }, features: { syncMode: 'events', projectionVersion: 3 } }
  }

  @query({ description: 'capabilities', request: payload, response: payload })
  async getRuntimeCapabilities(request: Record<string, unknown>, context: RpcContext) {
    this.record('getRuntimeCapabilities', request, context)
    return { capabilities: [
      { capabilityId: 'session.send_message', supported: true, available: true },
      { capabilityId: 'runtime.attachment', supported: true, available: true },
    ] }
  }

  @mutates({ description: 'create', request: payload, response: payload })
  async createAndStartSession(request: Record<string, unknown>, context: RpcContext) {
    this.record('createAndStartSession', request, context)
    return { accepted: true, sessionId: request.sessionId, externalSessionId: 'aa_native_1' }
  }

  @mutates({ description: 'turn', request: payload, response: payload })
  async startTurn(request: Record<string, unknown>, context: RpcContext) {
    this.record('startTurn', request, context)
    if (request.content === 'refuse') return { ok: false, code: 'session_unavailable', message: 'gone', result: { sessionId: request.sessionId } }
    return { accepted: true, sessionId: request.sessionId, externalSessionId: request.externalSessionId }
  }

  @mutates({ description: 'interrupt', request: payload, response: payload })
  async interruptSession(request: Record<string, unknown>, context: RpcContext) {
    this.record('interruptSession', request, context)
    throw new MeshCallError('SESSION_NOT_FOUND', 'no such session')
  }

  @mutates({ description: 'refresh', request: payload, response: payload })
  async refreshSync(request: Record<string, unknown>, context: RpcContext) {
    this.record('refreshSync', request, context)
    return { accepted: true }
  }

  @stream({ description: 'sync', request: syncRequest, outputItem: syncEvent })
  async *sync(request: z.infer<typeof syncRequest>, context: RpcContext) {
    this.subscriptions.push(request.subscriptionId)
    for (const resolve of this.onSubscribe.splice(0)) resolve(request.subscriptionId)
    yield { kind: 'subscribed' as const, projectionVersion: 3, checkpointVersion: request.checkpointVersion }
    await new Promise<void>(resolve => {
      const end = () => { this.streams.delete(end); resolve() }
      this.streams.add(end)
      context.signal.addEventListener('abort', end, { once: true })
    })
  }
}

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined) })

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'aa-b2-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ledger = new MemoryLedger()
  let runtime: Bridge2Runtime | undefined
  const router = await Bridge2Router.start({ home, slot: { current: () => runtime?.relay } })
  cleanups.push(() => router.stop())
  const rendezvous = JSON.parse(await readFile(router.rendezvousPath, 'utf8')) as Bridge2Rendezvous
  // The plugin: Mesh on the published endpoint with the published key, Bridge registered.
  const bridge = new FakeBridge()
  const plugin = new Mesh(new Router(rendezvous.endpoint), { token: rendezvous.key, peerId: 'plugin' })
  plugin.mount(bridge, { instanceId: 'plugin' })
  const serving = await plugin.startServing()
  cleanups.push(async () => { await serving.close(); await plugin.close() })
  runtime = await Bridge2Runtime.connect({ mesh: router.mesh, ledger, connectorId: 'conn_1', sessionNamespace: 'ns_1' }, 5_000)
  cleanups.push(() => runtime!.stop())
  return { home, router, rendezvous, bridge, plugin, ledger, runtime, sync: new SyncServiceClient(plugin) }
}

const batch = (subscriptionId: string, batchSeq: number, id: string) => ({ subscriptionId, batchSeq, projectionVersion: 3,
  operations: [{ kind: 'notifications', notifications: [{ method: 'timeline.itemUpsert', params: { sessionId: 's1', item: { id, sessionId: 's1', type: 'message', status: 'completed' } } }] }] })

describe('dsh-bridge 2.0 over a real MeshCall Router (DSH-3)', () => {
  test('rendezvous is the 2.0 document, private, and removed on stop', async () => {
    const { router, rendezvous } = await setup()
    expect(rendezvous).toMatchObject({ version: 2, protocol: 'meshcall', pid: process.pid, instanceId: router.instanceId })
    expect(rendezvous.key).toMatch(/^mk_dsh-bridge_[0-9a-f]{64}$/)
    expect((await stat(router.rendezvousPath)).mode & 0o777).toBe(0o600)
    await router.stop()
    await expect(stat(router.rendezvousPath)).rejects.toThrow()
  })

  test('initialize carries the namespace metadata, and the feed subscribes with durable checkpoints', async () => {
    const { bridge, runtime } = await setup()
    expect(bridge.calls[0]).toMatchObject({ method: 'initialize', namespace: 'ns_1', connector: 'conn_1', request: { protocolVersion: '2.0', runtime: 'dsh' } })
    expect(runtime.features).toMatchObject({ syncMode: 'events' })
    expect(await bridge.subscribed()).toMatch(/^[0-9a-f]{32}$/)
  })

  test('the plugin\'s generated Sync client: batches, redelivery, snapshot stream, checkpoints, unknown subscription', async () => {
    const { bridge, ledger, sync, runtime } = await setup()
    const id = await bridge.subscribed()
    await sync.ingestBatch(batch(id, 1, 'a'), { idempotencyKey: `dsh-${id}-1` })
    // A batch whose answer was lost is resent with a fresh key; it is acknowledged, not reapplied.
    await sync.ingestBatch(batch(id, 1, 'a'), { idempotencyKey: `dsh-${id}-1-1` })
    await sync.ingestBatch(batch(id, 2, 'b'), { idempotencyKey: `dsh-${id}-2` })
    expect(ledger.published.map(n => (n.params.item as { id: string }).id)).toEqual(['a', 'b'])

    async function* pages() {
      yield { captureId: 'cap-1', items: [{ id: 'x', sessionId: 's2', type: 'message' }] }
      yield { captureId: 'cap-1', items: [{ id: 'y', sessionId: 's2', type: 'message' }] }
    }
    const result = await sync.ingestSnapshot({ captureId: 'cap-1', subscriptionId: id, sessionId: 's2', meta: { externalSessionId: 'ext2' }, throughSeq: 9 }, pages())
    expect(result).toMatchObject({ accepted: true })
    expect(ledger.sessions.get('s2')?.items.map(item => item.id)).toEqual(['x', 'y'])

    const checkpoint = { version: 1, projectionVersion: 3, throughSeq: 9, historyHash: 'f'.repeat(64), settled: true }
    await sync.saveCheckpoint(id, 'ext2', checkpoint)
    expect(ledger.state.get(checkpointKey('ext2'))).toEqual(checkpoint)
    expect((await sync.loadCheckpoint(id, 'ext2')).checkpoint).toEqual(checkpoint)
    await sync.deleteCheckpoint(id, 'ext2')
    expect((await sync.loadCheckpoint(id, 'ext2')).checkpoint).toBeNull()

    const unknown = await sync.ingestBatch(batch('not-a-subscription', 1, 'z')).catch(error => error)
    expect(unknown).toBeInstanceOf(MeshCallError)
    expect(unknown.code).toBe('subscription_unknown')
    await runtime.stop()
  })

  test('commands map onto the 2.0 Bridge methods; refusals and plugin errors surface with their codes', async () => {
    const { bridge, runtime } = await setup()
    const session = await runtime.open({ platformSessionId: 'sess_1', cwd: '/w' })
    expect(session.capabilities['session.send_message']?.supported).toBe(true)
    expect(session.capabilities['runtime.attachment']?.supported).toBe(false)
    await expect(session.prompt({ text: 'x', images: [{ mimeType: 'image/png', data: '' }] }, { clientMessageId: 'm0', nativeRequestId: 'm0' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })
    expect(await session.prompt({ text: 'hello' }, { clientMessageId: 'm1', nativeRequestId: 'm1' })).toEqual({ status: 'accepted' })
    expect(session.externalSessionId).toBe('aa_native_1')
    expect(await session.prompt({ text: 'again' }, { clientMessageId: 'm2', nativeRequestId: 'm2' })).toEqual({ status: 'accepted' })
    await expect(session.prompt({ text: 'refuse' }, { clientMessageId: 'm3', nativeRequestId: 'm3' })).rejects.toMatchObject({ code: 'session_unavailable' })
    await expect(session.cancel()).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    const sent = bridge.calls.filter(call => ['createAndStartSession', 'startTurn'].includes(call.method))
    expect(sent[0]).toMatchObject({ method: 'createAndStartSession', request: { sessionId: 'sess_1', content: 'hello', clientMessageId: 'm1', cwd: '/w' } })
    expect(sent[1]).toMatchObject({ method: 'startTurn', request: { sessionId: 'sess_1', externalSessionId: 'aa_native_1', content: 'again' } })
    expect(sent.every(call => call.namespace === 'ns_1')).toBe(true)
  })

  test('the plugin going away closes open sessions with runtime.closed', async () => {
    const { runtime, plugin, bridge } = await setup()
    const session = await runtime.open({ platformSessionId: 'sess_1', cwd: '/w' })
    bridge.stop()
    await plugin.close()
    await expect(runtime.request('ping')).rejects.toThrow()
    const events = []
    for await (const event of session.events) events.push(event)
    expect(events).toEqual([expect.objectContaining({ type: 'runtime.closed' })])
  })
})

