/**
 * DSH-3 regression: this plugin (dsh-bridge 2.x) against the v3 TS Connector's
 * `dsh-bridge 2.0` compatibility layer (connector-ts/src/runtime/dsh-bridge2), the way
 * `runtime.test.ts` runs it against an in-process Bridge client.
 *
 * It is also the cross-version check from docs/v3 08 (risk table): the plugin keeps its own
 * meshcall 0.3.0 client while the Connector runs meshcall 9334405 and that version's Router.
 * Skipped when connector-ts is not installed next to this package or no 9334405 Router binary
 * is found (`MESHCALL_V3_ROUTER_BINARY`, else `/tmp/aa-mc/bin/meshcall-router`).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { bridgePath, nativeRuntime } from '../fixtures/native-runtime.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'

const connectorTs = new URL('../../../connector-ts/', import.meta.url)
const installed = existsSync(new URL('node_modules/meshcall/package.json', connectorTs))
const meshcallVersion = (base: URL) => (JSON.parse(readFileSync(new URL('node_modules/meshcall/package.json', base), 'utf8')) as { version: string }).version

/**
 * The Router binary of the Connector's meshcall (0.4.0-dev has no release to download): the same
 * lookup as connector-ts/test/support/mesh-harness.ts. Without one the test is skipped.
 */
function v3RouterBinary(): string | undefined {
  for (const path of [process.env.MESHCALL_V3_ROUTER_BINARY, process.env.MESHCALL_ROUTER_BINARY, '/tmp/aa-mc/bin/meshcall-router']) {
    if (!path) continue
    try { accessSync(path, constants.X_OK); return path } catch { /* next */ }
  }
  return undefined
}
const routerBinary = v3RouterBinary()
const skip = !installed ? 'connector-ts is not installed' : !routerBinary ? 'no meshcall 9334405 Router binary' : false

async function until(check: () => boolean | Promise<boolean>, label: string, attempts = 1500) {
  for (let n = 0; n < attempts; n++) { if (await check()) return; await delay(10) }
  assert.fail(label)
}

type Json = Record<string, unknown>
interface Notification { method: string, params: Json }

test('the plugin syncs and answers through the TS Connector 2.0 compatibility layer', { timeout: 60_000, skip }, async () => {
  // The point of the check: two meshcall versions on one local Router.
  assert.equal(meshcallVersion(new URL('../../', import.meta.url)), '0.3.0', 'the plugin keeps meshcall 0.3.0')
  assert.match(meshcallVersion(connectorTs), /9334405/, 'the Connector runs meshcall 9334405')
  const compat = await import(new URL('src/runtime/dsh-bridge2/index.ts', connectorTs).href) as typeof import('../../../connector-ts/src/runtime/dsh-bridge2/index.js')
  const storage = await import(new URL('src/store/index.ts', connectorTs).href) as typeof import('../../../connector-ts/src/store/index.js')
  const feeds = await import(new URL('src/sync/change-feed.ts', connectorTs).href) as typeof import('../../../connector-ts/src/sync/change-feed.js')
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-ts-'))
  // The Connector's real local store (SQLite) behind the 2.0 ledger; the recorder only watches.
  const store = storage.inProcessStore(storage.openSqliteStore({ dataDir: join(home, 'store'), durability: 'normal' }))
  const inner = new compat.StoreBridge2Ledger({ store, feed: new feeds.MemoryChangeFeed(), live: { emit: () => undefined }, runtimeId: 'rti_dsh',
    inventory: (method, params) => published.push({ method, params }) })
  const published: Notification[] = []
  const sessions = new Map<string, { meta: Json, items: Json[] }>()
  const state = new Map<string, Json>()
  const ledger: import('../../../connector-ts/src/runtime/dsh-bridge2/index.js').Bridge2Ledger = {
    async publish(notifications) { await inner.publish(notifications); published.push(...notifications) },
    async replaceSession(id, meta, items) { await inner.replaceSession(id, meta, items); sessions.set(id, { meta, items: [...items] }) },
    readState: key => inner.readState(key),
    async writeState(key, value) { await inner.writeState(key, value); state.set(key, value) },
    async deleteState(key) { await inner.deleteState(key); state.delete(key) },
  }
  let context: Awaited<ReturnType<typeof nativeRuntime>> | undefined
  let router: InstanceType<typeof compat.Bridge2Router> | undefined
  let runtime: InstanceType<typeof compat.Bridge2Runtime> | undefined
  try {
    context = await nativeRuntime(home)
    router = await compat.Bridge2Router.start({ home, binaryPath: routerBinary!, slot: { current: () => runtime?.relay } })
    assert.equal(router.rendezvousPath, bridgePath(home, 'connector.json'), 'publishes where the plugin looks')
    runtime = await compat.Bridge2Runtime.connect({ mesh: router.mesh, ledger, connectorId: 'connector-native-test',
      sessionNamespace: 'connector-native-test:instance-1' }, 20_000)
    const identity = runtime.initializeResult.identity as Json
    assert.equal(identity.protocolVersion, '2.0')
    assert.equal(runtime.features.syncMode, 'events')

    // Reads through the Bridge, as the v2 probe does.
    const listed = await runtime.request('listSessions', { limit: 1 })
    assert.ok(Array.isArray(listed.sessions))
    const main = sessionId('connector-native-test:instance-1', 'native-main')
    const snapshot = await runtime.request('getSessionSnapshot', { sessionId: main, externalSessionId: 'native-main' })
    assert.equal(snapshot.complete, true)

    // The event feed: a complete inventory, both captures committed locally, checkpoints stored.
    await until(() => published.some(n => n.method === 'session.inventory.complete' && n.params.complete === true), 'the baseline inventory completes')
    await until(() => sessions.has(main), 'native-main is captured')
    const persisted = sessionId('connector-native-test:instance-1', 'persisted-only')
    await until(() => sessions.has(persisted), 'persisted-only is captured')
    const paged: Json[] = []
    for (let cursor: unknown; ;) {
      const page = await runtime.request('getSessionSnapshot', { sessionId: persisted, externalSessionId: 'persisted-only', ...(cursor ? { cursor } : {}) })
      paged.push(...page.items as Json[])
      if (page.complete || !page.nextCursor) break
      cursor = page.nextCursor
    }
    assert.equal(paged.length, 1007)
    // The sync capture is the snapshot without turn markers (sync.ts drops turn.start/turn.end), every page included.
    assert.deepEqual(sessions.get(persisted)!.items.map(item => item.id),
      paged.filter(item => item.type !== 'turn.start' && item.type !== 'turn.end').map(item => item.id), 'a capture spanning many pages loses none')
    assert.equal(sessions.get(main)!.meta.title, '官方原生会话')
    await until(() => state.has('dsh/sync/checkpoints/native-main') && state.has('dsh/sync/checkpoints/persisted-only'), 'checkpoints are saved')
    const checkpoint = state.get('dsh/sync/checkpoints/native-main')!
    assert.equal(checkpoint.version, 1)
    assert.match(String(checkpoint.historyHash), /^[0-9a-f]{64}$/)

    // What landed in the local store: sessions with their facts, the whole capture, the checkpoints.
    assert.equal((await store.sessions.get(main))?.nativeTitle, '官方原生会话')
    assert.equal((await store.sessions.get(main))?.runtimeType, 'dsh')
    const stored: string[] = []
    for (let cursor: number | null = null; ;) {
      const page = await store.timeline.read(persisted, 'after', cursor, 500, 1 << 24)
      stored.push(...page.items.map(item => item.id))
      if (!page.hasMore || !page.items.length) break
      cursor = page.items.at(-1)!.orderSeq
    }
    assert.deepEqual(stored.sort(), sessions.get(persisted)!.items.map(item => String(item.id)).sort(), 'the store holds the capture')
    assert.deepEqual(await store.kv.get('rti_dsh', 'dsh/sync/checkpoints/native-main'), checkpoint)
  } finally {
    await runtime?.stop().catch(() => undefined)
    await router?.stop().catch(() => undefined)
    await store.close().catch(() => undefined)
    await context?.ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
