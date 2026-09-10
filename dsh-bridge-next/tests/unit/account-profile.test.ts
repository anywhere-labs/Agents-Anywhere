import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountApi, publicProfile } from '../../src/host/account/api.js'

const profile = { userId: 'user-test', displayName: 'BensonWang', email: 'benson@example.test', avatar: 'data:image/png;base64,aGVsbG8=' }

test('OAuth retains account display details and publishes only the profile fields', async () => {
  const api = new AccountApi('https://own.example', async (url, options) => {
    if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'private-token', expires_in: 3600 })
    assert.equal(String(url), 'https://own.example/api/v2/auth/me')
    assert.deepEqual(options?.headers, { Authorization: 'Bearer private-token' })
    return Response.json({ ...profile, role: 'admin', disabled: false, serverTime: 'now', unexpectedSecret: 'private' })
  })
  const account = await api.exchange('code', 'verifier', 'http://127.0.0.1/callback', new AbortController().signal)
  assert.equal(account.avatar, profile.avatar)
  assert.equal(account.email, profile.email)
  assert.equal(account.accessToken, 'private-token')
  assert.deepEqual(publicProfile(account), profile)
})

test('missing or unsupported avatars use a local fallback without external image requests', () => {
  for (const avatar of [undefined, null, '', 'https://external.example/avatar.png', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,' + 'a'.repeat(256 * 1024)]) {
    assert.equal(publicProfile({ ...profile, avatar: avatar ?? null }).avatar, null)
  }
  assert.deepEqual(publicProfile({ userId: 'user-test', displayName: '' }), { userId: 'user-test', displayName: 'user-test', email: null, avatar: null })
})
