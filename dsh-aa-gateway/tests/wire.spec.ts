import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { StdioJsonRpcTransport } from '../src/bridge/wire/transport.js'

describe('stdio JSON-RPC transport', () => {
  it('accepts concurrent request frames and writes valid responses', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.setEncoding('utf8')
    output.on('data', chunk => { text += String(chunk) })
    const ended = promiseWithResolvers<void>()
    const transport = new StdioJsonRpcTransport(input, output, 1024, {
      request: async frame => ({ method: frame.method }),
      notification: async () => undefined,
      eof: async () => { ended.resolve(undefined) },
      fatal: async error => { ended.reject(error) },
    })
    transport.start()
    input.end('{"jsonrpc":"2.0","id":1,"method":"one","params":{}}\n'
      + '{"jsonrpc":"2.0","id":"two","method":"two"}\r\n')
    await ended.promise
    await transport.flush()
    expect(text.trim().split('\n').map(line => JSON.parse(line) as unknown)).toEqual([
      { jsonrpc: '2.0', id: 1, result: { method: 'one' } },
      { jsonrpc: '2.0', id: 'two', result: { method: 'two' } },
    ])
  })

  it('reports scalar params as INVALID_PARAMS instead of normalizing them', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.setEncoding('utf8')
    output.on('data', chunk => { text += String(chunk) })
    const ended = promiseWithResolvers<void>()
    const transport = new StdioJsonRpcTransport(input, output, 1024, {
      request: async () => undefined,
      notification: async () => undefined,
      eof: async () => { ended.resolve(undefined) },
      fatal: async error => { ended.reject(error) },
    })
    transport.start()
    input.end('{"jsonrpc":"2.0","id":1,"method":"bad","params":[] }\n')
    await ended.promise
    await transport.flush()
    expect(JSON.parse(text).error.data.code).toBe('INVALID_PARAMS')
  })
})

function promiseWithResolvers<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}
