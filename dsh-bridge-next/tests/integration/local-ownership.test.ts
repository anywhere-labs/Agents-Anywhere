import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { localRuntimePath, readLocalState } from '../../src/host/desktop/local-runtime.js'
import { launchConnector } from '../helpers/python-connector.js'

const config = (id: string) => ({ serverUrl: 'https://example.test', connectorId: id, connectorToken: 'fixture' })

test('Python Desktop and plugin race, CLI is excluded, and the same RPC channel retries after exit', { timeout: 20000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'aa-python-owners-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const desktop = launchConnector(home, 'desktop-workbench'), plugin = launchConnector(home, 'dsh-plugin')
  t.after(async () => { await desktop.close(); await plugin.close() })
  assert.equal((await desktop.request('connector.getState')).running, false)
  assert.equal(readLocalState(localRuntimePath(home)).runtime, undefined, 'Opening RPC does not claim ownership')
  const results = await Promise.allSettled([desktop.request('connector.start', config('desktop-id')), plugin.request('connector.start', config('plugin-id'))])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.equal(failure.reason.code, -32009)
  assert.equal(failure.reason.data.reason, 'connector_already_running')
  const winner = results[0].status === 'fulfilled' ? desktop : plugin
  const loser = winner === desktop ? plugin : desktop
  const winnerId = winner === desktop ? 'desktop-id' : 'plugin-id'
  const loserId = winner === desktop ? 'plugin-id' : 'desktop-id'
  const file = localRuntimePath(home)
  assert.equal(readLocalState(file).runtime?.pid, winner.child.pid)
  assert.equal(readLocalState(file).runtime?.childPid, undefined)
  assert.deepEqual(readLocalState(file).connectorIds, [winnerId])
  const cli = launchConnector(home, 'cli', 'start')
  t.after(() => cli.close())
  assert.equal((await once(cli.child, 'exit'))[0], 2)
  assert.match(cli.stderr, /Another Connector is running/)
  assert.deepEqual(readLocalState(file).connectorIds, [winnerId])
  await winner.close()
  assert.equal((await loser.request('connector.start', config(loserId))).running, true)
  assert.deepEqual(readLocalState(file).connectorIds, [winnerId, loserId])
  await loser.close(true)
  const next = launchConnector(home, 'cli', 'start')
  t.after(() => next.close())
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
  t.after(() => rm(home, { recursive: true, force: true }))
  const cli = launchConnector(home, 'cli', 'start')
  const clients = [launchConnector(home, 'desktop-workbench'), launchConnector(home, 'dsh-plugin')]
  t.after(async () => { await cli.close(); for (const client of clients) await client.close() })
  for (let i = 0; !cli.stderr.includes('backend-ready'); i++) { assert.ok(i < 300, cli.stderr); await delay(20) }
  for (const client of clients) {
    await assert.rejects(client.request('connector.acquireOwnership'), { code: -32009 })
    await assert.rejects(client.request('connector.start', config('blocked')), { code: -32009 })
    assert.equal((await client.request('connector.getState')).running, false)
  }
  assert.deepEqual(readLocalState(localRuntimePath(home)).connectorIds, ['cli-id'])
})
