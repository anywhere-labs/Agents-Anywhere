import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorSettingsStore, validateConnectorSettings } from '../../src/host/connector/settings.js'
import { readJson, writeJson } from '../../src/host/storage/files.js'
import { DEFAULT_CONNECTOR_SETTINGS } from '../../src/contracts/connector.js'

const config = (root: string) => ({ stateRoot: root, connectorDir: root, connectorDataDir: join(root, 'v3'), apiBaseUrl: 'https://api.example.test' })

test('settings of the Python Connector are dropped on load, keeping the proxy and the sync interval', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aa-plugin-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'connector-settings.json')
  await writeJson(path, { uvPath: '/opt/uv', uvPypiIndexUrl: 'https://mirrors.aliyun.com/pypi/simple',
    uvPythonInstallMirror: 'https://registry.npmmirror.com/-/binary/python-build-standalone',
    connectorProxy: 'http://127.0.0.1:7890', syncIntervalSeconds: 60, autoStart: false })
  const store = new ConnectorSettingsStore(config(root))
  await store.load()
  assert.deepEqual(store.get(), { connectorProxy: 'http://127.0.0.1:7890', syncIntervalSeconds: 60 })
  assert.deepEqual(await readJson(path), store.get(), 'the file is rewritten without the retired keys')
  await store.reset()
  assert.deepEqual(store.get(), DEFAULT_CONNECTOR_SETTINGS)
  assert.deepEqual(await readJson(path), DEFAULT_CONNECTOR_SETTINGS)
})

test('a first start without saved settings uses the defaults and writes nothing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aa-plugin-settings-new-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ConnectorSettingsStore(config(root))
  await store.load()
  assert.deepEqual(store.get(), DEFAULT_CONNECTOR_SETTINGS)
  assert.equal(await readJson(join(root, 'connector-settings.json')), null)
})

test('saving a retired setting is refused', () => {
  for (const key of ['uvPath', 'uvPypiIndexUrl', 'uvPythonInstallMirror']) {
    assert.throws(() => validateConnectorSettings({ ...DEFAULT_CONNECTOR_SETTINGS, [key]: '' }), /不支持的 Connector 配置项/)
  }
})

test('the Connector network setting accepts the system, direct or a full proxy address', () => {
  const settings = (connectorProxy: unknown) => validateConnectorSettings({ ...DEFAULT_CONNECTOR_SETTINGS, connectorProxy })
  for (const value of ['', 'direct', 'http://127.0.0.1:7890', 'https://proxy:443', 'socks5://proxy:1080', 'socks5h://proxy:1080']) {
    assert.equal(settings(value).connectorProxy, value)
  }
  assert.equal(settings('  direct ').connectorProxy, 'direct')
  for (const value of ['127.0.0.1:7890', 'ftp://proxy:21', 'http://', 42]) {
    assert.throws(() => settings(value), /代理地址无效/)
  }
})
