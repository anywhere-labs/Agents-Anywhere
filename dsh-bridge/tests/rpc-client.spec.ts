/**
 * Tests for the newline-delimited JSON-RPC client.
 *
 * Strategy: drive the client with an in-memory transport composed of two
 * PassThrough streams. We assert the wire shapes against the buffer fed
 * to the writable end and resolve pending requests against notifications
 * read from the readable end.
 */

import { PassThrough, Writable, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { RpcClient, type RpcClientTransport } from '../src/manager/rpc-client.js'
import { JsonRpcError } from '../src/manager/jsonrpc.js'

interface Harness {
  client: RpcClient
  /** Bytes the client wrote to stdin. */
  written: Buffer[]
  /** Push a line onto the server-to-client stream. */
  feed(line: string): void
  /** Close the server-to-client stream to simulate transport exit. */
  close(): void
}

function makeClient(): Harness {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const written: Buffer[] = []
  ;(stdin as unknown as Writable).on('data', (chunk: Buffer) => written.push(chunk))

  const transport: RpcClientTransport = {
    getStdin: () => stdin as unknown as NodeJS.WritableStream,
    getStdout: () => stdout as unknown as NodeJS.ReadableStream,
    onLog: () => () => undefined,
    onExit: () => () => undefined,
  }
  const client = new RpcClient(transport)
  return {
    client,
    written,
    feed: (line) => stdout.write(`${line}\n`),
    close: () => stdout.end(),
  }
}

describe('RpcClient', () => {
  it('writes newline-delimited JSON requests to stdin', () => {
    const harness = makeClient()
    void harness.client.send('connector.getState')
    expect(harness.written.length).toBe(1)
    const frame = JSON.parse(harness.written[0]!.toString('utf8').trimEnd()) as Record<string, unknown>
    expect(frame.jsonrpc).toBe('2.0')
    expect(frame.method).toBe('connector.getState')
    expect(typeof frame.id).toBe('string')
  })

  it('resolves the matching pending request when the server replies', async () => {
    const harness = makeClient()
    const promise = harness.client.send<{ ok: boolean }>('connector.start')
    // Allow the synchronous write to flush.
    await Promise.resolve()
    const frame = JSON.parse(harness.written[0]!.toString('utf8').trimEnd()) as Record<string, unknown>
    harness.feed(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true } }))
    await expect(promise).resolves.toEqual({ ok: true })
  })

  it('rejects the matching pending request on an error frame', async () => {
    const harness = makeClient()
    const promise = harness.client.send('connector.start')
    await Promise.resolve()
    const frame = JSON.parse(harness.written[0]!.toString('utf8').trimEnd()) as Record<string, unknown>
    harness.feed(JSON.stringify({
      jsonrpc: '2.0',
      id: frame.id,
      error: { code: -32603, message: 'uv crashed' },
    }))
    await expect(promise).rejects.toBeInstanceOf(JsonRpcError)
    await expect(promise).rejects.toMatchObject({ code: -32603, message: 'uv crashed' })
  })

  it('emits a notification event for inbound server-pushed frames without an id', () => {
    const harness = makeClient()
    const received: Array<{ method: string; params: unknown }> = []
    harness.client.on('notification', (method, params) => received.push({ method, params }))
    harness.feed(JSON.stringify({ jsonrpc: '2.0', method: 'connector.state', params: { runtime: 'running' } }))
    expect(received).toEqual([{ method: 'connector.state', params: { runtime: 'running' } }])
  })

  it('buffers a partial frame until the newline arrives', () => {
    const harness = makeClient()
    const received: Array<{ method: string }> = []
    harness.client.on('notification', (method) => received.push({ method }))
    // Write half the frame, then the rest.
    const half = '{"jsonrpc":"2.0","method":"connector.'
    harness.client.emit // touch
    void harness.client
    const stdout = (harness.client as unknown as { transport: RpcClientTransport }).transport.getStdout() as PassThrough
    stdout.write(half)
    stdout.write('state","params":{}}\n')
    expect(received).toEqual([{ method: 'connector.state' }])
  })

  it('flags malformed JSON frames with an error event instead of throwing', () => {
    const harness = makeClient()
    const errors: Error[] = []
    harness.client.on('error', (e) => errors.push(e))
    harness.feed('not-json{{{}')
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toMatch(/invalid JSON/)
  })

  it('rejects pending requests when the transport exits', async () => {
    const harness = makeClient()
    const promise = harness.client.send('connector.getState')
    await Promise.resolve()
    harness.close()
    await expect(promise).rejects.toThrow(/transport exited|closed/)
  })
})