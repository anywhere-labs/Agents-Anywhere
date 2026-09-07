import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import desktopBinding from '../../../desktop-workbench/electron/desktop-binding.ts'
import desktopService from '../../../desktop-workbench/electron/desktop-device-service.ts'
import desktopMachine from '../../../desktop-workbench/electron/machine-state.ts'
import type { ConnectorSupervisor } from '../../../desktop-workbench/electron/connector-supervisor.ts'
import type { ConnectorPrivateConfig } from '../../../desktop-workbench/electron/connector-types.ts'
import { AccountApi, type Device } from '../../src/host/account/api.js'
import type { ConnectorProcess } from '../../src/host/connector/process.js'
import { localMachineRegistry } from '../../src/host/desktop/machine-state.js'
import { OnboardingManager } from '../../src/host/onboarding/manager.js'

const { DesktopBindingStore } = desktopBinding
const { DesktopDeviceService } = desktopService
const { MachineStateStore, desktopInstallation, machineStatePath } = desktopMachine

/** Both real clients use this same account API, so a second POST is observable. */
class DeviceServer {
  readonly origin = 'https://api.example.test'
  readonly devices = new Map<string, Device & { token: string }>()
  readonly requests: string[] = []
  registrations = 0
  rotations = 0

  fetch: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace('/api/v2', '')
    const method = init?.method ?? 'GET'
    this.requests.push(`${method} ${path}`)
    if (path === '/oauth/token') return Response.json({ access_token: 'USER-SECRET', expires_in: 3600 })
    if (path === '/connector/auth') {
      const authorized = [...this.devices.values()].some(device => new Headers(init?.headers).get('authorization') === `Connector ${device.id}:${device.token}`)
      return Response.json({}, { status: authorized ? 200 : 401 })
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer USER-SECRET')
    if (path === '/auth/me') return Response.json({ userId: 'user', displayName: 'User' })
    if (path === '/connectors' && method === 'GET') return Response.json({ connectors: [...this.devices.values()].map(({ token: _token, ...device }) => device) })
    if (path === '/connectors' && method === 'POST') {
      const body = JSON.parse(String(init?.body))
      const device = { id: `conn-${++this.registrations}`, userId: 'user', name: body.name, status: 'offline', token: 'CONNECTOR-SECRET' }
      this.devices.set(device.id, device)
      const { token, ...connector } = device
      return Response.json({ connector, connectorToken: token })
    }
    const [, , id, action] = path.split('/')
    const device = this.devices.get(id!)
    if (!device) return Response.json({ detail: 'connector not found' }, { status: 404 })
    if (action === 'revoke' && method === 'POST') device.token = `ROTATED-SECRET-${++this.rotations}`
    else assert.equal(method, 'GET')
    const { token, ...connector } = device
    return Response.json({ connector, ...(action === 'revoke' ? { connectorToken: token } : {}) })
  }
}

for (const entry of ['first-login', 'deleted-local-device'] as const) {
  test(`plugin OAuth creation followed by Desktop ${entry} keeps exactly one device`, { timeout: 10_000 }, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'aa-plugin-desktop-handoff-'))
    t.after(() => rm(home, { recursive: true, force: true }))
    const machine = new MachineStateStore(machineStatePath(home))
    const bindingPath = join(home, 'desktop', 'binding.json')
    let credential: ConnectorPrivateConfig | null = null
    if (entry === 'deleted-local-device') {
      // The user deleted all server devices; only the stale local history remains.
      await machine.recordConnectorId('deleted-device')
      new DesktopBindingStore(bindingPath).save({
        connectorId: 'deleted-device', serverUrl: 'https://api.example.test', name: 'Previous Mac',
        ownerUserId: 'user', manualDisconnected: true,
      })
      credential = { connectorId: 'deleted-device', connectorToken: 'EXPIRED', serverUrl: 'https://api.example.test' }
    }
    const server = new DeviceServer()
    let pluginRunning = false
    const pluginConnector: ConnectorProcess = {
      onState: () => () => {},
      prepare: async () => {},
      start: async binding => { server.devices.get(binding.connectorId)!.status = 'online'; pluginRunning = true },
      stop: async () => { pluginRunning = false },
      assertHealthy: async () => { assert.equal(pluginRunning, true) },
    }
    const manager = new OnboardingManager({
      stateRoot: join(home, 'plugin'), apiBaseUrl: server.origin, connectorSourceDir: home, uvPath: 'uv', autoStart: false,
    }, {
      api: () => new AccountApi(server.origin, server.fetch), connector: pluginConnector,
      detect: async () => ({ status: 'absent', message: 'Desktop not installed yet' }),
      checkServer: async () => {}, machineState: localMachineRegistry(home), pollIntervalMs: 10, onlineTimeoutMs: 3000,
    })
    try {
      const authorization = await manager.begin()
      const params = new URLSearchParams(new URL(authorization.url).hash.split('?')[1])
      const callback = new URL(params.get('redirect_uri')!)
      callback.searchParams.set('code', 'test-code')
      callback.searchParams.set('state', params.get('state')!)
      assert.equal((await fetch(callback, { redirect: 'manual' })).status, 303)
      for (let attempt = 0; ; attempt++) {
        const snapshot = await manager.inspect()
        if (snapshot.stage === 'ready') break
        assert.notEqual(snapshot.stage, 'error', snapshot.message)
        assert.ok(attempt < 200, 'plugin did not finish pairing')
        await delay(10)
      }
      assert.equal(server.devices.size, 1)
      const pluginId = [...server.devices.keys()][0]!
      assert.ok(machine.readConnectorIds().includes(pluginId), 'the actual plugin must publish the ID itself')
      const publishedIds = machine.readConnectorIds()

      // A newly started Desktop reads the plugin's real file before reconnecting.
      await machine.recordInstallation(desktopInstallation({ executablePath: process.execPath, appPath: home, packaged: false, platform: process.platform }))
      let desktopStarted = false
      const supervisor = {
        hasCredential: () => Boolean(credential), loadPrivateConfig: () => credential,
        publicState: () => ({ running: false, authFailed: entry === 'deleted-local-device' }),
        preflightProvisioning: async () => {}, stop: async () => {}, bindingChanged: () => {},
        saveCredentials: async (next: ConnectorPrivateConfig) => { credential = next },
        start: async () => { desktopStarted = true },
      } as unknown as ConnectorSupervisor
      const service = new DesktopDeviceService({
        binding: new DesktopBindingStore(bindingPath), connector: supervisor,
        fetcher: server.fetch, defaultServerUrl: () => server.origin, apiNamespace: () => '/api/v2',
        readLocalConnectorIds: () => machine.readConnectorIds(), recordLocalConnector: id => machine.recordConnectorId(id),
      })
      const input = { userId: 'user', userToken: 'USER-SECRET' }
      const connected = entry === 'first-login' ? await service.createAndConnect(input) : await service.reconnectAndConnect(input)
      assert.equal(connected.connectorId, pluginId)
      assert.equal(connected.name, server.devices.get(pluginId)!.name)
      assert.equal(desktopStarted, true)
      assert.equal(credential?.connectorToken, server.devices.get(pluginId)!.token)
      assert.equal(server.devices.size, 1)
      assert.equal(server.registrations, 1)
      assert.equal(server.rotations, 1)
      assert.equal(server.requests.filter(request => request === 'POST /connectors').length, 1)
      assert.deepEqual(machine.readConnectorIds(), publishedIds)
      assert.doesNotMatch(await readFile(machine.filePath, 'utf8'), /SECRET|connectorToken|accessToken/)
    } finally { await manager.dispose() }
  })
}
