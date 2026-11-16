import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls'
import type { Duplex } from 'node:stream'

import type { Egress } from './egress.js'
import { openTunnel, trustedCAs } from './tunnel.js'

/**
 * A byte stream to the origin of `url` through `egress` (direct, HTTP CONNECT or SOCKS5), TLS-wrapped for
 * `https:`/`wss:` with the system CAs. Resolved once the TLS handshake (or the TCP connect) is done; flowing.
 */
export async function connectOrigin(url: URL, egress: Egress, timeoutMs = 15_000): Promise<Socket | TLSSocket> {
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  const host = url.hostname.replace(/^\[|\]$/gu, '')
  const port = url.port !== '' ? Number(url.port) : secure ? 443 : 80
  const raw = await openTunnel(egress, host, port, timeoutMs)
  if (!secure) {
    raw.resume()
    return raw
  }
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ socket: raw, servername: isIP(host) === 0 ? host : undefined, ca: trustedCAs(), ALPNProtocols: ['http/1.1'] } as ConnectionOptions)
    const timer = setTimeout(() => socket.destroy(new Error(`TLS handshake with ${host}:${port} timed out`)), timeoutMs)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      socket.removeListener('error', onError)
      resolve(socket)
    })
    const onError = (error: Error): void => {
      clearTimeout(timer)
      raw.destroy()
      reject(error)
    }
    socket.once('error', onError)
    raw.resume()
  })
}

export class HttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
    public readonly body: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export interface JsonRequest {
  readonly method: 'GET' | 'POST'
  readonly url: URL
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** FastAPI puts `{code, message}` under `detail`; plain strings stay messages. */
function errorOf(status: number, body: unknown, text: string): HttpError {
  const detail = (body as { detail?: unknown } | null)?.detail ?? body
  if (detail !== null && typeof detail === 'object') {
    const coded = detail as { code?: unknown; message?: unknown }
    return new HttpError(status, typeof coded.code === 'string' ? coded.code : null, typeof coded.message === 'string' ? coded.message : `HTTP ${status}`, body)
  }
  return new HttpError(status, null, typeof detail === 'string' ? `HTTP ${status}: ${detail}` : `HTTP ${status} ${text.replace(/\s+/gu, ' ').slice(0, 200)}`, body)
}

/**
 * One JSON request over `connectOrigin` (so it follows the same proxy and CA rules as the MeshCall link). No
 * connection reuse: the handshake calls are rare.
 */
export async function requestJson<T>(egress: () => Egress, options: JsonRequest): Promise<T> {
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
  const timeoutMs = options.timeoutMs ?? 15_000
  const socket = await connectOrigin(options.url, egress(), timeoutMs)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, value?: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      if (error !== null) reject(error)
      else resolve(value as T)
    }
    const onAbort = (): void => finish(new Error('request aborted'))
    const timer = setTimeout(() => finish(new Error(`${options.method} ${options.url.pathname} timed out`)), timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted === true) return onAbort()
    const req: ClientRequest = httpRequest({
      method: options.method,
      host: options.url.hostname,
      port: options.url.port,
      path: options.url.pathname + options.url.search,
      headers: {
        host: options.url.host,
        accept: 'application/json',
        ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...options.headers,
      },
      createConnection: () => socket as Duplex as Socket,
    }, (response: IncomingMessage) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('error', error => finish(error))
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = null
        try {
          body = text === '' ? null : JSON.parse(text)
        } catch {
          body = text
        }
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) return finish(errorOf(status, body, text))
        if (typeof body === 'string') return finish(new HttpError(status, null, `not JSON: ${text.slice(0, 200)}`, body))
        finish(null, body as T)
      })
    })
    req.once('error', error => finish(error))
    req.end(payload)
  })
}

export interface BytesRequest {
  readonly url: URL
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  /** Refuse a body larger than this (default 512 MiB). */
  readonly maxBytes?: number
}

/** One `GET` whose body is bytes (an attachment), over the same egress as `requestJson`. Non-2xx throws `HttpError`. */
export async function requestBytes(egress: () => Egress, options: BytesRequest): Promise<{ body: Buffer; headers: IncomingMessage['headers'] }> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024
  const socket = await connectOrigin(options.url, egress(), Math.min(timeoutMs, 15_000))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, value?: { body: Buffer; headers: IncomingMessage['headers'] }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      if (error !== null) reject(error)
      else resolve(value!)
    }
    const onAbort = (): void => finish(new Error('request aborted'))
    const timer = setTimeout(() => finish(new Error(`GET ${options.url.pathname} timed out`)), timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted === true) return onAbort()
    const req: ClientRequest = httpRequest({
      method: 'GET',
      host: options.url.hostname,
      port: options.url.port,
      path: options.url.pathname + options.url.search,
      headers: { host: options.url.host, ...options.headers },
      createConnection: () => socket as Duplex as Socket,
    }, (response: IncomingMessage) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) return finish(new HttpError(413, 'too_large', `${options.url.pathname}: more than ${maxBytes} bytes`, null))
        chunks.push(chunk)
      })
      response.once('error', error => finish(error))
      response.once('end', () => {
        const body = Buffer.concat(chunks)
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          const text = body.toString('utf8')
          let parsed: unknown = text
          try {
            parsed = JSON.parse(text)
          } catch {
            // Not JSON.
          }
          return finish(errorOf(status, parsed, text))
        }
        finish(null, { body, headers: response.headers })
      })
    })
    req.once('error', error => finish(error))
    req.end()
  })
}
