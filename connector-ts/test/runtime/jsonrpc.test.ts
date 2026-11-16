import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { ConnectionClosedError, JsonRpcError, JsonRpcPeer, RequestTimeoutError, memoryTransportPair, ndjsonTransport } from '../../src/runtime/acp/jsonrpc.js'

function pair(): [JsonRpcPeer, JsonRpcPeer] {
  const [a, b] = memoryTransportPair()
  return [new JsonRpcPeer(a), new JsonRpcPeer(b)]
}

describe('JsonRpcPeer', () => {
  it('routes requests, notifications and errors', async () => {
    const [client, agent] = pair()
    agent.onRequest('echo', params => ({ echoed: params }))
    agent.onRequest('fail', () => {
      throw JsonRpcError.invalidParams('bad')
    })
    const seen: unknown[] = []
    agent.onNotification('note', params => seen.push(params))
    await expect(client.request('echo', { a: 1 })).resolves.toEqual({ echoed: { a: 1 } })
    await expect(client.request('fail')).rejects.toMatchObject({ code: -32602, message: 'bad' })
    await expect(client.request('missing')).rejects.toMatchObject({ code: -32601 })
    client.notify('note', { n: 1 })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(seen).toEqual([{ n: 1 }])
  })

  it('times out, cancels and rejects pending requests when the connection closes', async () => {
    const [client, agent] = pair()
    let aborted = false
    agent.onRequest('slow', (_params, context) => new Promise(resolve => {
      context.signal.addEventListener('abort', () => {
        aborted = true
        resolve(null)
      })
    }))
    await expect(client.request('slow', {}, { timeoutMs: 10 })).rejects.toBeInstanceOf(RequestTimeoutError)
    const controller = new AbortController()
    const cancelled = client.request('slow', {}, { signal: controller.signal })
    controller.abort(new Error('stop'))
    await expect(cancelled).rejects.toThrow('stop')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(aborted).toBe(true)
    const pending = client.request('slow')
    agent.close('agent gone')
    await expect(pending).rejects.toBeInstanceOf(ConnectionClosedError)
  })

  it('frames ndjson and closes on a message over the limit', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const peer = new JsonRpcPeer(ndjsonTransport(input, output, 64))
    const written: string[] = []
    output.on('data', chunk => written.push(String(chunk)))
    const got: unknown[] = []
    peer.onNotification('n', params => got.push(params))
    input.write('{"jsonrpc":"2.0","method":"n","par')
    input.write('ams":{"x":1}}\n\n')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(got).toEqual([{ x: 1 }])
    peer.notify('out', { y: 2 })
    expect(written.join('')).toBe('{"jsonrpc":"2.0","method":"out","params":{"y":2}}\n')
    input.write('x'.repeat(100))
    await expect(peer.whenClosed()).resolves.toMatch(/over 64 bytes/)
  })
})
