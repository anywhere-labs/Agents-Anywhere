import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRouter, Mesh, MeshCallError, Router, mutates, query, service, stream, z } from 'meshcall'
import { ConnectorOwnershipError, SourceConnector } from '../../src/host/connector/process.js'
import { readJson } from '../../src/host/storage/files.js'
import { DEFAULT_CONNECTOR_SETTINGS, type ConnectorSettings } from '../../src/contracts/connector.js'
import { ConnectorSettingsStore } from '../../src/host/connector/settings.js'

// A real stdio subprocess, without running Python, Agents or an AA service.
// The child prints one `connector.ready` line and serves nothing itself: this
// test process owns the MeshCall Router and the `aa.local.v2.Control` service.
const fixtureSource = `
let running = false;
if (process.argv[2] === 'exit-error') { process.stderr.write('error: Python download failed: connection reset\\n'); process.exit(2); }
process.stderr.write('uv: preparing Python environment\\n');
process.stderr.write('PRIVATE-DEVICE-TOKEN\\n');
if (process.argv[2] !== 'stall') {
  const ready = JSON.stringify({
    kind: 'connector.ready', version: 1,
    instanceId: 'fixture-' + process.pid, pid: process.pid,
    endpoint: JSON.parse(process.argv[3]), key: process.argv[4],
  });
  process.stdout.write(ready + '\\n');
}
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
`
const binding = { installationId: 'test-installation', name: 'Test device', connectorId: 'conn_test', connectorToken: 'PRIVATE-DEVICE-TOKEN' }

const stateSchema = z.looseObject({
  status: z.enum(['running', 'expired credential', 'error', 'stopped']),
  running: z.boolean(), pairing: z.boolean(), authFailed: z.boolean(),
  configPath: z.string(), runtimePath: z.string(), hasConfig: z.boolean(),
})
const eventSchema = z.looseObject({ seq: z.int(), kind: z.enum(['state', 'pairing']) })
type ConnectorState = { status: 'running' | 'expired credential' | 'error' | 'stopped', running: boolean, pairing: boolean,
  authFailed: boolean, lastError: null, configPath: string, runtimePath: string, hasConfig: boolean }

/** The state machine behind the fake Control service, driven by the test's mode. */
class FakeControlBackend {
  running = false
  authFailed = false
  private sequence = 0
  private readonly history: { seq: number, kind: 'state', state: ConnectorState }[] = []
  private readonly waiters = new Set<() => void>()
  constructor(readonly mode: string) {}

  snapshot(): ConnectorState {
    return { status: this.authFailed ? 'expired credential' : this.running ? 'running' : 'stopped',
      running: this.running, pairing: false, authFailed: this.authFailed, lastError: null,
      configPath: '/fixture/connector.json', runtimePath: '/fixture/runtime.json', hasConfig: true }
  }

  emit(): void {
    this.history.push({ seq: ++this.sequence, kind: 'state', state: this.snapshot() })
    for (const wake of this.waiters) wake()
    this.waiters.clear()
  }

  startClock(): void {
    // The plugin subscribes to `events` after `start` returns; emit later so it sees the change.
    if (this.mode === 'auth-failed') setTimeout(() => { this.running = false; this.authFailed = true; this.emit() }, 100)
  }

  async *events(since?: number | null): AsyncIterable<{ seq: number, kind: 'state', state: ConnectorState }> {
    let index = this.history.findIndex(event => event.seq > (since ?? 0))
    if (index < 0) index = this.history.length
    try {
      for (;;) {
        while (index < this.history.length) yield this.history[index++]!
        await new Promise<void>(resolve => { this.waiters.add(resolve) })
      }
    } finally { this.waiters.clear() }
  }
}

@service('aa.local.v2.Control', { description: 'Fake Connector control for process tests.' })
class FakeControl {
  constructor(private readonly backend: FakeControlBackend) {}

  @query({ description: 'State', request: z.looseObject({}), response: stateSchema })
  async getState(): Promise<ConnectorState> { return this.backend.snapshot() }

  @query({ description: 'Paths', request: z.looseObject({}), response: z.looseObject({ configPath: z.string(), configDir: z.string(), runtimePath: z.string() }) })
  async getPaths(): Promise<{ configPath: string; configDir: string; runtimePath: string }> {
    return { configPath: '/fixture/connector.json', configDir: '/fixture', runtimePath: '/fixture/runtime.json' }
  }

  @mutates({ description: 'Start', request: z.looseObject({}), response: stateSchema })
  async start(): Promise<ConnectorState> {
    if (this.backend.mode === 'conflict') {
      throw new MeshCallError('connector_already_running', 'Connector conflict', { details: { reason: 'connector_already_running' } })
    }
    this.backend.running = true
    this.backend.emit()
    this.backend.startClock()
    return this.backend.snapshot()
  }

  @mutates({ description: 'Stop', request: z.looseObject({}), response: stateSchema })
  async stop(): Promise<ConnectorState> {
    this.backend.running = false
    this.backend.emit()
    return this.backend.snapshot()
  }

  @stream({ description: 'Events', request: z.looseObject({ since: z.int().nullable().optional() }), outputItem: eventSchema })
  async *events(request: { since?: number | null }): AsyncIterable<{ seq: number, kind: 'state', state: ConnectorState }> {
    yield* this.backend.events(request.since)
  }
}

/** Windows cannot serve a Unix socket; both sides accept a named pipe instead. */
function localEndpoint(directory: string): { router: { unixPath: string } | { pipe: string }, rendezvous: { unixPath: string } | { pipe: string } } {
  if (process.platform === 'win32') {
    const pipe = `agents-anywhere-test-${randomUUID()}`
    return { router: { pipe }, rendezvous: { pipe } }
  }
  const unixPath = join(directory, 'router.sock')
  return { router: { unixPath }, rendezvous: { unixPath } }
}

async function fixture(mode = 'normal', settings: ConnectorSettings = DEFAULT_CONNECTOR_SETTINGS, firstRequestTimeoutMs?: number,
  prune: (command: string) => Promise<unknown> = async () => undefined, onLaunch?: () => void) {
  const pruned: string[] = []
  let didSpawn!: () => void
  const spawned = new Promise<void>(resolve => { didSpawn = resolve })
  const root = await mkdtemp(join(tmpdir(), 'aa-process-中文 '))
  const source = join(root, 'source')
  await mkdir(join(source, 'connector'), { recursive: true })
  await writeFile(join(source, 'pyproject.toml'), '')
  await writeFile(join(source, 'connector', 'cli.py'), '')
  const script = join(root, 'rpc.cjs')
  await writeFile(script, fixtureSource)
  const endpoint = localEndpoint(root)
  const key = `mk_fixture_${randomUUID()}`
  const backend = new FakeControlBackend(mode)
  const router = await LocalRouter.start(endpoint.router)
  const control = new Mesh(new Router(endpoint.rendezvous), { token: key, peerId: `fake-control-${randomUUID()}` })
  control.mount(new FakeControl(backend))
  await control.startServing()
  let child: ChildProcessWithoutNullStreams | undefined
  const connector = new SourceConnector({
    stateRoot: join(root, 'data'), connectorSourceDir: source, uvPath: mode === 'missing' ? join(root, 'missing-uv') : process.execPath,
    apiBaseUrl: 'https://api.example.test', dshHome: join(root, 'dsh-home'),
  }, (command, args, options) => {
    assert.equal(args[0], 'run')
    assert.equal(args[1], '--directory')
    assert.equal(args[3], 'anywhere-cli')
    assert.equal(args[4], 'rpc')
    assert.equal(args[5], '--config')
    // 打包内的负载只是只读输入：uv 在插件数据目录里的副本上工作。
    const projectDir = args[2]!
    assert.equal(projectDir.startsWith(source), false)
    assert.equal(projectDir.startsWith(join(root, 'data')), true)
    assert.equal(existsSync(join(projectDir, 'pyproject.toml')), true)
    assert.equal(existsSync(join(projectDir, 'connector', 'cli.py')), true)
    assert.equal(options.cwd, projectDir)
    assert.doesNotMatch(JSON.stringify(args), /PRIVATE-DEVICE-TOKEN/)
    assert.equal(options.env?.UV_PROJECT_ENVIRONMENT, join(root, 'data', 'connector-venv'))
    assert.equal(options.env?.DSH_HOME, join(root, 'dsh-home'))
    const expectedIndex = settings.uvPypiIndexUrl || 'https://pypi.org/simple'
    assert.equal(options.env?.UV_PYTHON_INSTALL_MIRROR, settings.uvPythonInstallMirror || 'https://github.com/astral-sh/python-build-standalone/releases/download')
    assert.equal(options.env?.UV_DEFAULT_INDEX, expectedIndex)
    assert.equal(options.env?.UV_INDEX_URL, expectedIndex)
    assert.equal(options.env?.PIP_INDEX_URL, expectedIndex)
    assert.equal(options.env?.UV_HTTP_TIMEOUT, process.env['UV_HTTP_TIMEOUT'] || '60')
    child = spawn(command, [script, mode, JSON.stringify(endpoint.rendezvous), key], options)
    child.once('spawn', didSpawn)
    onLaunch?.()
    return child
  }, () => settings, firstRequestTimeoutMs, async command => { pruned.push(command); return prune(command) })
  return {
    connector, root, pruned, spawned, get child() { return child },
    async close() {
      await connector.stop()
      await control.close().catch(() => undefined)
      await router.stop().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('source Connector uses the MeshCall Control service and a private config, then exits on plugin stop', async () => {
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
    // A start that reached the Connector downloaded nothing partially, so it owes no reclamation.
    assert.deepEqual(h.pruned, [])
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
    const logs = await readFile(join(h.root, 'data', 'logs', 'connector-output.json'), 'utf8')
    assert.match(logs, /\[process\] running/)
    assert.match(logs, /uv: preparing Python environment/)
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

test('auth failure is delivered over the unsolicited Control events stream while the process stays alive', { timeout: 8000 }, async () => {
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
  try {
    const stopped = assert.rejects(h.connector.start(binding, 'https://api.example.test', controller.signal))
    await h.spawned
    controller.abort()
    await stopped
    assert.equal(h.connector.running, false)
  } finally { await h.close() }
})


test('the first request spends its own installation budget, not the ordinary request timeout', { timeout: 8000 }, async () => {
  // A child that never answers proves which budget the first request uses: the ordinary 15 s
  // default would outlast this test, so rejecting here means the installation budget applied.
  const h = await fixture('stall', DEFAULT_CONNECTOR_SETTINGS, 300)
  try {
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', new AbortController().signal), /响应超时/)
    assert.equal(h.connector.running, false)
  } finally { await h.close() }
})


test('an interrupted installation reclaims the cache it half-filled, through the same uv', { timeout: 8000 }, async () => {
  // Cancelling mid-install is what leaves a truncated unpack directory behind in uv's cache.
  const h = await fixture('stall')
  const controller = new AbortController()
  try {
    const stopped = assert.rejects(h.connector.start(binding, 'https://api.example.test', controller.signal))
    await h.spawned
    controller.abort()
    await stopped
    assert.deepEqual(h.pruned, [process.execPath])
  } finally { await h.close() }
})

test('cancelling before startup does not launch a child or prune an untouched cache', async () => {
  const h = await fixture('stall')
  const controller = new AbortController()
  const reason = new Error('cancelled before startup')
  controller.abort(reason)
  try {
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', controller.signal), error => error === reason)
    assert.equal(h.child, undefined)
    assert.deepEqual(h.pruned, [])
  } finally { await h.close() }
})

test('cancellation during launch is observed before the request listener is installed', { timeout: 8000 }, async () => {
  const controller = new AbortController()
  const reason = new Error('cancelled during launch')
  const h = await fixture('stall', DEFAULT_CONNECTOR_SETTINGS, 300, undefined, () => controller.abort(reason))
  try {
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', controller.signal), error => error === reason)
    assert.equal(h.connector.running, false)
    assert.equal(h.child?.exitCode, 0)
    assert.deepEqual(h.pruned, [process.execPath])
  } finally { await h.close() }
})

test('a prune that fails leaves the startup failure it was reclaiming after', { timeout: 8000 }, async () => {
  // uv may be gone or busy by now; that must not rewrite the error the operator needs to read.
  const h = await fixture('exit-error', DEFAULT_CONNECTOR_SETTINGS, undefined, () => Promise.reject(new Error('uv cache prune failed')))
  try {
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', new AbortController().signal), /已退出（2）/)
    assert.deepEqual(h.pruned, [process.execPath])
  } finally { await h.close() }
})

test('source Connector preserves the RPC conflict identity and stops only its rejected child', async () => {
  const h = await fixture('conflict')
  try {
    // The Control service reports the MeshCall application error
    // `connector_already_running`; the Source Connector surfaces it as the typed
    // onboarding error so the UI can show its conflict message.
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', new AbortController().signal),
      error => error instanceof ConnectorOwnershipError)
    assert.equal(h.connector.running, false)
    assert.equal(h.child?.exitCode, 0)
    assert.equal((await readJson<{ connectorId: string }>(join(h.root, 'data', 'connector', 'connector.json')))?.connectorId, binding.connectorId)
  } finally { await h.close() }
})


test('startup exit 2 preserves uv diagnostics in the Connector journal', async () => {
  const h = await fixture('exit-error')
  try {
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', new AbortController().signal), /已退出（2）/)
    const logs = await readFile(join(h.root, 'data', 'logs', 'connector-output.json'), 'utf8')
    assert.match(logs, /Python download failed: connection reset/)
    assert.match(logs, /exited \(2\)/)
  } finally { await h.close() }
})
