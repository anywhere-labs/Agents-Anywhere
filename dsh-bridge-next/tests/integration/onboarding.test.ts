import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { OnboardingManager } from '../../src/host/onboarding/manager.js'
import { AccountApi, type Account, type Device } from '../../src/host/account/api.js'
import type { ConnectorProcess } from '../../src/host/connector/process.js'
import type { DesktopDetection } from '../../src/contracts/index.js'
import { readJson } from '../../src/host/storage/files.js'

class FakeApi extends AccountApi {
  registrations = 0
  exchanges = 0
  online = false
  validCredential = true
  renewals = 0
  override async exchange(): Promise<Account> {
    this.exchanges++
    return { apiBaseUrl: this.baseUrl, userId: 'user-test', displayName: '测试用户', accessToken: 'USER-SECRET', expiresAt: Date.now() + 3600_000 }
  }
  override async me() { return { userId: 'user-test', displayName: '测试用户' } }
  override async device(): Promise<Device> { return { id: 'conn_test', name: 'Test', userId: 'user-test', status: this.online ? 'online' : 'offline' } }
  override async register() { this.registrations++; return { connector: await this.device(), connectorToken: 'CONNECTOR-SECRET' } }
  override async verifyConnector() { return this.validCredential }
  override async renewConnector() { this.renewals++; this.validCredential = true; return 'RENEWED-SECRET' }
}

class FakeConnector implements ConnectorProcess {
  running = false
  starts = 0
  stops = 0
  async prepare() {}
  async start() { this.running = true; this.starts++ }
  async stop() { this.running = false; this.stops++ }
  async assertHealthy() { if (!this.running) throw new Error('not running') }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aa-flow-'))
  const api = new FakeApi('https://api.example.test')
  const connector = new FakeConnector()
  let detection: DesktopDetection = { status: 'absent', message: 'not registered' }
  const create = () => new OnboardingManager({
    stateRoot: root, connectorSourceDir: root, uvPath: 'uv', autoStart: false,
    apiBaseUrl: api.baseUrl, webBaseUrl: 'https://app.example.test',
  }, { api: () => api, connector, detect: async () => detection, onlineTimeoutMs: 5000, pollIntervalMs: 10 })
  let manager = create()
  return {
    root, api, connector,
    get manager() { return manager },
    setDesktop(value: DesktopDetection) { detection = value },
    async reopen() { await manager.dispose(); manager = create(); return manager },
    async close() { await manager.dispose(); await rm(root, { recursive: true, force: true }) },
  }
}

function oauthParams(url: string) { return new URLSearchParams(new URL(url).hash.split('?')[1]) }
async function callback(url: string, state?: string) {
  const params = oauthParams(url)
  const cb = new URL(params.get('redirect_uri')!)
  cb.searchParams.set('code', 'test-authorization-code')
  cb.searchParams.set('state', state ?? params.get('state')!)
  return fetch(cb, { redirect: 'manual' })
}
async function until(check: () => Promise<boolean>) {
  for (let count = 0; count < 200; count++) { if (await check()) return; await delay(10) }
  assert.fail('expected state did not arrive')
}

test('OAuth callback pairs once, waits for actual online state, then redirects to Web without secrets', async () => {
  const h = await fixture()
  try {
    const { url } = await h.manager.begin()
    assert.match(url, /plugin-oauth/)
    assert.equal(oauthParams(url).get('client_id'), 'agents-anywhere-dsh-plugin')
    assert.equal((await callback(url, 'wrong-state')).status, 400)
    assert.equal(h.api.exchanges, 0)
    const accepted = await callback(url)
    assert.equal(accepted.status, 303)
    assert.equal((await callback(url)).status, 409)
    const progress = accepted.headers.get('location')!
    assert.doesNotMatch(progress, /code=|state=/)
    const page = await fetch(progress)
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/)
    assert.equal(page.headers.get('cache-control'), 'no-store')
    await until(async () => (await h.manager.inspect()).stage === 'starting')
    assert.equal(h.connector.running, true)
    assert.equal((await fetch(`${progress}/status`).then(r => r.json())).redirectUrl, undefined)
    h.api.online = true
    await until(async () => (await h.manager.inspect()).stage === 'ready')
    const ready = await fetch(`${progress}/status`).then(r => r.json())
    assert.match(ready.redirectUrl, /^https:\/\/app.example.test\/#\/onboarding\?/)
    assert.match(ready.redirectUrl, /connectorId=conn_test/)
    assert.doesNotMatch(JSON.stringify(await h.manager.inspect()), /USER-SECRET|CONNECTOR-SECRET|accessToken|connectorToken/)
    assert.doesNotMatch(JSON.stringify(ready), /SECRET|token|code=/i)
    assert.equal(h.api.registrations, 1)
    const again = await h.manager.begin()
    assert.match(again.url, /^http:\/\/127\.0\.0\.1:\d+\/onboarding\//)
    await until(async () => (await h.manager.inspect()).stage === 'ready')
    assert.equal(h.api.exchanges, 1)
    assert.equal(h.api.registrations, 1)
  } finally { await h.close() }
})

test('cancelled and disposed callbacks cannot register or start a device', async () => {
  const h = await fixture()
  try {
    const { url } = await h.manager.begin()
    const params = oauthParams(url)
    const cancelled = new URL(params.get('redirect_uri')!)
    cancelled.searchParams.set('error', 'access_denied')
    cancelled.searchParams.set('state', params.get('state')!)
    await fetch(cancelled)
    assert.equal((await h.manager.inspect()).stage, 'error')
    assert.equal(h.api.registrations, 0)
    await h.manager.cancel()
    await assert.rejects(fetch(cancelled))
    assert.equal(h.connector.starts, 0)
    await h.manager.dispose()
    await assert.rejects(h.manager.begin(), /已关闭/)
  } finally { await h.close() }
})

test('saved binding survives restart and logout; invalid device credentials are renewed for the same device', async () => {
  const h = await fixture()
  h.api.online = true
  try {
    await callback((await h.manager.begin()).url)
    await until(async () => (await h.manager.inspect()).stage === 'ready')
    await h.reopen()
    h.api.validCredential = false
    await h.manager.begin()
    await until(async () => (await h.manager.inspect()).stage === 'ready')
    assert.equal(h.api.registrations, 1)
    assert.equal(h.api.renewals, 1)
    await h.manager.logout()
    assert.equal(h.connector.running, false)
    assert.equal(await readJson(join(h.root, 'account.json')), null)
    assert.equal((await readdir(join(h.root, 'bindings'))).length, 1)
    await callback((await h.manager.begin()).url)
    await until(async () => (await h.manager.inspect()).stage === 'ready')
    assert.equal(h.api.registrations, 1)
  } finally { await h.close() }
})

test('Desktop presence or an invalid registry prevents the plugin from becoming another manager', async () => {
  const h = await fixture()
  try {
    for (const detection of [
      { status: 'installed', executablePath: '/example/desktop', message: 'use desktop' },
      { status: 'error', message: 'broken record' },
    ] as const) {
      h.setDesktop(detection)
      assert.equal((await h.manager.inspect()).desktop.status, detection.status)
      await assert.rejects(h.manager.begin(), new RegExp(detection.message))
    }
    assert.equal(h.api.exchanges, 0)
    assert.equal(h.connector.starts, 0)
  } finally { await h.close() }
})

test('repeated begin shares preparation, and disposal during preparation cannot open a callback', async () => {
  const h = await fixture()
  let prepared!: () => void
  let entered!: () => void
  const entry = new Promise<void>(resolve => { entered = resolve })
  h.connector.prepare = () => new Promise<void>(resolve => { prepared = resolve; entered() })
  try {
    const first = h.manager.begin()
    assert.equal(h.manager.begin(), first)
    await entry
    const stopped = h.manager.dispose()
    const rejected = assert.rejects(first, /已关闭/)
    prepared()
    await Promise.all([rejected, stopped])
    assert.equal(h.connector.starts, 0)
    assert.equal(await readJson(join(h.root, 'manager.lock')), null)
  } finally { await h.close() }
})
