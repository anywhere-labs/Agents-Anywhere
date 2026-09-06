import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountApi, ApiError } from '../../src/host/account/api.js'
import { ensureBinding } from '../../src/host/account/binding.js'

test('a deleted installation from a lost response is replaced with a fresh registration key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-binding-'))
  const keys: string[] = []
  class Api extends AccountApi {
    override async register(_token: string, name: string, key: string) {
      keys.push(key)
      if (keys.length === 1) throw new ApiError(409)
      return { connector: { id: 'conn_new', userId: 'user', name, status: 'offline' }, connectorToken: 'private' }
    }
  }
  const api = new Api('https://api.example.test')
  try {
    const result = await ensureBinding(root, { apiBaseUrl: api.baseUrl, userId: 'user', displayName: 'User', accessToken: 'private-user', expiresAt: Date.now() + 60000 }, api, new AbortController().signal)
    assert.equal(keys.length, 2)
    assert.notEqual(keys[0], keys[1])
    assert.equal(result.installationId, keys[1])
    assert.equal(result.connectorId, 'conn_new')
  } finally { await rm(root, { recursive: true, force: true }) }
})
