import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountApi, ApiError, type Device } from '../../src/host/account/api.js'
import { ensureBinding } from '../../src/host/account/binding.js'

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
    const result = await ensureBinding(root, { apiBaseUrl: api.baseUrl, userId: 'user', displayName: 'User', accessToken: 'private-user', expiresAt: Date.now() + 60000 }, api, new AbortController().signal, { readConnectorIds: async () => [] })
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
  const run = (ids: string[]) => ensureBinding(root, account, api, new AbortController().signal, { renew: true, readConnectorIds: async () => ids })
  try {
    const matched = await run(['foreign', 'deleted', 'first-locally', 'first-on-server'])
    assert.equal(matched.connectorId, 'first-locally')
    assert.deepEqual(renewed, ['first-locally'])
    assert.equal(registrations, 0)
    devices = [{ id: 'foreign', userId: 'another-user', name: 'Private', status: 'offline' }]
    assert.equal((await run(['foreign', 'deleted'])).connectorId, 'fresh')
    assert.equal(registrations, 1)
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
  const run = () => ensureBinding(root, account, api, new AbortController().signal, { readConnectorIds: async () => ['known'] })
  try {
    await assert.rejects(run(), ApiError)
    failList = false
    await assert.rejects(run(), ApiError)
    assert.equal(registrations, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
