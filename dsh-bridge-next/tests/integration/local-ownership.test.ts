// One Connector per computer (local-machine 2.0): Desktop's and the plugin's Connectors, both the v3 Connector,
// race for the machine and exactly one runs; the other's control channel stays usable and starts once it is free.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeshCallError } from 'meshcall'
import { localRuntimePath, readLocalState } from '../../src/host/desktop/local-runtime.js'
import { connectorTsInstalled, launchRpcConnector, v3RouterBinary } from '../helpers/ts-connector.js'

const routerBinary = v3RouterBinary()
const skip = !connectorTsInstalled ? 'connector-ts is not installed' : !routerBinary ? 'no meshcall 9334405 Router binary' : false
// Nothing listens here: a started Connector keeps retrying its Server.
const config = (id: string) => ({ serverUrl: 'http://127.0.0.1:9', connectorId: id, connectorToken: 'fixture' })

test('Desktop and plugin Connectors race: one runs, the other is refused and starts after the first exits', { timeout: 60_000, skip }, async t => {
  const home = await realpath(await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'aa-own-')))
  const previous = process.env['MESHCALL_ROUTER_BINARY']
  process.env['MESHCALL_ROUTER_BINARY'] = routerBinary
  const desktop = launchRpcConnector(home, 'desktop-workbench'), plugin = launchRpcConnector(home, 'dsh-plugin')
  t.after(async () => {
    await desktop.close(); await plugin.close()
    if (previous === undefined) delete process.env['MESHCALL_ROUTER_BINARY']
    else process.env['MESHCALL_ROUTER_BINARY'] = previous
    await rm(home, { recursive: true, force: true })
  })
  const [desktopControl, pluginControl] = await Promise.all([desktop.control(), plugin.control()])
  assert.equal((await desktopControl.getState({ timeoutMs: 10_000 })).running, false)
  assert.equal(readLocalState(localRuntimePath(home)).runtime, undefined, 'opening the control channel does not claim the machine')
  const results = await Promise.allSettled([
    desktopControl.start(config('desktop-id'), { timeoutMs: 20_000 }),
    pluginControl.start(config('plugin-id'), { timeoutMs: 20_000 }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, `desktop:\n${desktop.stderr}\nplugin:\n${plugin.stderr}`)
  const failure = (results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason
  assert.ok(failure instanceof MeshCallError)
  assert.equal(failure.code, 'connector_already_running')
  const [winner, loser] = results[0].status === 'fulfilled' ? [desktop, plugin] : [plugin, desktop]
  const [winnerId, loserId] = winner === desktop ? ['desktop-id', 'plugin-id'] : ['plugin-id', 'desktop-id']
  const file = localRuntimePath(home)
  assert.equal(readLocalState(file).runtime?.pid, winner.child.pid)
  assert.deepEqual(readLocalState(file).connectorIds, [winnerId])
  await winner.close()
  assert.equal((await (await loser.control()).start(config(loserId), { timeoutMs: 20_000 })).running, true)
  assert.equal(readLocalState(file).runtime?.pid, loser.child.pid)
  assert.deepEqual(readLocalState(file).connectorIds, [winnerId, loserId])
  await loser.close()
  assert.equal(readLocalState(file).runtime, undefined)
})
