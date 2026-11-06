import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { localRuntimePath, readLocalState } from '../../src/host/desktop/local-runtime.js'
import { launchConnector } from '../helpers/python-connector.js'

const config = (id: string) => ({ serverUrl: 'https://example.test', connectorId: id, connectorToken: 'fixture' })

function trackedConnectors(t: TestContext, home: string) {
  const children: ReturnType<typeof launchConnector>[] = []
  t.after(async () => {
    const results = await Promise.allSettled(children.map(child => child.close()))
    await rm(home, { recursive: true, force: true })
    for (const result of results) if (result.status === 'rejected') throw result.reason
  })
  return (...args: Parameters<typeof launchConnector>) => {
    const child = launchConnector(...args)
    children.push(child)
    return child
  }
}

test('Python Desktop and plugin race, CLI is excluded, and the same RPC channel retries after exit', { timeout: 20000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'aa-python-owners-'))
  const launch = trackedConnectors(t, home)
  const desktop = launch(home, 'desktop-workbench'), plugin = launch(home, 'dsh-plugin')
  assert.equal((await desktop.request('connector.getState')).running, false)
  assert.equal(readLocalState(localRuntimePath(home)).runtime, undefined, 'Opening RPC does not claim ownership')
  const results = await Promise.allSettled([desktop.request('connector.start', config('desktop-id')), plugin.request('connector.start', config('plugin-id'))])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.equal(failure.reason.code, 'connector_already_running',
    `${failure.reason.message}\ndesktop stderr:\n${desktop.stderr}\nplugin stderr:\n${plugin.stderr}`)
  assert.equal(failure.reason.details.reason, 'connector_already_running')
  const winner = results[0].status === 'fulfilled' ? desktop : plugin
  const loser = winner === desktop ? plugin : desktop
  const winnerId = winner === desktop ? 'desktop-id' : 'plugin-id'
  const loserId = winner === desktop ? 'plugin-id' : 'desktop-id'
  const file = localRuntimePath(home)
  assert.equal(readLocalState(file).runtime?.pid, winner.child.pid)
  assert.equal(readLocalState(file).runtime?.childPid, undefined)
  assert.deepEqual(readLocalState(file).connectorIds, [winnerId])
  const cli = launch(home, 'cli', 'start')
  assert.equal((await once(cli.child, 'exit'))[0], 2)
  assert.match(cli.stderr, /Another Connector is running/)
  assert.deepEqual(readLocalState(file).connectorIds, [winnerId])
  await winner.close()
  assert.equal((await loser.request('connector.start', config(loserId))).running, true)
  assert.deepEqual(readLocalState(file).connectorIds, [winnerId, loserId])
  await loser.close(true)
  const next = launch(home, 'cli', 'start')
  for (let i = 0; !next.stderr.includes('backend-ready'); i++) {
    assert.ok(i < 300, next.stderr)
    assert.equal(next.child.exitCode, null)
    await delay(20)
  }
  assert.equal(readLocalState(file).runtime?.pid, next.child.pid)
  assert.deepEqual(readLocalState(file).connectorIds, [winnerId, loserId, 'cli-id'])
  await next.close()
  assert.equal(readLocalState(file).runtime, undefined)
})

test('CLI ownership blocks both RPC launchers without killing their control channels', { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'aa-cli-owner-'))
  const launch = trackedConnectors(t, home)
  const cli = launch(home, 'cli', 'start')
  const clients = [launch(home, 'desktop-workbench'), launch(home, 'dsh-plugin')]
  for (let i = 0; !cli.stderr.includes('backend-ready'); i++) { assert.ok(i < 300, cli.stderr); await delay(20) }
  for (const client of clients) {
    await assert.rejects(client.request('connector.acquireOwnership'), { code: 'connector_already_running' })
    await assert.rejects(client.request('connector.start', config('blocked')), { code: 'connector_already_running' })
    assert.equal((await client.request('connector.getState')).running, false)
  }
  assert.deepEqual(readLocalState(localRuntimePath(home)).connectorIds, ['cli-id'])
})
