import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountApi, ApiError, type Device } from '../../src/host/account/api.js'
import { DeviceRecoveryRequired, ensureBinding, recoverBinding } from '../../src/host/account/binding.js'
import { localMachineRegistry, machineStatePath } from '../../src/host/desktop/machine-state.js'
import { writeJson } from '../../src/host/storage/files.js'

test('a deleted installation from a lost response is replaced with a fresh registration key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-binding-'))
  const keys: string[] = []
  class Api extends AccountApi {
    override async devices() { return [] }
    override async register(_token: string, name: string, key: string) {
      keys.push(key)
      if (keys.length === 1) throw new ApiError(409)
      return { connector: { id: 'conn_new', userId: 'user', name, status: 'offline' }, connectorToken: 'private' }
    }
  }
  const api = new Api('https://api.example.test')
  try {
    const result = await ensureBinding(root, { apiBaseUrl: api.baseUrl, userId: 'user', displayName: 'User', accessToken: 'private-user', expiresAt: Date.now() + 60000 }, api, new AbortController().signal, { machineState: localMachineRegistry(root) })
    assert.equal(keys.length, 2)
    assert.notEqual(keys[0], keys[1])
    assert.equal(result.installationId, keys[1])
    assert.equal(result.connectorId, 'conn_new')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('shared IDs are matched against this user, with local order winning over server order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-binding-match-'))
  const renewed: string[] = []
  let registrations = 0
  let devices: Device[] = [
    { id: 'first-on-server', userId: 'user', name: 'One', status: 'offline' },
    { id: 'first-locally', userId: 'user', name: 'Two', status: 'offline' },
    { id: 'foreign', userId: 'another-user', name: 'Private', status: 'offline' },
  ]
  class Api extends AccountApi {
    override async devices() { return devices }
    override async renewConnector(_token: string, id: string) { renewed.push(id); return 'NEW-TOKEN' }
    override async register() { registrations++; return { connector: { id: 'fresh', userId: 'user', name: 'Fresh', status: 'offline' }, connectorToken: 'NEW' } }
  }
  const api = new Api('https://server.test')
  const account = { apiBaseUrl: api.baseUrl, userId: 'user', displayName: 'User', accessToken: 'USER', expiresAt: Date.now() + 60000 }
  const run = async (ids: string[]) => {
    await writeJson(machineStatePath(root), { version: 2, connectorIds: ids })
    return ensureBinding(root, account, api, new AbortController().signal, { renew: true, machineState: localMachineRegistry(root) })
  }
  try {
    const matched = await run(['foreign', 'deleted', 'first-locally', 'first-on-server'])
    assert.equal(matched.connectorId, 'first-locally')
    assert.deepEqual(renewed, ['first-locally'])
    assert.equal(registrations, 0)
    devices = [{ id: 'foreign', userId: 'another-user', name: 'Private', status: 'offline' }]
    await assert.rejects(run(['foreign', 'deleted']), (error: unknown) => error instanceof DeviceRecoveryRequired && error.reason === 'deleted')
    assert.equal(registrations, 0)
    assert.deepEqual(renewed, ['first-locally'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('list and renewal failures never fall back to registering a duplicate device', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-binding-fail-'))
  let failList = true
  let registrations = 0
  class Api extends AccountApi {
    override async devices() {
      if (failList) throw new ApiError(503)
      return [{ id: 'known', userId: 'user', name: 'Known', status: 'offline' }]
    }
    override async renewConnector(): Promise<string> { throw new ApiError(404) }
    override async register(): Promise<never> { registrations++; throw new Error('must not create') }
  }
  const api = new Api('https://server.test')
  const account = { apiBaseUrl: api.baseUrl, userId: 'user', displayName: 'User', accessToken: 'USER', expiresAt: Date.now() + 60000 }
  const machineState = localMachineRegistry(root)
  const run = () => ensureBinding(root, account, api, new AbortController().signal, { machineState })
  try {
    await machineState.recordConnectorId('known')
    await assert.rejects(run(), ApiError)
    failList = false
    await assert.rejects(run(), ApiError)
    assert.equal(registrations, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const failFirstPublish of [false, true]) {
  test(`a private plugin binding is published without another registration (initial publish failure: ${failFirstPublish})`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'aa-binding-publish-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    let registrations = 0
    let verifications = 0
    let publishes = 0
    const device = { id: 'plugin-device', userId: 'user', name: 'Existing Mac', status: 'online' }
    class Api extends AccountApi {
      override async devices() { return [device] }
      override async register() { registrations++; return { connector: device, connectorToken: 'CONNECTOR-SECRET' } }
      override async verifyConnector() { verifications++; return true }
      override async renewConnector(): Promise<never> { throw new Error('a valid token must not be rotated') }
    }
    const api = new Api('https://server.test')
    const account = { apiBaseUrl: api.baseUrl, userId: 'user', displayName: 'User', accessToken: 'USER-SECRET', expiresAt: Date.now() + 60000 }
    const key = createHash('sha256').update(`${account.apiBaseUrl}\n${account.userId}`).digest('hex')
    const bindingPath = join(root, 'bindings', `${key}.json`)
    const machine = localMachineRegistry(root)
    const run = () => ensureBinding(root, account, api, new AbortController().signal, { machineState: {
      readConnectorIds: machine.readConnectorIds,
      recordConnectorId: async id => {
        publishes++
        if (failFirstPublish && publishes === 1) throw new Error('machine publish failed')
        await machine.recordConnectorId(id)
      },
    } })
    if (failFirstPublish) {
      await assert.rejects(run(), /machine publish failed/)
      assert.equal(registrations, 1)
      assert.equal(JSON.parse(await readFile(bindingPath, 'utf8')).connectorId, device.id)
      assert.deepEqual(await machine.readConnectorIds(), [])
    } else {
      // An old plugin version persisted only this private binding.
      await writeJson(bindingPath, { installationId: 'legacy', name: device.name, connectorId: device.id, connectorToken: 'CONNECTOR-SECRET' })
    }
    const result = await run()
    assert.equal(result.connectorId, device.id)
    assert.equal(registrations, failFirstPublish ? 1 : 0)
    assert.equal(verifications, 1)
    assert.deepEqual(await machine.readConnectorIds(), [device.id])
    assert.doesNotMatch(await readFile(machineStatePath(root), 'utf8'), /SECRET|connectorToken|accessToken/)
  })
}

test('confirmed recreation retries the same registration key after a lost response, including a plugin restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-binding-recovery-'))
  const keys: string[] = []
  const api = new class extends AccountApi {
    override async devices() { return [{ id: 'replacement', userId: 'user', name: 'Mac', status: 'offline' }] }
    override async device(): Promise<Device> { throw new ApiError(404) }
    override async register(_token: string, name: string, key: string) {
      keys.push(key)
      if (keys.length === 1) throw new TypeError('response lost after creation')
      return { connector: { id: 'replacement', userId: 'user', name, status: 'offline' }, connectorToken: 'NEW-SECRET' }
    }
  }('https://server.test')
  const account = { apiBaseUrl: api.baseUrl, userId: 'user', displayName: 'User', accessToken: 'USER-SECRET', expiresAt: Date.now() + 60000 }
  const key = createHash('sha256').update(`${account.apiBaseUrl}\n${account.userId}`).digest('hex')
  const path = join(root, 'bindings', `${key}.json`)
  const machine = localMachineRegistry(root)
  try {
    await writeJson(path, { connectorId: 'deleted', connectorToken: 'OLD-SECRET', installationId: 'old-key', name: 'Old' })
    const recover = () => recoverBinding(root, account, api, new AbortController().signal, 'deleted', 'recreate', machine)
    await assert.rejects(recover(), /response lost/)
    await assert.rejects(ensureBinding(root, account, api, new AbortController().signal, { machineState: machine }), DeviceRecoveryRequired)
    assert.equal(keys.length, 1, 'Startup cannot automatically retry creation')
    assert.equal((await recover()).connectorId, 'replacement')
    assert.equal(keys.length, 2)
    assert.equal(keys[0], keys[1])
    assert.notEqual(keys[0], 'old-key')
    assert.deepEqual(await machine.readConnectorIds(), ['replacement'])
    assert.doesNotMatch(await readFile(path, 'utf8'), /replacesConnectorId|OLD-SECRET/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
