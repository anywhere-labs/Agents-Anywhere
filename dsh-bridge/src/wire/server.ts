import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { BridgeError } from './errors.js'
import { MAX_FRAME_BYTES } from './protocol.js'
import { NdjsonTransport } from './transport.js'
import type {
  BridgeRequestHandler,
  JsonRpcNotification,
  JsonRpcRequest,
} from './types.js'
import { ProcessLock } from '../security/process-lock.js'
import {
  readOptionalJsonSecure,
  removeRegularFile,
  writeJsonAtomicSecure,
} from '../security/files.js'
import type { StateLayout } from '../security/paths.js'

const ENDPOINT_VERSION = 1
const MAX_PENDING_AUTHENTICATIONS = 16

interface EndpointRecord {
  version: 1
  host: '127.0.0.1'
  port: number
  token: string
  pid: number
  maxFrameBytes: number
}

interface Connection {
  socket: Socket
  transport: NdjsonTransport
  authenticated: boolean
  authenticationTimer: NodeJS.Timeout
  closed: boolean
}

export class LoopbackJsonRpcServer {
  private readonly token = randomBytes(32).toString('base64url')
  private readonly processLock: ProcessLock
  private server: Server | undefined
  private owner: Connection | undefined
  private readonly pending = new Set<Connection>()
  private endpoint: EndpointRecord | undefined
  private stopping = false

  constructor(
    private readonly layout: StateLayout,
    private readonly authenticationDeadlineMs: number,
    private readonly handler: BridgeRequestHandler,
  ) {
    this.processLock = new ProcessLock(layout.lockPath, layout.dshHome)
  }

  async start(): Promise<EndpointRecord> {
    if (this.server !== undefined) throw new Error('loopback server is already started')
    this.stopping = false
    await this.processLock.acquire()
    const server = createServer(socket => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('loopback server has no TCP address')
      const endpoint: EndpointRecord = {
        version: ENDPOINT_VERSION,
        host: '127.0.0.1',
        port: address.port,
        token: this.token,
        pid: process.pid,
        maxFrameBytes: MAX_FRAME_BYTES,
      }
      await writeJsonAtomicSecure(this.layout.endpointPath, endpoint)
      this.endpoint = endpoint
      return endpoint
    } catch (error: unknown) {
      server.close()
      this.server = undefined
      await this.processLock.release()
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    const connections = [...this.pending, ...(this.owner === undefined ? [] : [this.owner])]
    this.pending.clear()
    this.owner = undefined
    for (const connection of connections) this.closeConnection(connection)
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    const endpoint = await readOptionalJsonSecure<Partial<EndpointRecord>>(this.layout.endpointPath)
    if (endpoint?.version === ENDPOINT_VERSION
      && endpoint.pid === process.pid
      && endpoint.token === this.endpoint?.token) {
      await removeRegularFile(this.layout.endpointPath)
    }
    this.endpoint = undefined
    await this.processLock.release()
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const owner = this.owner
    if (owner === undefined || owner.closed || !owner.authenticated) {
      throw new BridgeError('NOT_INITIALIZED', 'No authenticated Connector owns the bridge.', { retryable: true })
    }
    await owner.transport.notify(method, params)
  }

  private accept(socket: Socket): void {
    if (this.stopping || this.pending.size >= MAX_PENDING_AUTHENTICATIONS) {
      socket.destroy()
      return
    }
    socket.setNoDelay(true)
    let connection: Connection
    const transport = new NdjsonTransport(socket, socket, {
      request: frame => this.request(connection, frame),
      notification: frame => this.notification(connection, frame),
      eof: () => this.disconnect(connection, 'connector-eof'),
      fatal: error => this.fatal(connection, error),
    })
    const authenticationTimer = setTimeout(() => {
      this.disconnect(connection, 'authentication-timeout').catch(() => undefined)
    }, this.authenticationDeadlineMs)
    authenticationTimer.unref()
    connection = {
      socket,
      transport,
      authenticated: false,
      authenticationTimer,
      closed: false,
    }
    this.pending.add(connection)
    transport.start()
  }

  private async request(connection: Connection, frame: JsonRpcRequest): Promise<unknown> {
    if (!connection.authenticated) {
      if (frame.method !== 'initialize') {
        this.rejectAuthentication(connection)
        throw new BridgeError('NOT_INITIALIZED', 'initialize must be the first request.', { retryable: false })
      }
      const authToken = frame.params.authToken
      if (typeof authToken !== 'string' || !constantTimeTokenEquals(authToken, this.token)) {
        this.rejectAuthentication(connection)
        throw new BridgeError('INVALID_REQUEST', 'Connector authentication failed.', {
          retryable: false,
          details: { code: 'AUTHENTICATION_FAILED' },
        })
      }
      if (this.owner !== undefined && this.owner !== connection) {
        this.rejectAuthentication(connection)
        throw new BridgeError('SESSION_CONFLICT', 'An authenticated Connector already owns the bridge.', {
          retryable: true,
          details: { code: 'CONNECTOR_OWNERSHIP_CONFLICT' },
        })
      }
      clearTimeout(connection.authenticationTimer)
      this.pending.delete(connection)
      connection.authenticated = true
      this.owner = connection
      const params = { ...frame.params }
      delete params.authToken
      try {
        return await this.handler.request({ ...frame, params })
      } catch (error: unknown) {
        await this.disconnect(connection, 'initialize-failed')
        throw error
      }
    }
    if (this.owner !== connection) {
      this.closeConnection(connection)
      throw new BridgeError('NOT_INITIALIZED', 'Connector no longer owns the bridge.', { retryable: true })
    }
    return this.handler.request(frame)
  }

  private async notification(connection: Connection, frame: JsonRpcNotification): Promise<void> {
    if (!connection.authenticated || this.owner !== connection) {
      this.rejectAuthentication(connection)
      return
    }
    await this.handler.notification(frame)
  }

  private rejectAuthentication(connection: Connection): void {
    connection.transport.stopInput()
    clearTimeout(connection.authenticationTimer)
    this.pending.delete(connection)
    setImmediate(() => {
      if (!connection.closed) connection.socket.end()
      const destroyTimer = setTimeout(() => this.closeConnection(connection), 100)
      destroyTimer.unref()
    })
  }

  private async fatal(connection: Connection, error: BridgeError): Promise<void> {
    await this.disconnect(connection, error.data.code)
    await this.handler.fatal(error)
  }

  private async disconnect(connection: Connection, reason: string): Promise<void> {
    if (connection.closed) return
    const wasOwner = this.owner === connection
    if (wasOwner) this.owner = undefined
    this.pending.delete(connection)
    this.closeConnection(connection)
    if (wasOwner) await this.handler.disconnected(reason)
  }

  private closeConnection(connection: Connection): void {
    if (connection.closed) return
    connection.closed = true
    clearTimeout(connection.authenticationTimer)
    connection.transport.stopInput()
    connection.socket.destroy()
  }
}

function constantTimeTokenEquals(candidate: string, expected: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(candidateDigest, expectedDigest)
}
