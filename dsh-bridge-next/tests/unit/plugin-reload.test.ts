import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'meshcall'

const IDS = ['BridgePayload', 'BridgeSyncRequest', 'BridgeSyncEvent']

/**
 * zod 4.1 refuses a repeated id and later versions do not. There is no lockfile, and
 * all copies of zod in a process share one registry through globalThis, so the check
 * is enforced here to make the test hold whichever version is installed.
 */
test('importing the Bridge service again, as a plugin reload does, does not collide in the schema registry (#468)', async t => {
  const registry = z.globalRegistry as unknown as {
    add: (schema: unknown, meta?: { id?: string }) => unknown
    _idmap: Map<string, unknown>
  }
  const add = registry.add
  t.mock.method(registry, 'add', function (this: unknown, schema: unknown, meta?: { id?: string }) {
    if (meta?.id !== undefined && registry._idmap.has(meta.id)) throw new Error(`ID ${meta.id} already exists in the registry`)
    return add.call(this, schema, meta)
  })
  await import('../../src/host/dsh-runtime/bridge-service.ts?load=first')
  const first = IDS.map(id => registry._idmap.get(id))
  assert.ok(first.every(Boolean), 'the schemas keep their names for the MeshCall contract')
  await import('../../src/host/dsh-runtime/bridge-service.ts?load=second')
  const second = IDS.map(id => registry._idmap.get(id))
  assert.ok(second.every(Boolean))
  assert.notEqual(first[0], second[0], 'the reloaded module owns the names')
})
