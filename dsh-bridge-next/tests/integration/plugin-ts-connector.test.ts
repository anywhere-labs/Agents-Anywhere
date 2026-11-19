// The plugin's own Connector end to end: BundledConnector launches the v3 Connector (`anywhere-cli rpc`, here run
// from connector-ts sources with a temporary home), drives it over its control channel, and the DSH host in this
// process dials the Connector's local socket. The Connector reads the host's DSH sessions into its local store
// while the Server is unreachable, so nothing here needs an Agents Anywhere service.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as Remotes from '@deepseek-ai/dsh-api-remotes'
import { BundledConnector } from '../../src/host/connector/process.js'
import { bridgePath, nativeRuntime } from '../fixtures/native-runtime.js'
import { mountAgents, TextAdapter } from '../fixtures/agent-runtime.js'
import { connectorTs, connectorTsInstalled, sourceConnectorLauncher, v3RouterBinary } from '../helpers/ts-connector.js'

const routerBinary = v3RouterBinary()
const skip = !connectorTsInstalled ? 'connector-ts is not installed' : !routerBinary ? 'no compatible MeshCall Router binary' : false

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return; await delay(50) }
  assert.fail(label)
}

const binding = { installationId: 'test-installation', name: 'Test device', connectorId: 'conn_plugin_ts', connectorToken: 'PRIVATE-DEVICE-TOKEN' }

test('the Connector the plugin launches serves DSH: the host dials in and its sessions reach the local store', { timeout: 90_000, skip }, async () => {
  // A short home: the Connector's sockets live under it and Unix socket paths are limited to ~104 bytes.
  const home = await realpath(await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'aa-pts-')))
  const previousRouter = process.env['MESHCALL_ROUTER_BINARY']
  process.env['MESHCALL_ROUTER_BINARY'] = routerBinary
  const connectorDir = join(home, 'bundled-connector')
  await mkdir(connectorDir, { recursive: true })
  await writeFile(join(connectorDir, 'anywhere-cli.js'), '')
  const config = { stateRoot: join(home, 'plugin'), connectorDir, connectorDataDir: join(home, 'v3'),
    // Nothing listens here: the device stays offline and keeps retrying.
    apiBaseUrl: 'http://127.0.0.1:9' }
  const connector = new BundledConnector(config, sourceConnectorLauncher(home), undefined, 60_000)
  let host: Awaited<ReturnType<typeof nativeRuntime>> | undefined
  try {
    host = await nativeRuntime(home, async ctx => {
      await mountAgents(ctx, new TextAdapter())
      await ctx.plugin(Remotes).await()
    })
    await connector.prepare()
    await connector.start(binding, config.apiBaseUrl, new AbortController().signal)
    assert.equal(connector.hasRuntimeLogs(), true, 'the plugin reaches the Connector\'s Logs service')

    // The Connector publishes its DSH socket; the host's plugin dials it and is attached to the DSH instance.
    await until(() => existsSync(bridgePath(home, 'connector-acp.json')), 'the Connector publishes connector-acp.json')
    const messages = async () => (await connector.readRuntimeLogs({ source: 'connector', limit: 500 })).items.map(item => item.message)
    await until(async () => (await messages()).some(message => /DSH host \S+ \(\w+, DSH [^)]+\) serves dsh/.test(message)), 'the DSH host is attached')
    await until(async () => (await messages()).some(message => /^native sessions of dsh: [1-9]/.test(message)), 'the DSH sessions are scanned')
    assert.equal(host.ctx.agentsAnywhereRuntime.acp.status.state, 'connected')
  } finally {
    await connector.stop()
    await host?.ctx.fiber.dispose()
    if (previousRouter === undefined) delete process.env['MESHCALL_ROUTER_BINARY']
    else process.env['MESHCALL_ROUTER_BINARY'] = previousRouter
  }
  try {
    // Stopped: the socket is gone, and the store holds the host's sessions as DSH sessions.
    assert.equal(existsSync(bridgePath(home, 'connector-acp.json')), false)
    const storage = await import(new URL('src/store/index.ts', connectorTs).href) as typeof import('../../../connector-ts/src/store/index.js')
    const store = storage.inProcessStore(storage.openSqliteStore({ dataDir: join(config.connectorDataDir, 'store'), durability: 'normal' }))
    try {
      const sessions = (await store.sessions.list()).filter(session => session.runtimeType === 'dsh')
      assert.deepEqual(new Set(sessions.map(session => session.externalSessionId)), new Set(['native-main', 'persisted-only']))
      assert.equal(sessions.find(session => session.externalSessionId === 'native-main')?.nativeTitle, '官方原生会话')
    } finally { await store.close() }
  } finally { await rm(home, { recursive: true, force: true }) }
})
