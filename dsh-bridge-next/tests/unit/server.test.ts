import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { checkServer, normalizeServerOrigin, resolveOAuthWebOrigin } from '../../src/host/account/server.js'

test('server input follows Desktop normalization and derives OAuth without a stored Web URL', () => {
  assert.equal(normalizeServerOrigin(' example.com/api/v2/ '), 'https://example.com')
  assert.equal(normalizeServerOrigin('http://192.168.1.10:8000'), 'http://192.168.1.10:8000')
  assert.equal(resolveOAuthWebOrigin('https://web.agents-anywhere.com'), 'https://web.agents-anywhere.com')
  assert.equal(resolveOAuthWebOrigin('https://own.example/api/v2'), 'https://own.example')
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(resolveOAuthWebOrigin(`http://${hostname}:8000`), `http://${hostname}:5174`)
    assert.equal(resolveOAuthWebOrigin(`http://${hostname}:8080`), `http://${hostname}:8080`)
  }
  assert.equal(resolveOAuthWebOrigin('https://own.example:8000'), 'https://own.example:8000')
  for (const address of ['', 'https://own.example/login', 'https://user:secret@own.example', 'https://own.example?q=1', 'https://own.example/#/login', 'file:///tmp', 'javascript:alert(1)']) {
    assert.throws(() => normalizeServerOrigin(address), /有效的 HTTP 或 HTTPS/)
  }
})

test('backend health check rejects wrong services, redirects and timeouts without sending credentials', async () => {
  let mode: 'ok' | 'wrong-service' | 'unavailable' | 'redirect' | 'timeout' = 'ok'
  let redirected = false
  const server = createServer((request, response) => {
    if (request.url === '/redirected') { redirected = true; response.end(); return }
    assert.equal(request.url, '/api/v2/health')
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.headers.cookie, undefined)
    if (mode === 'timeout') return
    if (mode === 'redirect') { response.writeHead(302, { location: '/redirected' }).end(); return }
    if (mode === 'unavailable') { response.writeHead(503).end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ status: mode === 'ok' ? 'ok' : 'other' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await checkServer(origin)
    mode = 'wrong-service'
    await assert.rejects(checkServer(origin), /未返回正常的/)
    mode = 'unavailable'
    await assert.rejects(checkServer(origin), /无法连接服务器/)
    mode = 'redirect'
    await assert.rejects(checkServer(origin), /无法连接服务器/)
    assert.equal(redirected, false)
    mode = 'timeout'
    await assert.rejects(checkServer(origin, fetch, 30), /连接服务器超时/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
