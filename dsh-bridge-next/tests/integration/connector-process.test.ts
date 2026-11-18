import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeadlineExceededError, LocalRouter, Mesh, MeshCallError, Router, mutates, query, service, stream, z } from 'meshcall'
import { BundledConnector, ConnectorOwnershipError } from '../../src/host/connector/process.js'
import { readJson } from '../../src/host/storage/files.js'
import { DEFAULT_CONNECTOR_SETTINGS, type ConnectorSettings } from '../../src/contracts/connector.js'

// A real stdio subprocess standing in for the bundled `anywhere-cli.js`, without Agents or an AA service.
// The child prints one `connector.ready` line and serves nothing itself: this
// test process owns the MeshCall Router and the `aa.local.v2.Control` service.
const fixtureSource = `
let running = false;
if (process.argv[2] === 'exit-error') { process.stderr.write('error: store worker failed: disk full\\n'); process.exit(2); }
process.stderr.write('connector: opening the local store\\n');
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
  authFailed: boolean, lastError: string | null, configPath: string, runtimePath: string, hasConfig: boolean }

/** The state machine behind the fake Control service, driven by the test's mode. */
class FakeControlBackend {
  running = false
  authFailed = false
  lastError: string | null = null
  private sequence = 0
  private readonly history: { seq: number, kind: 'state', state: ConnectorState }[] = []
  private readonly waiters = new Set<() => void>()
  constructor(readonly mode: string) {}

  snapshot(): ConnectorState {
    return { status: this.authFailed ? 'expired credential' : this.running ? 'running' : 'stopped',
      running: this.running, pairing: false, authFailed: this.authFailed, lastError: this.lastError,
      configPath: '/fixture/connector.json', runtimePath: '/fixture/runtime.json', hasConfig: true }
  }

  emit(): void {
    this.history.push({ seq: ++this.sequence, kind: 'state', state: this.snapshot() })
    for (const wake of this.waiters) wake()
    this.waiters.clear()
  }

  startClock(): void {
    // The plugin subscribes to `events` after `start` returns; emit later so it sees the change.
    // Like the Connector's controller, a credential failure also records lastError.
    if (this.mode === 'auth-failed') setTimeout(() => {
      this.running = false; this.authFailed = true; this.lastError = 'invalid connector credential'; this.emit()
    }, 100)
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
    if (this.backend.mode === 'invalid-state') {
      this.backend.running = false
      this.backend.lastError = 'invalid connector sync state file: /fixture/PRIVATE-DEVICE-TOKEN.sqlite3'
    }
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

const routerName = process.platform === 'win32' ? 'meshcall-router.exe' : 'meshcall-router'

/** A bundle laid out as scripts/bundle-connector.ts writes it; its Router is unpacked without the executable bit. */
async function bundle(root: string): Promise<string> {
  const directory = join(root, 'bundled-connector')
  await mkdir(join(directory, 'router', `${process.platform}-${process.arch}`), { recursive: true })
  await writeFile(join(directory, 'anywhere-cli.js'), fixtureSource)
  await writeFile(join(directory, 'router', `${process.platform}-${process.arch}`, routerName), '', { mode: 0o644 })
  return directory
}

async function fixture(mode = 'normal', settings: ConnectorSettings = DEFAULT_CONNECTOR_SETTINGS, firstRequestTimeoutMs?: number, onLaunch?: () => void) {
  let didSpawn!: () => void
  const spawned = new Promise<void>(resolve => { didSpawn = resolve })
  const root = await mkdtemp(join(tmpdir(), 'aa-process-中文 '))
  const connectorDir = await bundle(root)
  if (mode === 'missing') await rm(join(connectorDir, 'anywhere-cli.js'))
  const endpoint = localEndpoint(root)
  const key = `mk_fixture_${randomUUID()}`
  const backend = new FakeControlBackend(mode)
  const router = await LocalRouter.start(endpoint.router)
  const control = new Mesh(new Router(endpoint.rendezvous), { token: key, peerId: `fake-control-${randomUUID()}` })
  control.mount(new FakeControl(backend))
  await control.startServing()
  let child: ChildProcessWithoutNullStreams | undefined
  let childEnv: NodeJS.ProcessEnv | undefined
  const data = join(root, 'data')
  const connector = new BundledConnector({
    stateRoot: data, connectorDir, connectorDataDir: join(root, 'v3'),
    apiBaseUrl: 'https://api.example.test', dshHome: join(root, 'dsh-home'),
  }, (command, args, options) => {
    childEnv = options.env
    // This host's own Node runs the bundled entry; the device token never reaches the command line.
    assert.equal(command, process.execPath)
    assert.deepEqual(args, [join(connectorDir, 'anywhere-cli.js'), 'rpc', '--config', join(data, 'connector', 'connector.json')])
    assert.equal(options.cwd, join(data, 'connector'))
    assert.equal(options.env?.AA_CONNECTOR_OWNER_KIND, 'dsh-plugin')
    assert.equal(options.env?.DSH_HOME, join(root, 'dsh-home'))
    assert.equal(options.env?.AGENT_CONNECTOR_DATA_DIR, join(root, 'v3'))
    assert.equal(options.env?.AA_CONNECTOR_LEGACY_DATA_DIR, join(data, 'connector'))
    assert.equal(options.env?.AGENT_CONNECTOR_CONFIG, undefined)
    assert.equal(options.env?.MESHCALL_ROUTER_BINARY,
      process.env['MESHCALL_ROUTER_BINARY']?.trim() || join(connectorDir, 'router', `${process.platform}-${process.arch}`, routerName))
    assert.deepEqual(Object.keys(options.env ?? {}).filter(name => /^(UV_|PYTHON|PIP_)/.test(name) && !(name in process.env)), [])
    child = spawn(process.execPath, [args[0]!, mode, JSON.stringify(endpoint.rendezvous), key], options)
    child.once('spawn', didSpawn)
    onLaunch?.()
    return child
  }, () => settings, firstRequestTimeoutMs)
  return {
    connector, root, connectorDir, spawned, get child() { return child }, get childEnv() { return childEnv },
    async close() {
      await connector.stop()
      await control.close().catch(() => undefined)
      await router.stop().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('the bundled Connector uses the MeshCall Control service and a private config, then exits on plugin stop', async () => {
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

test('runtime state failure retains a reason and redacted diagnostics before the process is stopped', async () => {
  const h = await fixture('invalid-state')
  try {
    await h.connector.start(binding, 'https://api.example.test', new AbortController().signal)
    await assert.rejects(h.connector.assertHealthy(), { code: 'CONNECTOR_SYNC_STATE_INVALID' })
    assert.match(h.connector.lastError!, /同步状态文件无效/)
    await h.connector.stop()
    const logs = await readFile(join(h.root, 'data', 'logs', 'connector-output.json'), 'utf8')
    assert.match(logs, /invalid connector sync state file/)
    assert.doesNotMatch(logs, /PRIVATE-DEVICE-TOKEN/)
  } finally { await h.close() }
})

test('the saved scan interval reaches the child while connection defaults stay fixed on every restart', async () => {
  // Even an old settings provider cannot override the fixed connection behavior.
  const settings = { ...DEFAULT_CONNECTOR_SETTINGS, syncIntervalSeconds: 60, heartbeatSeconds: 15,
    reconnectSeconds: 5, syncExistingOnConnect: false }
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
    assert.match(logs, /connector: opening the local store/)
    assert.doesNotMatch(logs, /PRIVATE|connectorToken/)
  } finally { await h.close() }
})

test('a missing bundle or Router is reported before anything is launched', async () => {
  const h = await fixture('missing')
  try {
    await assert.rejects(h.connector.prepare(), /未找到内置 Connector/)
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', new AbortController().signal), /未找到内置 Connector/)
    assert.equal(h.child, undefined)
  } finally { await h.close() }
  const previous = process.env['MESHCALL_ROUTER_BINARY']
  delete process.env['MESHCALL_ROUTER_BINARY']
  const other = await fixture()
  try {
    await rm(join(other.connectorDir, 'router'), { recursive: true })
    await assert.rejects(other.connector.prepare(), /内置 Connector 不支持这台电脑的平台/)
  } finally {
    if (previous !== undefined) process.env['MESHCALL_ROUTER_BINARY'] = previous
    await other.close()
  }
})

test('preparing restores the Router\'s executable bit and clears what the Python Connector left behind', { skip: process.platform === 'win32' }, async () => {
  const previous = process.env['MESHCALL_ROUTER_BINARY']
  delete process.env['MESHCALL_ROUTER_BINARY']
  const h = await fixture()
  try {
    const data = join(h.root, 'data')
    for (const path of [['connector-venv', 'pyvenv.cfg'], ['connector-source', 'abc', 'uv.lock'], ['bin', 'uv'], ['connector', 'connector.json'], ['account.json']]) {
      await mkdir(join(data, ...path.slice(0, -1)), { recursive: true })
      await writeFile(join(data, ...path), '{}')
    }
    await h.connector.prepare()
    for (const gone of ['connector-venv', 'connector-source', join('bin', 'uv')]) assert.equal(existsSync(join(data, gone)), false, gone)
    assert.equal(existsSync(join(data, 'connector', 'connector.json')), true, 'credentials stay')
    assert.equal(existsSync(join(data, 'account.json')), true, 'the account stays')
    await access(join(h.connectorDir, 'router', `${process.platform}-${process.arch}`, routerName), constants.X_OK)
  } finally {
    if (previous !== undefined) process.env['MESHCALL_ROUTER_BINARY'] = previous
    await h.close()
  }
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
    assert.equal(h.connector.lastError, null, 'a credential failure is not reported as a runtime failure')
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


test('the first request spends its own startup budget, not the ordinary request timeout', { timeout: 8000 }, async () => {
  // A child that never answers proves which budget the first request uses: the ordinary 15 s
  // default would outlast this test, so rejecting here means the startup budget applied.
  const h = await fixture('stall', DEFAULT_CONNECTOR_SETTINGS, 300)
  try {
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', new AbortController().signal), /启动超时/)
    assert.equal(h.connector.running, false)
  } finally { await h.close() }
})


test('cancelling before startup does not launch a child', async () => {
  const h = await fixture('stall')
  const controller = new AbortController()
  const reason = new Error('cancelled before startup')
  controller.abort(reason)
  try {
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', controller.signal), error => error === reason)
    assert.equal(h.child, undefined)
  } finally { await h.close() }
})

test('cancellation during launch is observed before the request listener is installed', { timeout: 8000 }, async () => {
  const controller = new AbortController()
  const reason = new Error('cancelled during launch')
  const h = await fixture('stall', DEFAULT_CONNECTOR_SETTINGS, 300, () => controller.abort(reason))
  try {
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', controller.signal), error => error === reason)
    assert.equal(h.connector.running, false)
    assert.equal(h.child?.exitCode, 0)
  } finally { await h.close() }
})

test('the bundled Connector preserves the RPC conflict identity and stops only its rejected child', async () => {
  const h = await fixture('conflict')
  try {
    // The Control service reports the MeshCall application error
    // `connector_already_running`; the plugin surfaces it as the typed
    // onboarding error so the UI can show its conflict message.
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', new AbortController().signal),
      error => error instanceof ConnectorOwnershipError)
    assert.equal(h.connector.running, false)
    assert.equal(h.child?.exitCode, 0)
    assert.equal((await readJson<{ connectorId: string }>(join(h.root, 'data', 'connector', 'connector.json')))?.connectorId, binding.connectorId)
  } finally { await h.close() }
})


test('startup exit 2 preserves the Connector\'s output in its journal', async () => {
  const h = await fixture('exit-error')
  try {
    await assert.rejects(h.connector.start(binding, 'https://api.example.test', new AbortController().signal), /已退出（2）/)
    const logs = await readFile(join(h.root, 'data', 'logs', 'connector-output.json'), 'utf8')
    assert.match(logs, /store worker failed: disk full/)
    assert.match(logs, /exited \(2\)/)
  } finally { await h.close() }
})

test('the bundled Connector takes its proxy from the setting, not from an inherited value', async () => {
  const previous = process.env['AA_CONNECTOR_PROXY']
  process.env['AA_CONNECTOR_PROXY'] = 'http://inherited:1'
  try {
    for (const [connectorProxy, expected] of [['direct', 'direct'], ['http://127.0.0.1:7890', 'http://127.0.0.1:7890'], ['', undefined]] as const) {
      const h = await fixture('normal', { ...DEFAULT_CONNECTOR_SETTINGS, connectorProxy })
      try {
        await h.connector.start(binding, 'https://api.example.test', new AbortController().signal)
        assert.equal(h.childEnv?.['AA_CONNECTOR_PROXY'], expected)
      } finally { await h.close() }
    }
  } finally {
    if (previous === undefined) delete process.env['AA_CONNECTOR_PROXY']
    else process.env['AA_CONNECTOR_PROXY'] = previous
  }
})

test('a slow answer during startup does not count as an unhealthy Connector', async () => {
  const h = await fixture()
  try {
    await h.connector.start(binding, 'https://api.example.test', new AbortController().signal)
    const connector = h.connector as unknown as { control: { getState: unknown } }
    const original = connector.control.getState
    // What the device reported in #468: the runtime loop was busy for over 15 s, then came online.
    connector.control.getState = async () => { throw new DeadlineExceededError('Call deadline exceeded') }
    await h.connector.assertHealthy()
    assert.equal(h.connector.running, true)
    // Any other failure of the health check still counts.
    connector.control.getState = async () => { throw new Error('control channel broken') }
    await assert.rejects(h.connector.assertHealthy(), /control channel broken/)
    connector.control.getState = original
    await h.connector.assertHealthy()
  } finally { await h.close() }
})
