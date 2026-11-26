import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AttachedConnector, CONNECTOR_ABSENT, EXTERNALLY_MANAGED } from '../../src/host/connector/attached.js'
import { AccountApi, ApiError, type Account, type Device } from '../../src/host/account/api.js'
import type { ConnectorProcess } from '../../src/host/connector/process.js'
import { RuntimeDiagnostics, type DiagnosticEntry } from '../../src/host/dsh-runtime/diagnostics.js'
import { OnboardingManager } from '../../src/host/onboarding/manager.js'
import { readJson, writeJson } from '../../src/host/storage/files.js'
import { en } from '../../src/client/locales.ts'

const API = 'https://api.example.test'
const USER = 'user-test'
/** The device the service's Connector runs on. Every flow below must leave its credential exactly as it is. */
const SERVICE: Device = { id: 'conn_service', name: 'Service Mac', userId: USER, status: 'online' }
const SHARED = { installationId: 'install-service', connectorId: SERVICE.id, connectorToken: 'SHARED-SECRET', name: SERVICE.name }
const FOLDER_ABSENT = 'Connector 的目录尚未由系统服务创建。'
const LOGGED_OUT = '已退出登录，插件已停止跟随本机 Connector；它由系统服务管理，仍在运行。'
/** Everything the plugin itself keeps under stateRoot in attached mode. */
const PLUGIN_FILES = ['.manager-lock.json', 'account.json', 'bindings', 'connector-settings.json', 'settings.json']

function account(): Account {
  return { apiBaseUrl: API, userId: USER, displayName: '测试用户', accessToken: 'USER-SECRET', expiresAt: Date.now() + 3600_000 }
}

function bindingPath(root: string): string {
  return join(root, 'bindings', `${createHash('sha256').update(`${API}\n${USER}`).digest('hex')}.json`)
}

/** Every call that could adopt, create or rotate a device is recorded: attached mode must make none of them. */
class RecordingApi extends AccountApi {
  rotations: string[] = []
  registrations: string[] = []
  exchanges = 0
  valid = true
  /** When set, the server accepts only this device token, whichever record claims it. */
  accepted: string | null = null
  accountRejected = false
  owned: Device[] = [SERVICE]
  override async exchange(): Promise<Account> { this.exchanges++; return account() }
  override async me() { if (this.accountRejected) throw new ApiError(401); return { userId: USER, displayName: '测试用户' } }
  override async devices() { return this.owned }
  override async device(_token: string, id: string): Promise<Device> {
    const device = this.owned.find(item => item.id === id)
    if (!device) throw new ApiError(404)
    return device
  }
  override async register(_token: string, name: string) { this.registrations.push(name); return { connector: SERVICE, connectorToken: 'ROTATED' } }
  override async verifyConnector(_id: string, token: string) { return this.accepted === null ? this.valid : token === this.accepted }
  override async renewConnector(_token: string, id: string) { this.rotations.push(id); this.valid = true; return 'ROTATED' }
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let count = 0; count < 600; count++) { if (await check()) return; await delay(10) }
  assert.fail(`${what} did not happen`)
}

async function messageOf(call: Promise<unknown>): Promise<string> {
  try { await call; return 'resolved' } catch (error) { return (error as Error).message }
}

/** The OAuth provider redirects the browser here with a code; the loopback flow hands it to the plugin. */
async function callback(url: string): Promise<void> {
  const params = new URLSearchParams(new URL(url).hash.split('?')[1] ?? '')
  const target = new URL(params.get('redirect_uri')!)
  target.searchParams.set('code', 'test-authorization-code')
  target.searchParams.set('state', params.get('state')!)
  await fetch(target, { redirect: 'manual' })
}

async function fixture(t: TestContext, options: {
  mode?: 'attached' | 'managed'
  signedIn?: boolean
  binding?: boolean
  /** What the Connector-owned local registry lists; the real machine lists the service's Connector. */
  localIds?: string[]
  attachTimeoutMs?: number
  /** A server that cannot be reached: a failure that may pass on its own, unlike an absent Connector. */
  serverDown?: boolean
  /** null keeps the plugin's own schedule. */
  resumeRetryDelaysMs?: number[] | null
  legacyStateRoot?: string
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aa-attached-manager-'))
  const stateRoot = join(root, 'state')
  const api = new RecordingApi(API)
  const entries: DiagnosticEntry[] = []
  const diagnostics = new RuntimeDiagnostics({ write: entry => { entries.push(entry) }, async flush() {} }, {}, 'dsh-plugin')
  const rendezvous = join(root, 'bridge', 'connector.json')
  // Never the default rendezvous: that one is the production Connector's.
  const connector: ConnectorProcess = new AttachedConnector({ rendezvousPath: rendezvous, pollMs: 10, attachTimeoutMs: options.attachTimeoutMs ?? 5_000, lostAfterMs: 300, diagnostics })
  if (options.signedIn ?? true) await writeJson(join(stateRoot, 'account.json'), account())
  if (options.binding ?? true) await writeJson(bindingPath(stateRoot), SHARED)
  await mkdir(dirname(rendezvous), { recursive: true })
  const opened: string[] = []
  const server = { down: options.serverDown ?? false }
  const manager = new OnboardingManager({
    stateRoot, connectorSourceDir: root, uvPath: 'uv', apiBaseUrl: API,
    ...(options.mode === 'managed' ? {} : { connectorMode: 'attached' as const }),
    ...(options.legacyStateRoot ? { legacyStateRoot: options.legacyStateRoot } : {}),
  }, {
    api: base => base === API ? api : new RecordingApi(base),
    // A managed manager builds its own SourceConnector, as in production.
    ...(options.mode === 'managed' ? {} : { connector }),
    detect: async () => ({ status: 'absent', message: 'not registered' }),
    checkServer: async () => { if (server.down) throw new TypeError('fetch failed') }, systemLanguages: async () => ['en-US'], diagnostics,
    machineState: { readConnectorIds: async () => options.localIds ?? [SERVICE.id] },
    openFolder: async target => { opened.push(target) },
    onlineTimeoutMs: 2_000, pollIntervalMs: 10, rolePollIntervalMs: 100,
    ...(options.resumeRetryDelaysMs === null ? {} : { resumeRetryDelaysMs: options.resumeRetryDelaysMs ?? [60, 80] }),
  })
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }) })
  return {
    root, stateRoot, api, entries, opened, manager, connector, server,
    publish: () => writeFile(rendezvous, JSON.stringify({
      version: 2, protocol: 'meshcall', instanceId: 'connector-a', pid: process.pid,
      endpoint: { unixPath: join(root, 'router.sock') }, key: 'mk_' + 'k'.repeat(40),
    })),
    snapshot: () => manager.inspect(),
    rotations: () => [api.rotations, api.registrations],
  }
}

test('attached: startup follows the published Connector on the saved binding and writes only plugin files', async t => {
  const h = await fixture(t)
  await h.publish()
  const published = await readFile(join(h.root, 'bridge', 'connector.json'), 'utf8')
  await h.manager.resume()
  const snapshot = await h.snapshot()
  assert.equal(snapshot.stage, 'ready')
  assert.equal(snapshot.connectorRunning, true)
  assert.equal(snapshot.connectorId, SERVICE.id)
  assert.equal(snapshot.connector.externallyManaged, true)
  assert.equal(snapshot.connector.resolvedUvPath, null)
  assert.deepEqual(h.rotations(), [[], []])
  assert.deepEqual(await readJson(bindingPath(h.stateRoot)), SHARED, 'startup verifies the binding, it does not rewrite it')
  assert.equal(await readFile(join(h.root, 'bridge', 'connector.json'), 'utf8'), published)
  // The background profile refresh publishes account.json through a temporary sibling; that is still a plugin file.
  const files = (await readdir(h.stateRoot)).filter(name => !/\.[0-9a-f-]{36}\.tmp$/.test(name)).sort()
  for (const name of ['connector', 'connector-venv', 'connector-source', 'bin', 'logs']) assert.equal(files.includes(name), false, name)
  assert.deepEqual(files, PLUGIN_FILES)
})

test('attached: without a binding record nothing is claimed, no failure is recorded, and a record written later is followed without a reload', async t => {
  const h = await fixture(t, { binding: false })
  await h.publish()
  assert.equal(await messageOf(h.manager.controlConnector('start')), EXTERNALLY_MANAGED.binding)
  assert.equal(h.manager.startupDiagnostic(), null, 'a record the deployer has not written is not a failure')
  assert.equal(h.connector.running, false)
  void h.manager.resume()
  await until(async () => h.entries.some(entry => entry.message === 'onboarding.resume_retry'), 'the retry that reads the record again')
  const waiting = await h.snapshot()
  assert.equal(waiting.stage, 'error')
  assert.ok(waiting.message.startsWith(EXTERNALLY_MANAGED.binding), waiting.message)
  assert.equal(waiting.connectorRunning, false)
  assert.equal(h.manager.startupDiagnostic(), null)
  assert.equal(h.entries.filter(entry => entry.message === 'connector.start_failed').length, 0)
  assert.equal(h.entries.filter(entry => entry.message === 'onboarding.resume_retry')[0]!.level, 'info')
  assert.deepEqual(h.rotations(), [[], []])
  assert.equal(await readJson(bindingPath(h.stateRoot)), null)
  // The deployer writes the credential the service runs on: the next attempt finds it, with no click and no reload.
  await writeJson(bindingPath(h.stateRoot), SHARED)
  await until(async () => (await h.snapshot()).stage === 'ready', 'following on the written record')
  assert.equal(h.manager.startupDiagnostic(), null)
  assert.deepEqual(h.rotations(), [[], []])
})

test('attached: a binding record corrected on disk is picked up by “重新检查”, with no reload', async t => {
  const h = await fixture(t)
  h.api.accepted = 'CORRECTED-SECRET'
  await h.publish()
  await h.manager.resume()
  assert.equal((await h.snapshot()).deviceRecovery?.status, 'disconnected')
  // Nothing changed: checking again says the same thing.
  await h.manager.recoverDevice('check')
  assert.equal((await h.snapshot()).deviceRecovery?.status, 'disconnected')
  await writeJson(bindingPath(h.stateRoot), { ...SHARED, connectorToken: 'CORRECTED-SECRET' })
  await h.manager.recoverDevice('check')
  assert.equal((await h.snapshot()).deviceRecovery, null)
  await until(async () => (await h.snapshot()).stage === 'ready', 'following on the corrected record')
  assert.equal(h.connector.running, true)
  assert.equal(h.manager.startupDiagnostic(), null)
  assert.deepEqual(h.rotations(), [[], []])
})

test('attached: a start with no Connector published is a state, not a failure, and follows it when it appears', async t => {
  const h = await fixture(t, { attachTimeoutMs: 60 })
  await assert.rejects(h.manager.controlConnector('start'), { message: CONNECTOR_ABSENT })
  assert.equal(h.manager.startupDiagnostic(), null)
  assert.equal(h.entries.filter(entry => entry.message === 'connector.start_failed').length, 0)
  const waiting = await h.snapshot()
  assert.equal(waiting.stage, 'error')
  assert.ok(waiting.message.startsWith(CONNECTOR_ABSENT), waiting.message)
  assert.equal(waiting.deviceRecovery, null)
  await until(async () => h.entries.some(entry => entry.message === 'onboarding.resume_retry'), 'the retry of an absent Connector')
  await h.publish()
  await until(async () => (await h.snapshot()).stage === 'ready', 'following the published Connector')
  assert.equal(h.connector.running, true)
  assert.equal(h.manager.startupDiagnostic(), null)
  assert.deepEqual(h.rotations(), [[], []])
})

test('attached: an absent Connector is retried on the attached schedule and logged as information, a real failure as a warning', async t => {
  const retries = (h: { entries: DiagnosticEntry[] }) => h.entries.filter(entry => entry.message === 'onboarding.resume_retry')
  const absent = await fixture(t, { attachTimeoutMs: 40, resumeRetryDelaysMs: null })
  void absent.manager.resume()
  await until(async () => retries(absent).length > 0, 'a retry')
  assert.equal(retries(absent)[0]!.level, 'info')
  assert.equal(JSON.parse(retries(absent)[0]!.details).delayMs, 5_000)
  assert.equal(absent.entries.filter(entry => entry.message === 'connector.start_failed').length, 0)
  const unreachable = await fixture(t, { serverDown: true, resumeRetryDelaysMs: null })
  void unreachable.manager.resume()
  await until(() => Promise.resolve(retries(unreachable).length > 0), 'a retry')
  assert.equal(retries(unreachable)[0]!.level, 'warn')
  assert.equal(JSON.parse(retries(unreachable)[0]!.details).delayMs, 5_000)
})

test('attached: reconnect and recreate are refused before anything in flight is interrupted; check still works', async t => {
  const h = await fixture(t)
  await h.publish()
  await h.manager.resume()
  assert.equal((await h.snapshot()).stage, 'ready')
  // A login waiting for the browser: a refusal that ran cancelFlow() first would close it.
  h.api.accountRejected = true
  await h.manager.begin()
  for (const action of ['reconnect', 'recreate'] as const) {
    await assert.rejects(h.manager.recoverDevice(action), { message: EXTERNALLY_MANAGED.device })
  }
  const untouched = await h.snapshot()
  assert.equal(untouched.stage, 'authorizing')
  assert.equal(untouched.connectorRunning, true)
  await h.manager.cancel()
  await assert.rejects(h.manager.recoverDevice('check'), { message: '设备状态已变化，请重新打开插件。' })
  assert.deepEqual(h.rotations(), [[], []])
})

test('attached: a refused stop leaves the start that is waiting for the Connector alone', async t => {
  const h = await fixture(t, { attachTimeoutMs: 10_000 })
  const starting = h.manager.controlConnector('start')
  await until(async () => (await h.snapshot()).stage === 'starting', 'the start waiting for the Connector')
  const stopping = h.manager.controlConnector('stop')
  const reinstalling = h.manager.resetConnectorEnvironment()
  assert.equal(await Promise.race([starting.then(() => 'settled', () => 'settled'), delay(150).then(() => 'pending')]), 'pending', 'a refused action aborted the start')
  await h.publish()
  await starting
  await assert.rejects(stopping, { message: EXTERNALLY_MANAGED.stop })
  await assert.rejects(reinstalling, { message: EXTERNALLY_MANAGED.reinstall })
  const snapshot = await h.snapshot()
  assert.equal(snapshot.stage, 'ready')
  assert.equal(snapshot.connectorRunning, true)
  assert.deepEqual(h.rotations(), [[], []])
})

test('attached: a login verifies the binding on disk, adopts nothing, keeps its token and leaves the record as the deployer wrote it', async t => {
  // The Connector-owned registry lists another of the account's devices first: a managed login would adopt and rotate it.
  const h = await fixture(t, { localIds: ['conn_other'] })
  h.api.owned.push({ id: 'conn_other', name: 'Other Mac', userId: USER, status: 'offline' })
  // The record as a deployer writes it: the service's credential, a name of their own, no installation id.
  await writeJson(bindingPath(h.stateRoot), { connectorId: SERVICE.id, connectorToken: SHARED.connectorToken, name: '部署时写好的名字' })
  const written = await readFile(bindingPath(h.stateRoot), 'utf8')
  await h.manager.logout()
  assert.equal((await h.snapshot()).message, LOGGED_OUT)
  assert.equal(await readFile(bindingPath(h.stateRoot), 'utf8'), written, 'logging out keeps the binding record')
  await h.publish()
  await callback((await h.manager.begin()).url)
  await until(async () => (await h.snapshot()).stage === 'ready', 'the login completing')
  assert.equal(h.api.exchanges, 1)
  assert.equal((await h.snapshot()).connectorId, SERVICE.id)
  assert.equal(await readFile(bindingPath(h.stateRoot), 'utf8'), written, 'the login verified the record and wrote nothing back')
  assert.deepEqual(h.rotations(), [[], []])
})

test('attached: a login without a binding record is refused instead of adopting the device the registry lists', async t => {
  const h = await fixture(t, { signedIn: false, binding: false })
  await h.publish()
  await callback((await h.manager.begin()).url)
  await until(async () => (await h.snapshot()).stage === 'error', 'the refusal')
  const snapshot = await h.snapshot()
  assert.equal(h.api.exchanges, 1)
  // The retry notice wraps the message; the UI translates the two parts separately.
  assert.ok(snapshot.message.startsWith(EXTERNALLY_MANAGED.binding), snapshot.message)
  assert.equal(snapshot.connectorRunning, false)
  assert.deepEqual(h.rotations(), [[], []])
  assert.equal(await readJson(bindingPath(h.stateRoot)), null)
})

test('attached: a login while no Connector is published is not a failure either, and follows it when it appears', async t => {
  const h = await fixture(t, { attachTimeoutMs: 60 })
  // Still signed in, so begin() resumes the saved account instead of opening a browser.
  await h.manager.begin()
  await until(async () => (await h.snapshot()).stage === 'error', 'the absent Connector')
  assert.ok((await h.snapshot()).message.startsWith(CONNECTOR_ABSENT))
  assert.equal(h.manager.startupDiagnostic(), null)
  await h.publish()
  await until(async () => (await h.snapshot()).stage === 'ready', 'following the published Connector')
  assert.equal(h.connector.running, true)
})

test('attached: a device the server rejects or no longer knows asks for the binding record to be corrected, in words the UI has', async t => {
  const rejected = await fixture(t)
  rejected.api.valid = false
  await rejected.publish()
  await rejected.manager.resume()
  const disconnected = (await rejected.snapshot()).deviceRecovery
  assert.equal(disconnected?.status, 'disconnected')
  assert.match(disconnected?.message ?? '', /请用该服务当前使用的那份凭据更新插件的绑定记录/)
  assert.ok(Object.hasOwn(en, disconnected!.message), disconnected!.message)
  // Checking again says the same thing: there is no reconnect to offer.
  await rejected.manager.recoverDevice('check')
  assert.equal((await rejected.snapshot()).deviceRecovery?.message, disconnected?.message)
  const deleted = await fixture(t)
  deleted.api.owned = []
  await deleted.publish()
  await deleted.manager.resume()
  const gone = (await deleted.snapshot()).deviceRecovery
  assert.equal(gone?.status, 'deleted')
  assert.match(gone?.message ?? '', /插件不会重新创建设备/)
  assert.ok(Object.hasOwn(en, gone!.message), gone!.message)
  assert.deepEqual([...rejected.rotations(), ...deleted.rotations()], [[], [], [], []])
})

test('attached: reset, reinstall and saving settings are refused outright; nothing is written and following is not interrupted', async t => {
  const h = await fixture(t)
  await h.publish()
  await h.manager.resume()
  assert.equal((await h.snapshot()).stage, 'ready')
  const stateFiles = async () => {
    // The background profile refresh writes account.json through a temporary sibling: that is not a change.
    const names = (await readdir(h.stateRoot)).filter(name => !/\.[0-9a-f-]{36}\.tmp$/.test(name)).sort()
    return Promise.all(names.map(async name => [name, (await stat(join(h.stateRoot, name))).isDirectory()
      ? 'directory' : createHash('sha256').update(await readFile(join(h.stateRoot, name))).digest('hex')]))
  }
  // The background profile refresh rewrites account.json shortly after startup: take the baseline once it has settled.
  let before = await stateFiles()
  for (let count = 0; count < 50; count++) {
    await delay(50)
    const now = await stateFiles()
    if (JSON.stringify(now) === JSON.stringify(before)) break
    before = now
  }
  await assert.rejects(h.manager.resetConnector(false), { message: EXTERNALLY_MANAGED.reset })
  await assert.rejects(h.manager.resetConnector(true), { message: EXTERNALLY_MANAGED.reset })
  await assert.rejects(h.manager.resetConnectorEnvironment(), { message: EXTERNALLY_MANAGED.reinstall })
  await assert.rejects(h.manager.saveConnectorSettings({ heartbeatSeconds: 20 }), { message: EXTERNALLY_MANAGED.settings })
  assert.deepEqual(await stateFiles(), before, 'nothing under stateRoot was written')
  const snapshot = await h.snapshot()
  assert.equal(snapshot.stage, 'ready')
  assert.equal(snapshot.connectorRunning, true)
  assert.deepEqual(h.rotations(), [[], []])
})
test('attached: opening a folder never creates it, and only opens what the service already made', async t => {
  const h = await fixture(t)
  const logs = join(h.root, 'logs')
  assert.equal(h.connector.logsPath, logs)
  for (const [folder, path] of [['data', join(h.stateRoot, 'connector')], ['logs', logs]] as const) {
    assert.equal(await messageOf(h.manager.openConnectorFolder(folder)), FOLDER_ABSENT)
    await assert.rejects(stat(path), { code: 'ENOENT' })
    await mkdir(path, { recursive: true })
    await h.manager.openConnectorFolder(folder)
    assert.equal(h.opened.at(-1), path)
  }
})

test('attached: the legacy migration leaves the Connector configuration and sources where they were; managed still migrates them', async t => {
  const legacy = await mkdtemp(join(tmpdir(), 'aa-legacy-'))
  t.after(() => rm(legacy, { recursive: true, force: true }))
  const saved = account()
  await writeJson(join(legacy, 'account.json'), saved)
  await writeJson(join(legacy, 'connector', 'connector.json'), { statePath: join(legacy, 'connector', 'conn_test.sqlite3'), token: 'SERVICE-SECRET' })
  await writeJson(join(legacy, 'connector-source', 'project.json'), { name: 'service' })
  const attached = await fixture(t, { legacyStateRoot: legacy, signedIn: false, binding: false })
  await attached.manager.initialize()
  assert.deepEqual(await readJson(join(attached.stateRoot, 'account.json')), saved)
  await assert.rejects(stat(join(attached.stateRoot, 'connector')), { code: 'ENOENT' })
  await assert.rejects(stat(join(attached.stateRoot, 'connector-source')), { code: 'ENOENT' })
  assert.deepEqual(await readJson(join(attached.stateRoot, '.legacy-state-migrated.json')), { version: 1 })
  assert.deepEqual(await readJson(join(legacy, 'connector', 'connector.json')), { statePath: join(legacy, 'connector', 'conn_test.sqlite3'), token: 'SERVICE-SECRET' })
  const managed = await fixture(t, { mode: 'managed', legacyStateRoot: legacy, signedIn: false, binding: false })
  await managed.manager.initialize()
  assert.deepEqual(await readJson(join(managed.stateRoot, 'connector', 'connector.json')), {
    statePath: join(managed.stateRoot, 'connector', 'conn_test.sqlite3'), token: 'SERVICE-SECRET',
  })
  assert.deepEqual(await readJson(join(managed.stateRoot, 'connector-source', 'project.json')), { name: 'service' })
})

test('attached: every refusal and notice of the mode has an English entry', async t => {
  const h = await fixture(t)
  const messages = [EXTERNALLY_MANAGED.device, '未跟随']
  messages.push(await messageOf(h.manager.recoverDevice('reconnect')))
  messages.push(await messageOf(h.manager.openConnectorFolder('data')))
  await h.manager.logout()
  messages.push((await h.snapshot()).message)
  assert.equal(messages.at(-1), LOGGED_OUT)
  const unbound = await fixture(t, { binding: false })
  void unbound.manager.resume()
  await until(async () => (await unbound.snapshot()).stage === 'error', 'the binding message')
  const waiting = (await unbound.snapshot()).message ?? ''
  assert.ok(waiting.startsWith(EXTERNALLY_MANAGED.binding), waiting)
  messages.push(EXTERNALLY_MANAGED.binding)
  for (const message of messages) assert.ok(Object.hasOwn(en, message), message)
})
