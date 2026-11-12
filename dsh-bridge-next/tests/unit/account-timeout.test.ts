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

function networkError(code: string, message = 'socket failure'): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) })
}

test('a read retries transient connection failures, then succeeds', async () => {
  const seen: string[] = []
  const api = new AccountApi('https://example.test', async () => {
    seen.push('call')
    if (seen.length < 3) throw networkError(seen.length === 1 ? 'ECONNRESET' : 'UND_ERR_SOCKET')
    return new Response(JSON.stringify({ userId: 'u1' }))
  })
  assert.equal((await api.me('token')).userId, 'u1')
  assert.equal(seen.length, 3)
})

test('a read gives up after the last retry and reports the original failure', async () => {
  let calls = 0
  const failure = networkError('ECONNRESET')
  const api = new AccountApi('https://example.test', async () => { calls += 1; throw failure })
  await assert.rejects(api.me('token'), error => error === failure)
  assert.equal(calls, 3)
})

test('a write repeats only when the request cannot have been sent', async () => {
  const exchange = (failure: Error) => {
    let calls = 0
    const api = new AccountApi('https://example.test', async url => {
      calls += 1
      if (calls === 1) throw failure
      return new Response(JSON.stringify(String(url).endsWith('/oauth/token') ? { access_token: 't', expires_in: 60 } : { userId: 'u1' }))
    })
    return { calls: () => calls, run: api.exchange('code', 'verifier', 'https://example.test/cb', new AbortController().signal) }
  }
  // The code may already be spent, and it works only once.
  const reset = exchange(networkError('ECONNRESET'))
  await assert.rejects(reset.run)
  assert.equal(reset.calls(), 1)
  for (const failure of [networkError('ECONNREFUSED'), networkError('ECONNRESET', 'Client network socket disconnected before secure TLS connection was established')]) {
    const unsent = exchange(failure)
    assert.equal((await unsent.run).userId, 'u1')
  }
})

test('HTTP errors and unrelated failures are not retried', async () => {
  for (const failure of [new ApiError(500), new Error('invalid'), networkError('CERT_HAS_EXPIRED')]) {
    let calls = 0
    const api = new AccountApi('https://example.test', async () => { calls += 1; throw failure })
    await assert.rejects(api.me('token'))
    assert.equal(calls, 1)
  }
})

test('cancelling during a retry wait stops at once', async () => {
  const controller = new AbortController()
  let calls = 0
  const api = new AccountApi('https://example.test', async () => { calls += 1; controller.abort(new Error('stopped')); throw networkError('ECONNRESET') })
  await assert.rejects(api.me('token', controller.signal), /stopped/)
  assert.equal(calls, 1)
})
