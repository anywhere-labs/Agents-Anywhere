import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import jsQR from 'jsqr'
import { AccountApi, type Account } from '../../src/host/account/api.js'
import { MobileLogin } from '../../src/host/account/mobile.js'
import type { MobileLoginStatus } from '../../src/contracts/mobile.js'

const { PNG } = createRequire(import.meta.url)('pngjs') as {
  PNG: { sync: { read(buffer: Buffer): { data: Buffer; width: number; height: number } } }
}
const account: Account = { apiBaseUrl: 'http://192.168.1.10:8000', userId: 'user-test', displayName: 'Test',
  accessToken: 'PRIVATE-ACCOUNT-TOKEN', expiresAt: Date.now() + 3600_000 }

function fixture() {
  let status: MobileLoginStatus = 'pending_scan'
  let expiresAt = new Date(Date.now() + 300_000).toISOString()
  let owner = account.userId
  let failStatus = false
  const calls: { path: string; body: Record<string, unknown> }[] = []
  const api = new AccountApi(account.apiBaseUrl, async (input, options) => {
    assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${account.accessToken}`)
    assert.equal(options?.redirect, 'error')
    assert.equal(options?.method, 'POST')
    const url = new URL(String(input))
    assert.equal(url.origin, account.apiBaseUrl)
    assert.equal(url.search, '', 'Login tokens must not enter URL queries')
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {}
    calls.push({ path: url.pathname, body })
    if (url.pathname.endsWith('/qr')) return Response.json({ userId: owner, loginToken: 'SINGLE-USE-TOKEN', expiresAt, serverTime: new Date().toISOString() })
    assert.equal(body.loginToken, 'SINGLE-USE-TOKEN')
    if (url.pathname.endsWith('/confirm')) status = body.approved ? 'approved' : 'rejected'
    if (failStatus) return new Response('', { status: 503 })
    return Response.json({ status, userId: owner, deviceName: status === 'pending_scan' ? null : 'Test Phone' })
  })
  return { api, mobile: new MobileLogin(), calls,
    setStatus(value: MobileLoginStatus) { status = value },
    setOwner(value: string) { owner = value },
    expire() { expiresAt = new Date(Date.now() + 60).toISOString() },
    fail() { failStatus = true }, restore() { failStatus = false } }
}

test('the actual PNG decodes to the mobile scanner contract and confirms through existing auth endpoints', async () => {
  const h = fixture()
  try {
    const qr = await h.mobile.create(account, h.api)
    const png = PNG.sync.read(Buffer.from(qr.qrImage!.split(',')[1]!, 'base64'))
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
    assert.ok(decoded, 'The generated QR must be readable by an independent decoder')
    assert.deepEqual(JSON.parse(decoded.data), { type: 'agents-anywhere.mobile-login', version: 1,
      webUrl: account.apiBaseUrl, userId: account.userId, loginToken: 'SINGLE-USE-TOKEN',
      expiresAt: JSON.parse(decoded.data).expiresAt })
    assert.doesNotMatch(JSON.stringify(qr), /PRIVATE-ACCOUNT-TOKEN|SINGLE-USE-TOKEN|accessToken/)
    await assert.rejects(h.mobile.confirm(qr.id, true, account), /状态已变化/)
    h.setStatus('pending_web_confirm')
    const scanned = await h.mobile.inspect(qr.id, account)
    assert.equal(scanned.deviceName, 'Test Phone')
    assert.equal(scanned.qrImage, null)
    assert.equal((await h.mobile.confirm(qr.id, true, account)).status, 'approved')
    await assert.rejects(h.mobile.confirm(qr.id, true, account), /状态已变化/)
    h.setStatus('consumed')
    assert.equal((await h.mobile.inspect(qr.id, account)).status, 'consumed')
    const count = h.calls.length
    assert.equal((await h.mobile.inspect(qr.id, account)).status, 'consumed')
    assert.equal(h.calls.length, count, 'Completed sessions must stop polling the server')
    assert.deepEqual(h.calls.map(call => call.path), [
      '/api/v2/auth/mobile-login/qr', '/api/v2/auth/mobile-login/status', '/api/v2/auth/mobile-login/confirm', '/api/v2/auth/mobile-login/status',
    ])
  } finally { h.mobile.clear() }
})

test('reject, expiration, regeneration, owner isolation and logout cannot reuse a QR flow', async () => {
  const h = fixture()
  try {
    let qr = await h.mobile.create(account, h.api)
    h.setStatus('pending_web_confirm')
    await h.mobile.inspect(qr.id, account)
    assert.equal((await h.mobile.confirm(qr.id, false, account)).status, 'rejected')
    assert.equal(h.calls.at(-1)?.body.approved, false)
    const oldId = qr.id
    qr = await h.mobile.create(account, h.api)
    await assert.rejects(h.mobile.inspect(oldId, account), /二维码已失效/)
    for (const changed of [{ userId: 'other-user' }, { apiBaseUrl: 'https://other.example' }, { accessToken: 'OTHER-TOKEN' }]) {
      await assert.rejects(h.mobile.inspect(qr.id, { ...account, ...changed }), /二维码已失效/)
    }
    h.mobile.clear()
    await assert.rejects(h.mobile.inspect(qr.id, account), /二维码已失效/)
    h.expire()
    qr = await h.mobile.create(account, h.api)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await h.mobile.inspect(qr.id, account)).status, 'expired')
    await assert.rejects(h.mobile.confirm(qr.id, true, account), /状态已变化/)
  } finally { h.mobile.clear() }
})

test('invalid owners and transient server failures remain recoverable; disposal aborts a pending create', async () => {
  const h = fixture()
  try {
    h.setOwner('another-user')
    await assert.rejects(h.mobile.create(account, h.api), /响应无效/)
    h.setOwner(account.userId)
    const qr = await h.mobile.create(account, h.api)
    h.fail()
    await assert.rejects(h.mobile.inspect(qr.id, account), /503/)
    h.restore()
    assert.equal((await h.mobile.inspect(qr.id, account)).status, 'pending_scan')
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const api = new AccountApi(account.apiBaseUrl, async () => {
      entered()
      await new Promise<void>(resolve => { release = resolve })
      return Response.json({ userId: account.userId, loginToken: 'LATE', serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() })
    })
    const pending = h.mobile.create(account, api)
    await started
    h.mobile.clear()
    const rejected = assert.rejects(pending, /abort/i)
    release()
    await rejected
  } finally { h.mobile.clear() }
})
