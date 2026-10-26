import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountApi, ApiError } from '../../src/host/account/api.ts'

for (const phase of ['fetch', 'body'] as const) {
  test(`server timeout during ${phase} produces a localized message`, async t => {
    const deadline = new AbortController()
    t.mock.method(AbortSignal, 'timeout', () => deadline.signal)
    const reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const fail = () => { deadline.abort(reason); throw reason }
    const api = new AccountApi('https://example.test', async () => {
      if (phase === 'fetch') return fail()
      return { ok: true, json: async () => fail() } as Response
    })
    await assert.rejects(api.me('token'), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, '连接服务器超时，请检查地址和网络后重试。')
      assert.equal(error.cause, reason)
      return true
    })
  })
}

test('caller cancellation takes precedence over a concurrent timeout', async t => {
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal)
  const caller = new AbortController()
  const cancelled = new Error('stopped')
  const api = new AccountApi('https://example.test', async () => {
    deadline.abort()
    caller.abort(cancelled)
    throw deadline.signal.reason
  })
  await assert.rejects(api.me('token', caller.signal), error => error === cancelled)
})

test('HTTP failures retain their status for device and login recovery', async () => {
  const api = new AccountApi('https://example.test', async () => new Response(null, { status: 401 }))
  await assert.rejects(api.me('token'), error => error instanceof ApiError && error.status === 401)
})
