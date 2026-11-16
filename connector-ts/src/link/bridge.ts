import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Egress } from './egress.js'
import { connectOrigin } from './http.js'

const MAX_HEAD_BYTES = 64 * 1024

/** Rewrites the request line and `Host` of an HTTP/1.1 upgrade head so it targets `target`. */
export function rewriteUpgradeHead(head: string, target: URL): string {
  const lines = head.split('\r\n')
  const [method = 'GET', , version = 'HTTP/1.1'] = (lines[0] ?? '').split(' ')
  lines[0] = `${method} ${target.pathname}${target.search} ${version}`
  let hostSeen = false
  for (let index = 1; index < lines.length; index++) {
    if (/^host:/iu.test(lines[index]!)) {
      lines[index] = `Host: ${target.host}`
      hostSeen = true
    }
  }
  if (!hostSeen) lines.splice(1, 0, `Host: ${target.host}`)
  return lines.join('\r\n')
}

/**
 * MeshCall's Node runtime opens its WebSocket with neither an `agent` nor a `createConnection` hook, so it can
 * take no proxy and only Node's bundled CAs (`research/10` §6). Until upstream grows that option, the link points
 * MeshCall at this in-process relay instead (`unix://…`, a named pipe on Windows): each connection's upgrade
 * request gets the real path and Host, and the bytes go to the Router through `connectOrigin` (direct, HTTP
 * CONNECT or SOCKS5; TLS with the system CAs). MeshCall frames pass through untouched.
 */
export class RouterBridge {
  private server: Server | null = null
  private directory: string | null = null
  private readonly sockets = new Set<Socket>()
  private endpointValue: string | null = null

  public constructor(
    private readonly target: () => URL,
    private readonly egress: () => Egress,
    private readonly onError: (error: Error) => void = () => undefined,
  ) {}

  /** What to hand to `new Router(…)`: `unix://<path>` or `pipe://<name>`. */
  public get endpoint(): string {
    if (this.endpointValue === null) throw new Error('RouterBridge is not started')
    return this.endpointValue
  }

  public async start(): Promise<string> {
    if (this.endpointValue !== null) return this.endpointValue
    const server = createServer(socket => this.relay(socket))
    let listenOn: string
    if (process.platform === 'win32') {
      const name = `aa-mesh-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
      listenOn = `\\\\.\\pipe\\${name}`
      this.endpointValue = `pipe://${name}`
    } else {
      this.directory = mkdtempSync(join(tmpdir(), 'aa-mesh-'))
      listenOn = join(this.directory, 'r.sock')
      this.endpointValue = `unix://${listenOn}`
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(listenOn, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
    return this.endpointValue
  }

  public async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = null
    this.endpointValue = null
    if (server !== null) await new Promise<void>(resolve => server.close(() => resolve()))
    if (this.directory !== null) rmSync(this.directory, { recursive: true, force: true })
    this.directory = null
  }

  private relay(client: Socket): void {
    this.sockets.add(client)
    let buffered = Buffer.alloc(0)
    let upstream: Socket | null = null
    const fail = (error: Error): void => {
      this.onError(error)
      client.destroy()
      upstream?.destroy()
    }
    client.once('close', () => {
      this.sockets.delete(client)
      upstream?.destroy()
    })
    client.on('error', () => undefined)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buffered.length > MAX_HEAD_BYTES) fail(new Error('upgrade request head too large'))
        return
      }
      client.removeListener('data', onData)
      client.pause()
      const target = this.target()
      const head = rewriteUpgradeHead(buffered.subarray(0, end).toString('latin1'), target)
      const rest = buffered.subarray(end + 4)
      connectOrigin(target, this.egress()).then(socket => {
        upstream = socket
        if (client.destroyed) {
          socket.destroy()
          return
        }
        socket.on('error', () => client.destroy())
        socket.once('close', () => client.destroy())
        socket.write(Buffer.concat([Buffer.from(`${head}\r\n\r\n`, 'latin1'), rest]))
        socket.pipe(client)
        client.pipe(socket)
        client.resume()
      }, (error: Error) => fail(error))
    }
    client.on('data', onData)
  }
}
