import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorSettingsStore, validateConnectorSettings } from '../../src/host/connector/settings.js'
import { readJson, writeJson } from '../../src/host/storage/files.js'
import { DEFAULT_CONNECTOR_SETTINGS } from '../../src/contracts/connector.js'

const aliyun = 'https://mirrors.aliyun.com/pypi/simple'

test('first Host initialization persists a locale-based mirror without a Client', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aa-plugin-mirror-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [languages, expected] of [
    [['zh-CN'], aliyun], [['en-US', 'zh-Hans-CN'], aliyun], [['zh_TW'], aliyun], [['en-US'], ''],
  ] as const) {
    const config = { stateRoot: join(root, languages.join('-')), connectorSourceDir: root, uvPath: 'uv', apiBaseUrl: 'https://api.example.test' }
    const store = new ConnectorSettingsStore(config, async () => [...languages])
    await store.load()
    assert.equal(store.get().uvPypiIndexUrl, expected)
    assert.equal(store.get().uvPythonInstallMirror, expected ? 'https://registry.npmmirror.com/-/binary/python-build-standalone' : '')
    assert.deepEqual(await readJson(join(config.stateRoot, 'connector-settings.json')), store.get())
    const reopened = new ConnectorSettingsStore(config, async () => { assert.fail('Saved mirrors must not be re-detected') })
    await reopened.load()
    assert.equal(reopened.get().uvPypiIndexUrl, expected)
    for (const choice of ['', 'https://pypi.tuna.tsinghua.edu.cn/simple']) {
      await store.save({ ...store.get(), uvPypiIndexUrl: choice })
      await reopened.load()
      assert.equal(reopened.get().uvPypiIndexUrl, choice)
    }
  }
})

test('legacy mirror migration preserves user choices and factory reset reapplies the system default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aa-plugin-mirror-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'connector-settings.json')
  const config = { stateRoot: root, connectorSourceDir: root, uvPath: 'uv', apiBaseUrl: 'https://api.example.test' }
  const store = new ConnectorSettingsStore(config, async () => ['zh-CN'])
  await writeJson(path, { uvPath: '', syncIntervalSeconds: 60, autoStart: false })
  await store.load()
  assert.deepEqual(store.get(), { ...DEFAULT_CONNECTOR_SETTINGS, syncIntervalSeconds: 60, uvPypiIndexUrl: aliyun, uvPythonInstallMirror: 'https://registry.npmmirror.com/-/binary/python-build-standalone' })
  await writeJson(path, { ...DEFAULT_CONNECTOR_SETTINGS, autoStart: false })
  await store.load()
  assert.equal(store.get().uvPypiIndexUrl, '')
  await store.reset()
  assert.deepEqual(store.get(), { ...DEFAULT_CONNECTOR_SETTINGS, uvPypiIndexUrl: aliyun, uvPythonInstallMirror: 'https://registry.npmmirror.com/-/binary/python-build-standalone' })
  assert.deepEqual(await readJson(path), store.get())
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
