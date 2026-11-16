/**
 * DSH-3 regression: this plugin (dsh-bridge 2.x) against the v3 TS Connector's
 * `dsh-bridge 2.0` compatibility layer (connector-ts/src/runtime/dsh-bridge2), the way
 * `runtime.test.ts` runs it against the Python Connector probe. Skipped when
 * connector-ts has not been installed next to this package.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { bridgePath, nativeRuntime } from '../fixtures/native-runtime.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'

const connectorTs = new URL('../../../connector-ts/', import.meta.url)
const installed = existsSync(new URL('node_modules/meshcall/package.json', connectorTs))

async function until(check: () => boolean | Promise<boolean>, label: string, attempts = 1500) {
  for (let n = 0; n < attempts; n++) { if (await check()) return; await delay(10) }
  assert.fail(label)
}

type Json = Record<string, unknown>
interface Notification { method: string, params: Json }

test('the plugin syncs and answers through the TS Connector 2.0 compatibility layer', { timeout: 60_000, skip: !installed && 'connector-ts is not installed' }, async () => {
  const compat = await import(new URL('src/runtime/dsh-bridge2/index.ts', connectorTs).href) as typeof import('../../../connector-ts/src/runtime/dsh-bridge2/index.js')
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-ts-'))
  const published: Notification[] = []
  const sessions = new Map<string, { meta: Json, items: Json[] }>()
  const state = new Map<string, Json>()
  const ledger = {
    async publish(notifications: readonly Notification[]) { published.push(...notifications) },
    async replaceSession(id: string, meta: Json, items: readonly Json[]) { sessions.set(id, { meta, items: [...items] }) },
    async readState(key: string) { return state.get(key) },
    async writeState(key: string, value: Json) { state.set(key, value) },
    async deleteState(key: string) { state.delete(key) },
  }
  let context: Awaited<ReturnType<typeof nativeRuntime>> | undefined
  let router: InstanceType<typeof compat.Bridge2Router> | undefined
  let runtime: InstanceType<typeof compat.Bridge2Runtime> | undefined
  try {
    context = await nativeRuntime(home)
    router = await compat.Bridge2Router.start({ home, slot: { current: () => runtime?.relay } })
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
  } finally {
    await runtime?.stop().catch(() => undefined)
    await router?.stop().catch(() => undefined)
    await context?.ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
