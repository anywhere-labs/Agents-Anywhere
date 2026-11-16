// Connections through the proxy that `resolveEgress` chose: HTTP CONNECT (to an http or https proxy) and SOCKS5,
// with no extra dependency, so HTTPS requests, the MeshCall WebSocket and frpc can all share one route. The
// returned socket is a plain TCP stream to the target; TLS to the Server goes on top with the system CAs.
import { Agent as HttpsAgent, type AgentOptions } from 'node:https'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, getCACertificates, rootCertificates, type ConnectionOptions } from 'node:tls'
import type { Duplex } from 'node:stream'

import { redactProxy, type Egress } from './egress.js'

export class ProxyError extends Error {
  public readonly code = 'proxy_failed'
}

/**
 * The CAs to trust: Node's bundle plus the operating system's store where this Node exposes it (macOS keychain,
 * Windows store; a company root lives there). `NODE_EXTRA_CA_CERTS` keeps working on top.
 */
export function trustedCAs(): string[] {
  const all = new Set<string>(rootCertificates)
  try {
    for (const cert of getCACertificates('system')) all.add(cert)
    for (const cert of getCACertificates('extra')) all.add(cert)
  } catch {
    // Older Node: the bundle only.
  }
  return [...all]
}

/**
 * Reads a proxy handshake from one `data` listener, so nothing is lost between steps. `release()` pauses the
 * socket and puts back what came after the handshake; the consumer resumes it (TLS does this itself).
 */
class HandshakeReader {
  private buffer = Buffer.alloc(0)
  private failure: Error | null = null
  private wake: (() => void) | undefined
  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.wake?.()
  }
  private readonly onEnd = (error?: Error): void => {
    this.failure = error instanceof Error ? error : new ProxyError('proxy closed the connection')
    this.wake?.()
  }

  public constructor(private readonly socket: Socket) {
    socket.on('data', this.onData)
    socket.once('error', this.onEnd)
    socket.once('close', this.onEnd)
  }

  private async until<T>(take: () => T | undefined): Promise<T> {
    for (;;) {
      const value = take()
      if (value !== undefined) return value
      if (this.failure !== null) throw this.failure
      await new Promise<void>(resolve => {
        this.wake = resolve
      })
      this.wake = undefined
    }
  }

  public bytes(count: number): Promise<Buffer> {
    return this.until(() => {
      if (this.buffer.length < count) return undefined
      const out = this.buffer.subarray(0, count)
      this.buffer = this.buffer.subarray(count)
      return out
    })
  }

  public head(limit = 16 * 1024): Promise<string> {
    return this.until(() => {
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end < 0) {
        if (this.buffer.length > limit) throw new ProxyError('proxy response header too large')
        return undefined
      }
      const text = this.buffer.subarray(0, end).toString('latin1')
      this.buffer = this.buffer.subarray(end + 4)
      return text
    })
  }

  public release(): void {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onEnd)
    this.socket.off('close', this.onEnd)
    this.socket.pause()
    if (this.buffer.length > 0) this.socket.unshift(this.buffer)
  }
}

function connected(socket: Socket, event: 'connect' | 'secureConnect'): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(event, () => resolve())
    socket.once('error', reject)
  })
}

async function httpConnect(proxy: URL, host: string, port: number, timeoutMs: number): Promise<Socket> {
  const proxyPort = proxy.port === '' ? (proxy.protocol === 'https:' ? 443 : 80) : Number(proxy.port)
  const proxyHost = proxy.hostname.replace(/^\[|\]$/gu, '')
  const socket: Socket = proxy.protocol === 'https:'
    ? tlsConnect({ host: proxyHost, port: proxyPort, servername: isIP(proxyHost) === 0 ? proxyHost : undefined, ca: trustedCAs() } as ConnectionOptions)
    : netConnect({ host: proxyHost, port: proxyPort })
  socket.setTimeout(timeoutMs, () => socket.destroy(new ProxyError(`proxy ${redactProxy(proxy.href)} timed out`)))
  await connected(socket, proxy.protocol === 'https:' ? 'secureConnect' : 'connect')
  const authority = isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`
  const auth = proxy.username !== '' ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n` : ''
  const reader = new HandshakeReader(socket)
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`)
  const head = await reader.head().catch((error: unknown) => {
    socket.destroy()
    throw error
  })
  const status = /^HTTP\/1\.[01] (\d{3})/u.exec(head)?.[1]
  if (status !== '200') {
    socket.destroy()
    throw new ProxyError(`proxy refused CONNECT ${authority}: ${head.split('\r\n')[0] ?? ''}`)
  }
  reader.release()
  socket.setTimeout(0)
  return socket
}

async function socks5Connect(proxy: URL, host: string, port: number, timeoutMs: number): Promise<Socket> {
  const socket = netConnect({ host: proxy.hostname.replace(/^\[|\]$/gu, ''), port: proxy.port === '' ? 1080 : Number(proxy.port) })
  socket.setTimeout(timeoutMs, () => socket.destroy(new ProxyError(`proxy ${redactProxy(proxy.href)} timed out`)))
  await connected(socket, 'connect')
  const reader = new HandshakeReader(socket)
  try {
    await socks5Handshake(socket, reader, proxy, host, port)
  } catch (error) {
    socket.destroy()
    throw error
  }
  reader.release()
  socket.setTimeout(0)
  return socket
}

async function socks5Handshake(socket: Socket, reader: HandshakeReader, proxy: URL, host: string, port: number): Promise<void> {
  const user = decodeURIComponent(proxy.username)
  const password = decodeURIComponent(proxy.password)
  socket.write(Buffer.from(user !== '' ? [5, 2, 0, 2] : [5, 1, 0]))
  const [version, method] = await reader.bytes(2)
  if (version !== 5 || method === 0xff) throw new ProxyError('SOCKS5 proxy refused every authentication method')
  if (method === 2) {
    socket.write(Buffer.concat([Buffer.from([1, Buffer.byteLength(user)]), Buffer.from(user), Buffer.from([Buffer.byteLength(password)]), Buffer.from(password)]))
    const [, status] = await reader.bytes(2)
    if (status !== 0) throw new ProxyError('SOCKS5 proxy rejected the credentials')
  }
  // socks5h: the proxy resolves names; plain socks5 is treated the same (the proxy usually sits where DNS works).
  let address: Buffer
  const kind = isIP(host)
  if (kind === 4) address = Buffer.from([1, ...host.split('.').map(Number)])
  else if (kind === 6) {
    const groups = host.split('::')
    const left = groups[0] === '' ? [] : groups[0]!.split(':')
    const right = groups.length > 1 && groups[1] !== '' ? groups[1]!.split(':') : []
    const all = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    address = Buffer.from([4, ...all.flatMap(group => {
      const value = parseInt(group || '0', 16)
      return [value >> 8, value & 0xff]
    })])
  } else address = Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)])
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 0xff])]))
  const reply = await reader.bytes(4)
  if (reply[1] !== 0) throw new ProxyError(`SOCKS5 proxy could not connect to ${host}:${port} (code ${reply[1]})`)
  const skip = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await reader.bytes(1))[0]!
  await reader.bytes(skip + 2)
}

/** A TCP stream to `host:port`, through the proxy of `egress` or directly; paused (call `resume()` after attaching listeners). */
export async function openTunnel(egress: Egress, host: string, port: number, timeoutMs = 15_000): Promise<Socket> {
  const target = host.replace(/^\[|\]$/gu, '')
  if (egress.proxy === null) {
    const socket = netConnect({ host: target, port })
    socket.setTimeout(timeoutMs, () => socket.destroy(new ProxyError(`connecting to ${target}:${port} timed out`)))
    await connected(socket, 'connect')
    socket.setTimeout(0)
    socket.pause()
    return socket
  }
  const proxy = new URL(egress.proxy)
  return proxy.protocol.startsWith('socks5') ? socks5Connect(proxy, target, port, timeoutMs) : httpConnect(proxy, target, port, timeoutMs)
}

/**
 * An HTTPS agent whose connections take `route()` (re-read on every connection, so a proxy switched on or off is
 * picked up without restarting) and trust the system CAs.
 */
export function egressAgent(route: () => Egress, options: AgentOptions = {}): HttpsAgent {
  const agent = new HttpsAgent({ keepAlive: true, ...options, ca: trustedCAs() })
  ;(agent as unknown as { createConnection: unknown }).createConnection = (
    connectOptions: { host?: string; hostname?: string; port?: number; servername?: string },
    callback: (error: Error | null, socket?: Duplex) => void,
  ): undefined => {
    const host = connectOptions.hostname ?? connectOptions.host ?? 'localhost'
    const port = Number(connectOptions.port ?? 443)
    openTunnel(route(), host, port).then(raw => {
      const secure = tlsConnect({ socket: raw, servername: connectOptions.servername ?? (isIP(host) === 0 ? host : undefined), ca: trustedCAs() } as ConnectionOptions)
      secure.once('secureConnect', () => callback(null, secure))
      secure.once('error', error => callback(error))
    }, (error: Error) => callback(error))
    return undefined
  }
  return agent
}
