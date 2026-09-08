import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceConnector, ConnectorOwnershipError } from '../../src/host/connector/process.js'
import { readJson } from '../../src/host/storage/files.js'
import { DEFAULT_CONNECTOR_SETTINGS, type ConnectorSettings } from '../../src/contracts/connector.js'
import { ConnectorSettingsStore } from '../../src/host/connector/settings.js'

// A real stdio subprocess, without running Python, Agents or an AA service.
const fixtureSource = `
const readline = require('node:readline');
let running = false;
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  if (process.argv[2] === 'stall') return;
  const request = JSON.parse(line);
  if (request.method === 'connector.start' && process.argv[2] === 'conflict') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32009, message: 'Connector conflict', data: { reason: 'connector_already_running' } } }) + '\\n');
    return;
  }
  if (request.method === 'connector.start') running = true;
  if (request.method === 'connector.stop') running = false;
  const result = { running, authFailed: false };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  if (request.method === 'connector.start' && process.argv[2] === 'auth-failed') setTimeout(() => {
    running = false;
    const frame = JSON.stringify({ jsonrpc: '2.0', method: 'connector/state', params: { running, authFailed: true, lastError: 'PRIVATE', configPath: '/PRIVATE' } }) + '\\n';
    process.stdout.write(frame.slice(0, 30));
    setTimeout(() => process.stdout.write(frame.slice(30)), 5);
  }, 20);
});
lines.on('close', () => process.exit(0));
`
const binding = { installationId: 'test-installation', name: 'Test device', connectorId: 'conn_test', connectorToken: 'PRIVATE-DEVICE-TOKEN' }

async function fixture(mode = 'normal', settings: ConnectorSettings = DEFAULT_CONNECTOR_SETTINGS) {
  const root = await mkdtemp(join(tmpdir(), 'aa-process-中文 '))
  const source = join(root, 'source')
  await mkdir(join(source, 'connector'), { recursive: true })
  await writeFile(join(source, 'pyproject.toml'), '')
  await writeFile(join(source, 'connector', 'cli.py'), '')
  const script = join(root, 'rpc.cjs')
  await writeFile(script, fixtureSource)
  let child: ChildProcessWithoutNullStreams | undefined
  const connector = new SourceConnector({
    stateRoot: join(root, 'data'), connectorSourceDir: source, uvPath: mode === 'missing' ? join(root, 'missing-uv') : process.execPath,
    apiBaseUrl: 'https://api.example.test', dshHome: join(root, 'dsh-home'),
  }, (command, args, options) => {
    assert.equal(args[0], 'run')
    assert.deepEqual(args.slice(1, 5), ['--directory', source, 'anywhere-cli', 'rpc'])
    assert.equal(args[5], '--config')
    assert.doesNotMatch(JSON.stringify(args), /PRIVATE-DEVICE-TOKEN/)
    assert.equal(options.env?.UV_PROJECT_ENVIRONMENT, join(root, 'data', 'connector-venv'))
    assert.equal(options.env?.DSH_HOME, join(root, 'dsh-home'))
    const expectedIndex = settings.uvPypiIndexUrl || 'https://pypi.org/simple'
    assert.equal(options.env?.UV_DEFAULT_INDEX, expectedIndex)
    assert.equal(options.env?.UV_INDEX_URL, expectedIndex)
    assert.equal(options.env?.PIP_INDEX_URL, expectedIndex)
    child = spawn(command, [script, mode], options)
    return child
  }, () => settings)
  return {
    connector, root, get child() { return child },
    async close() { await connector.stop(); await rm(root, { recursive: true, force: true }) },
  }
}

test('source Connector uses stdio RPC and a private config, then exits on plugin stop', async () => {
  const h = await fixture()
  try {
    await h.connector.prepare()
    await h.connector.start(binding, 'https://api.example.test', new AbortController().signal)
    await h.connector.assertHealthy()
    assert.equal(h.connector.running, true)
    const config = await readJson<{ connectorToken: string }>(join(h.root, 'data', 'connector', 'connector.json'))
    assert.equal(config?.connectorToken, binding.connectorToken)
    await Promise.all([h.connector.stop(), h.connector.stop()])
    assert.equal(h.connector.running, false)
    assert.equal(h.child?.exitCode, 0)
    await assert.rejects(h.connector.assertHealthy())
  } finally { await h.close() }
})

test('locale initialization applies Aliyun before the first source Connector subprocess', async () => {
  const settings = { ...DEFAULT_CONNECTOR_SETTINGS }
  const h = await fixture('normal', settings)
  try {
    const store = new ConnectorSettingsStore({
      stateRoot: join(h.root, 'data'), connectorSourceDir: h.root, uvPath: 'uv', apiBaseUrl: 'https://api.example.test',
    }, async () => ['en-US', 'zh-CN'])
    await store.load()
    Object.assign(settings, store.get())
    assert.equal(settings.uvPypiIndexUrl, 'https://mirrors.aliyun.com/pypi/simple')
    await h.connector.start(binding, 'https://api.example.test', new AbortController().signal)
    await h.connector.assertHealthy()
  } finally { await h.close() }
})

test('saved scan interval and mirror reach the child while connection defaults stay fixed on every restart', async () => {
  // Even an old settings provider cannot override the fixed connection behavior.
  const settings = { ...DEFAULT_CONNECTOR_SETTINGS, syncIntervalSeconds: 60, heartbeatSeconds: 15,
    reconnectSeconds: 5, syncExistingOnConnect: false, uvPypiIndexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple' }
  const h = await fixture('normal', settings)
  try {
    await h.connector.prepare()
    for (const interval of [60, 300]) {
      settings.syncIntervalSeconds = interval
      await h.connector.start(binding, 'https://api.example.test', new AbortController().signal)
      const config = await readJson<Record<string, unknown>>(join(h.root, 'data', 'connector', 'connector.json'))
      assert.equal(config?.syncIntervalSeconds, interval)
      assert.equal(config?.heartbeatSeconds, 20)
      assert.equal(config?.reconnectSeconds, 3)
      assert.equal(config?.syncExistingOnConnect, true)
      assert.equal(config?.connectorId, binding.connectorId)
      assert.equal(config?.connectorToken, binding.connectorToken)
      await h.connector.stop()
    }
    const logs = await readFile(join(h.root, 'data', 'logs', 'connector.jsonl'), 'utf8')
    assert.match(logs, /"event":"running"/)
    assert.doesNotMatch(logs, /PRIVATE|connectorToken/)
  } finally { await h.close() }
})

test('a spawn error releases the child without waiting indefinitely', { timeout: 8000 }, async () => {
  const h = await fixture('missing')
  try {
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', new AbortController().signal), /启动失败|已关闭|已退出/)
    assert.equal(h.connector.running, false)
  } finally { await h.close() }
})

test('auth failure is delivered over unsolicited stdio state even while the controller process stays alive', { timeout: 8000 }, async () => {
  const h = await fixture('auth-failed')
  let detach = () => {}
  try {
    const failed = new Promise<unknown>(resolve => { detach = h.connector.onState(state => { if (state.authFailed) resolve(state) }) })
    await h.connector.start(binding, 'https://api.example.test', new AbortController().signal)
    assert.deepEqual(await failed, { running: false, authFailed: true })
    assert.equal(h.child?.exitCode, null)
    assert.equal(h.connector.running, false)
    await assert.rejects(h.connector.assertHealthy(), /本机设备连接已失效/)
  } finally { detach(); await h.close() }
})

test('cancelling a Connector that has not finished startup closes its owned process', { timeout: 8000 }, async () => {
  const h = await fixture('stall')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 100)
  try {
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', controller.signal))
    assert.equal(h.connector.running, false)
  } finally { clearTimeout(timer); await h.close() }
})


test('source Connector preserves RPC conflict identity and stops only its rejected child', async () => {
  const h = await fixture('conflict')
  try {
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', new AbortController().signal), ConnectorOwnershipError)
    assert.equal(h.connector.running, false)
    assert.equal(h.child?.exitCode, 0)
    assert.equal((await readJson<{ connectorId: string }>(join(h.root, 'data', 'connector', 'connector.json')))?.connectorId, binding.connectorId)
  } finally { await h.close() }
})
