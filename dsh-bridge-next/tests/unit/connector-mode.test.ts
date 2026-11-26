import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { AttachedConnector, EXTERNALLY_MANAGED, connectorOutputDirectory } from '../../src/host/connector/attached.js'
import { readConnectorLogs } from '../../src/host/connector/logs.js'
import { SourceConnector } from '../../src/host/connector/process.js'
import { DEFAULT_CONNECTOR_SETTINGS } from '../../src/contracts/connector.js'
import { resolveConfig } from '../../src/host/config.js'
import { OnboardingManager } from '../../src/host/onboarding/manager.js'

test('connectorMode is validated, and only present when it is not the default', () => {
  assert.equal(resolveConfig({}).connectorMode, undefined)
  assert.equal(resolveConfig({ connectorMode: 'managed' }).connectorMode, undefined)
  assert.equal(resolveConfig({ connectorMode: 'attached' }).connectorMode, 'attached')
  assert.equal(resolveConfig({ connectorMode: '' }).connectorMode, undefined, 'blank is unset')
  assert.equal(resolveConfig({ connectorMode: '  ' }).connectorMode, undefined, 'blank is unset')
  assert.throws(() => resolveConfig({ connectorMode: 'Attached' }), /connectorMode/)
  assert.throws(() => resolveConfig({ connectorMode: 'system' }), /connectorMode/)
})

async function fixture(t: TestContext, connectorMode?: string) {
  const root = await mkdtemp(join(tmpdir(), 'aa-mode-'))
  const manager = new OnboardingManager({
    stateRoot: root, connectorSourceDir: root, uvPath: 'uv', apiBaseUrl: 'https://api.example.test',
    ...(connectorMode ? { connectorMode } : {}),
  }, { detect: async () => ({ status: 'absent', message: 'not registered' }) })
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, manager, connector: (manager as unknown as { connector: unknown }).connector }
}

test('managed, the default, still runs the bundled Connector', async t => {
  const h = await fixture(t)
  assert.ok(h.connector instanceof SourceConnector)
  assert.equal((await h.manager.inspect()).connector.externallyManaged, false)
})

test('attached follows a Connector instead, and keeps the plugin off it', async t => {
  const h = await fixture(t, 'attached')
  assert.ok(h.connector instanceof AttachedConnector)
  assert.equal((await h.manager.inspect()).connector.externallyManaged, true)
  await assert.rejects(h.manager.controlConnector('stop'), { message: EXTERNALLY_MANAGED.stop })
  await assert.rejects(h.manager.controlConnector('restart'), { message: EXTERNALLY_MANAGED.stop })
  await assert.rejects(h.manager.resetConnector(false), { message: EXTERNALLY_MANAGED.reset })
  await assert.rejects(h.manager.resetConnectorEnvironment(), { message: EXTERNALLY_MANAGED.reinstall })
  const changed = { ...DEFAULT_CONNECTOR_SETTINGS, syncIntervalSeconds: DEFAULT_CONNECTOR_SETTINGS.syncIntervalSeconds + 1 }
  await assert.rejects(h.manager.saveConnectorSettings(changed), { message: EXTERNALLY_MANAGED.settings })
  // Nothing of a managed Connector came into being: no sources, no environment, no configuration.
  // (The plugin's own connector-settings.json is the settings form's stored values, not the Connector's.)
  const entries = await readdir(h.root)
  for (const name of ['connector', 'connector-venv', 'connector-source']) {
    assert.equal(entries.includes(name), false, name + ' must not be created in attached mode')
  }
})

test('the journal of a Connector the plugin used to run is not shown in attached mode', async t => {
  const logs = await mkdtemp(join(tmpdir(), 'aa-journal-'))
  t.after(() => rm(logs, { recursive: true, force: true }))
  const stale = [{ id: 1, time: new Date().toISOString(), text: 'Connector already running' }]
  await writeFile(join(logs, 'connector-output.json'), JSON.stringify(stale))
  assert.equal(connectorOutputDirectory(logs, false), logs)
  assert.equal(connectorOutputDirectory(logs, true), join(logs, 'attached'))
  assert.equal((await readConnectorLogs(connectorOutputDirectory(logs, false))).entries.length, 1)
  assert.deepEqual(await readConnectorLogs(connectorOutputDirectory(logs, true)), {
    entries: [], hasMore: false, oldestId: null, newestId: null,
  })
  // Reading never creates the directory: attached mode writes nothing under stateRoot.
  assert.deepEqual(await readdir(logs), ['connector-output.json'])
})

test('every refusal names the system service that owns the Connector', () => {
  for (const message of Object.values(EXTERNALLY_MANAGED)) assert.match(message, /由系统服务管理/)
})
