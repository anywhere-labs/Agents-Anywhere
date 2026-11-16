// A real MeshCall Router plus a minimal stand-in for the Server's device link (hello/ready over HTTP, one worker
// Mesh client holding Link/attach and Link/outbox), for link tests and the S6 measurements. Mirrors
// server/agent_server/{api,services,infra}/device_link.py on feat/be/v3-session-watch.
import { spawn, type ChildProcess } from 'node:child_process'
import { pbkdf2Sync, randomBytes } from 'node:crypto'
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { connect as netConnect, createServer as createNetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Mesh, Router, RouterCredentials, type RpcStream } from 'meshcall'

export const DEVICE_SERVICES = ['aa.device.v1.Link', 'aa.device.v1.Sessions', 'aa.device.v1.Store', 'aa.device.v1.Runtime', 'aa.device.v1.Commands', 'aa.device.v1.Secure']

export function routerBinary(): string | null {
  const candidates = [process.env.MESHCALL_ROUTER_BINARY, '/tmp/aa-mc/bin/meshcall-router'].filter((value): value is string => typeof value === 'string' && value !== '')
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {
      // next
    }
  }
  return null
}

export async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function waitListening(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const socket = netConnect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (ok) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`router did not listen on ${port}`)
}

/** The Router binary on a fixed port, restartable (it keeps no state: tokens and registrations die with it). */
export class RouterProcess {
  public readonly password = randomBytes(12).toString('hex')
  private child: ChildProcess | null = null
  private readonly dir = mkdtempSync(join(tmpdir(), 'aa-router-'))
  public port = 0
  public metricsPort = 0

  public constructor(private readonly binary: string, private readonly extraArgs: readonly string[] = []) {
    const salt = randomBytes(16)
    const key = pbkdf2Sync(this.password, salt, 600_000, 32, 'sha256')
    const call = [...DEVICE_SERVICES.map(name => `${name}/*`), ...['issue_token', 'revoke_token', 'renew_token', 'list_tokens', 'whoami'].map(m => `meshcall.router.v1.AuthService/${m}`), 'meshcall.router.v1.Registry/*']
    writeFileSync(join(this.dir, 'auth.json'), JSON.stringify({ users: [{ username: 'aa-server', password_hash: `pbkdf2-sha256$600000$${salt.toString('hex')}$${key.toString('hex')}`, roles: ['client', 'server'], register: DEVICE_SERVICES, call }] }))
  }

  public get url(): string {
    return `ws://127.0.0.1:${this.port}`
  }

  public get pid(): number | undefined {
    return this.child?.pid
  }

  public async start(): Promise<void> {
    if (this.port === 0) this.port = await freePort()
    if (this.metricsPort === 0) this.metricsPort = await freePort()
    this.child = spawn(this.binary, ['--host', '127.0.0.1', '--port', String(this.port), '--auth-file', join(this.dir, 'auth.json'), '--max-frame-size', '4194304', '--max-calls-per-connection', '0', '--metrics-listen', `127.0.0.1:${this.metricsPort}`, ...this.extraArgs], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    this.child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })
    const child = this.child
    const exited = new Promise<never>((_resolve, reject) => child.once('exit', code => reject(new Error(`router exited (${code}): ${stderr}`))))
    exited.catch(() => undefined)
    await Promise.race([waitListening(this.port), exited])
  }

  public async kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    const child = this.child
    this.child = null
    if (child === null || child.exitCode !== null) return
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve())
      child.kill(signal)
    })
  }

  public async close(): Promise<void> {
    await this.kill('SIGTERM')
    rmSync(this.dir, { recursive: true, force: true })
  }
}

export interface OutboxSeen {
  readonly oid: number
  readonly m: string
  readonly p: Record<string, unknown>
}

interface Held {
  readonly connectionId: string
  readonly worker: Mesh
  attach: RpcStream<Record<string, unknown>> | null
  outbox: RpcStream<Record<string, unknown>> | null
  heartbeats: number
  events: { m: string; p: Record<string, unknown> }[]
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('error', reject)
    request.once('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      resolve(text === '' ? {} : JSON.parse(text) as Record<string, unknown>)
    })
  })
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** The Server's side of the handshake and the holder worker. */
export class FakeServer {
  private http: HttpServer | null = null
  public port = 0
  public deviceId: string
  private readonly credential: string
  public connectionId: string | null = null
  private tokenId: string | null = null
  private generation = 0
  public held: Held | null = null
  public readonly outbox: OutboxSeen[] = []
  public readonly calls: string[] = []
  public pendingCommands: Record<string, unknown>[] = []
  public seqFloors: Record<string, number> = {}
  public e2eeMode: 'off' | 'required' = 'off'
  public tokenTtlSeconds = 900
  /** The Server revokes the previous token on every hello (kicks a half-dead link); off only to measure without it. */
  public revokeOnHello = true
  public hellos = 0
  public readies = 0
  public readyFailures = 0
  /** Ask the device to dial this instead of the Router itself (a proxy in front, say). */
  public routerUrlOverride: string | null = null

  public constructor(private readonly router: RouterProcess, deviceId = 'dev_test') {
    this.deviceId = deviceId
    this.credential = `ct_${randomBytes(8).toString('hex')}`
  }

  public get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  public get deviceCredential(): { deviceId: string; token: string } {
    return { deviceId: this.deviceId, token: this.credential }
  }

  public worker(): Mesh {
    return new Mesh(new Router(this.router.url), { credentials: RouterCredentials.basic('aa-server', this.router.password), reconnect: { enabled: false } })
  }

  public async start(): Promise<void> {
    this.http = createHttpServer((request, response) => {
      this.route(request, response).catch(error => send(response, 500, { detail: String(error) }))
    })
    await new Promise<void>(resolve => this.http!.listen(0, '127.0.0.1', resolve))
    this.port = (this.http.address() as { port: number }).port
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request)
    const auth = request.headers.authorization ?? ''
    this.calls.push(request.url ?? '')
    if (request.url === '/api/v3/device/auth') {
      if (auth !== `Connector ${this.deviceId}:${this.credential}`) return send(response, 401, { detail: 'invalid connector credential' })
      return send(response, 200, { accessToken: `at_${this.deviceId}`, expiresIn: 900 })
    }
    if (auth !== `Bearer at_${this.deviceId}`) return send(response, 401, { detail: 'invalid connector access token' })
    if (request.url === '/api/v3/device/hello') return send(response, 200, await this.hello(body))
    if (request.url === '/api/v3/device/ready') {
      this.readies++
      const result = await this.ready(String(body.connectionId))
      if (result !== null) {
        this.readyFailures++
        return send(response, result.status, { detail: { code: result.code, message: result.code } })
      }
      return send(response, 200, { connectionId: body.connectionId, held: true })
    }
    send(response, 404, { detail: 'not found' })
  }

  private async hello(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.hellos++
    if (body.deviceId !== this.deviceId) throw new Error('device mismatch')
    const services = this.e2eeMode === 'required' ? ['aa.device.v1.Link', 'aa.device.v1.Commands', 'aa.device.v1.Secure'] : DEVICE_SERVICES.filter(name => name !== 'aa.device.v1.Secure')
    const worker = this.worker()
    try {
      const issued = await worker.auth.issueToken(services.map(service => ({ service, register: true, instance_ids: [this.deviceId] })), this.tokenTtlSeconds)
      const previous = this.tokenId
      this.tokenId = issued.token_id
      this.connectionId = `lc_${++this.generation}`
      if (previous !== null && this.revokeOnHello) await worker.auth.revokeToken(previous).catch(() => false)
      const pending = this.pendingCommands
      this.pendingCommands = []
      return {
        contractVersion: '1.0',
        serverVersion: '3.0.0-test',
        connectionId: this.connectionId,
        seqFloors: this.seqFloors,
        e2eeMode: this.e2eeMode,
        desired: { runtimes: [], deviceSettings: {}, channelSwitches: [] },
        pendingCommands: pending,
        mesh: {
          routerUrl: this.routerUrlOverride ?? this.router.url,
          token: issued.token,
          tokenId: issued.token_id,
          expiresAt: new Date(issued.expires_at_unix_ms).toISOString(),
          instanceId: this.deviceId,
          services,
          maxFrameBytes: 4 * 1024 * 1024,
        },
      }
    } finally {
      await worker.close().catch(() => undefined)
    }
  }

  /** Revokes the device's current Router token (credentials revoked, or a half-dead link to kick). */
  public async revokeToken(): Promise<void> {
    if (this.tokenId === null) return
    const worker = this.worker()
    try {
      await worker.auth.revokeToken(this.tokenId)
    } finally {
      await worker.close().catch(() => undefined)
    }
  }

  private async ready(connectionId: string): Promise<{ status: number; code: string } | null> {
    if (connectionId !== this.connectionId) return { status: 409, code: 'connection_replaced' }
    await this.drop()
    const worker = this.worker()
    const held: Held = { connectionId, worker, attach: null, outbox: null, heartbeats: 0, events: [] }
    const options = { instance: this.deviceId, metadata: { 'aa-connection-id': connectionId } }
    const attach = worker.serverStream<Record<string, unknown>, Record<string, unknown>>('aa.device.v1.Link', 'attach', { connectionId }, options)
    held.attach = attach
    const first = await Promise.race([
      attach.next().then(next => (next.done === true ? null : next.value)),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
    ]).catch(() => null)
    if (first === null) {
      await worker.close().catch(() => undefined)
      return { status: 409, code: 'attach_failed' }
    }
    held.heartbeats++
    this.held = held
    void (async () => {
      try {
        for await (const item of attach) {
          if (item.kind === 'heartbeat') held.heartbeats++
          else held.events.push({ m: String(item.m), p: (item.p ?? {}) as Record<string, unknown> })
        }
      } catch {
        // the stream ended with the worker
      }
    })()
    const outbox = worker.serverStream<Record<string, unknown>, Record<string, unknown>>('aa.device.v1.Link', 'outbox', { connectionId }, options)
    held.outbox = outbox
    void (async () => {
      try {
        for await (const item of outbox) {
          this.outbox.push({ oid: Number(item.oid), m: String(item.m), p: (item.p ?? {}) as Record<string, unknown> })
          await worker.unary('aa.device.v1.Link', 'ackOutbox', { oid: item.oid }, options)
        }
      } catch {
        // ended
      }
    })()
    return null
  }

  /** The holder worker dies (its Mesh connection closes; the Router cancels the device's streams). */
  public async drop(): Promise<void> {
    const held = this.held
    this.held = null
    if (held !== null) await held.worker.close().catch(() => undefined)
  }

  /** A call as some worker would make it, with the current (or a given) generation. */
  public async call<T>(service: string, method: string, request: Record<string, unknown>, connectionId = this.connectionId): Promise<T> {
    const worker = this.worker()
    try {
      return await worker.unary<Record<string, unknown>, T>(service, method, request, { instance: this.deviceId, metadata: { 'aa-connection-id': connectionId ?? '' }, timeoutMs: 10_000 })
    } finally {
      await worker.close().catch(() => undefined)
    }
  }

  public async stream<T>(service: string, method: string, request: Record<string, unknown>): Promise<T[]> {
    const worker = this.worker()
    try {
      const items: T[] = []
      for await (const item of worker.serverStream<Record<string, unknown>, T>(service, method, request, { instance: this.deviceId, metadata: { 'aa-connection-id': this.connectionId ?? '' }, timeoutMs: 10_000 })) items.push(item)
      return items
    } finally {
      await worker.close().catch(() => undefined)
    }
  }

  public async close(): Promise<void> {
    await this.drop()
    if (this.http !== null) await new Promise<void>(resolve => this.http!.close(() => resolve()))
    this.http = null
  }
}

/** A plain HTTP CONNECT proxy that counts the tunnels it opened. */
export class ConnectProxy {
  private server: HttpServer | null = null
  public port = 0
  public tunnels = 0
  private readonly sockets = new Set<Socket>()

  public async start(port = 0): Promise<void> {
    this.server = createHttpServer((_request, response) => {
      response.writeHead(405)
      response.end()
    })
    this.server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
      const [host = '', port = '0'] = (request.url ?? '').split(':')
      const upstream = netConnect({ host, port: Number(port) }, () => {
        this.tunnels++
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      this.sockets.add(client)
      this.sockets.add(upstream)
      const drop = (): void => {
        client.destroy()
        upstream.destroy()
      }
      upstream.on('error', drop)
      client.on('error', drop)
      client.once('close', () => this.sockets.delete(client))
      upstream.once('close', () => this.sockets.delete(upstream))
    })
    await new Promise<void>(resolve => this.server!.listen(port, '127.0.0.1', resolve))
    this.port = (this.server.address() as { port: number }).port
  }

  public get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  public async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (this.server !== null) await new Promise<void>(resolve => this.server!.close(() => resolve()))
    this.server = null
  }
}
