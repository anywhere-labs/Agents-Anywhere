import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { acquireManagerLock } from '../storage/files.js'
import { BridgeError, publicError } from './errors.js'
import { RuntimeRouter, type SessionReader } from './router.js'
import { record } from './types.js'
import { quietDiagnostics, type RuntimeDiagnostics } from './diagnostics.js'

export const MAX_FRAME_BYTES = 8 * 1024 * 1024
export interface Endpoint { version: 1, host: '127.0.0.1', port: number, token: string, pid: number }

async function endpointAt(path: string): Promise<Record<string, unknown> | undefined> {
  try { return record(JSON.parse(await readFile(path, 'utf8'))) }
  catch (error) { if (record(error).code === 'ENOENT') return undefined; throw error }
}

/** Private loopback transport. Discovery probes can coexist with a Connector connection. */
export class RuntimeServer {
  private server: Server | undefined
  private endpoint: Endpoint | undefined
  private readonly sockets = new Set<Socket>()
  private closed = false
  private startTask: Promise<Endpoint> | undefined
  private closeTask: Promise<void> | undefined
  private releaseLease: (() => Promise<void>) | undefined

  constructor(readonly endpointPath: string, private readonly reader: SessionReader,
    private readonly diagnostics: RuntimeDiagnostics = reader.native?.diagnostics ?? quietDiagnostics,
    private readonly requestTimeoutMs = 60_000) {}

  start(): Promise<Endpoint> {
    if (!this.startTask) {
      const task = this.openWithLease()
      this.startTask = task
      void task.catch(() => { if (!this.closed && this.startTask === task) this.startTask = undefined })
    }
    return this.startTask
  }

  private async openWithLease(): Promise<Endpoint> {
    // Reuse the process-scoped OS lease; a crash releases it automatically.
    // It serializes stale-file takeover as well as publication and disposal.
    try {
      this.releaseLease = await acquireManagerLock(this.endpointPath, () => { void this.close().catch(() => undefined) })
      return await this.open()
    }
    catch (error) {
      this.diagnostics.log('error', 'bridge.start_failed', {}, error)
      await this.releaseLease?.()
      this.releaseLease = undefined
      throw error
    }
  }

  private async open(): Promise<Endpoint> {
    if (this.closed) throw new Error('DSH runtime is disposed')
    const token = randomBytes(32).toString('base64url')
    this.server = createServer(socket => this.accept(socket, token))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => { this.server!.off('error', reject); resolve() })
    })
    this.server.on('error', () => { for (const socket of this.sockets) socket.destroy() })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('DSH runtime did not bind a TCP port')
    const endpoint: Endpoint = { version: 1, host: '127.0.0.1', port: address.port, token, pid: process.pid }
    try {
      await mkdir(dirname(this.endpointPath), { recursive: true, mode: 0o700 })
      const existing = await endpointAt(this.endpointPath)
      // The manager lease is the ownership authority. A live bridge holds the
      // directory-derived lease port, so reaching this point already proves no
      // live bridge owns this path. A recorded pid is not evidence either way:
      // the OS can hand a crashed bridge's pid to an unrelated process, which
      // used to block startup until the stale file was deleted by hand.
      if (existing) await unlink(this.endpointPath)
      // Link publishes a complete file atomically and refuses to overwrite a competing owner.
      const temporary = `${this.endpointPath}.${token}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(endpoint), { flag: 'wx', mode: 0o600 })
        await link(temporary, this.endpointPath)
      } finally { await unlink(temporary).catch(() => undefined) }
      this.endpoint = endpoint
      this.diagnostics.log('info', 'bridge.listening', { host: endpoint.host, port: endpoint.port, protocolVersion: '1.0', projectionVersion: 2 })
      return endpoint
    } catch (error) {
      for (const socket of this.sockets) socket.destroy()
      await new Promise<void>(resolve => this.server!.close(() => resolve()))
      throw error
    }
  }

  close(): Promise<void> {
    this.closeTask ??= this.dispose()
    return this.closeTask
  }

  private async dispose(): Promise<void> {
    this.closed = true
    await this.startTask?.catch(() => undefined)
    for (const socket of this.sockets) socket.destroy()
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()))
    const endpoint = this.endpoint
    this.endpoint = undefined
    try {
      if (endpoint) {
        const current = await endpointAt(this.endpointPath)
        if (current?.token === endpoint.token && current.pid === endpoint.pid) await unlink(this.endpointPath)
      }
    } finally {
      const release = this.releaseLease
      this.releaseLease = undefined
      await release?.()
      this.diagnostics.log('info', 'bridge.stopped')
    }
  }

  private accept(socket: Socket, token: string): void {
    if (this.closed || this.sockets.size >= 16) { socket.destroy(); return }
    const connectionId = randomUUID()
    this.diagnostics.log('debug', 'bridge.connected', { connectionId })
    this.sockets.add(socket)
    socket.on('error', error => this.diagnostics.log('warn', 'bridge.socket_error', { connectionId }, error))
    const inFlight = new Map<string | number, AbortController>()
    const authTimer = setTimeout(() => socket.destroy(), 10_000)
    authTimer.unref()
    let router: RuntimeRouter | undefined
    let buffer: Buffer = Buffer.alloc(0)
    const send = (value: unknown) => {
      if (socket.destroyed) return
      const line = Buffer.from(`${JSON.stringify(value)}\n`)
      if (line.length > MAX_FRAME_BYTES) throw new BridgeError('FRAME_TOO_LARGE', 'The response exceeds the bridge frame limit.')
      if (socket.writableLength > 2 * MAX_FRAME_BYTES) { socket.destroy(); return }
      socket.write(line)
    }
    const fail = (id: unknown, error: unknown) => send({ jsonrpc: '2.0', id: id ?? null, error: publicError(error).toJSON() })

    const dispatch = async (line: Buffer) => {
      let id: string | number | undefined
      let method = 'invalid'
      const start = performance.now()
      try {
        let raw: unknown
        try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) }
        catch { throw new BridgeError('PARSE_ERROR', 'Invalid JSON frame.') }
        const request = record(raw)
        if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
          (request.params !== undefined && (request.params === null || Array.isArray(request.params) || typeof request.params !== 'object'))) {
          throw new BridgeError('INVALID_REQUEST', 'Expected a JSON-RPC request object.')
        }
        const params = record(request.params)
        method = /^[a-zA-Z$/][a-zA-Z0-9.$/_]{0,79}$/.test(request.method) ? request.method : 'invalid'
        if (request.method === '$/cancelRequest' && request.id === undefined && router) {
          const target = params.id
          if (typeof target === 'string' || typeof target === 'number') inFlight.get(target)?.abort()
          return
        }
        if (typeof request.id !== 'string' && !(typeof request.id === 'number' && Number.isSafeInteger(request.id))) {
          throw new BridgeError('INVALID_REQUEST', 'A request id is required.')
        }
        id = request.id as string | number
        if (inFlight.has(id) || inFlight.size >= 16) throw new BridgeError('INVALID_REQUEST', 'Too many requests or a duplicate request id.')
        if (!router) {
          const supplied = typeof params.authToken === 'string' ? Buffer.from(params.authToken) : Buffer.alloc(0)
          const expected = Buffer.from(token)
          if (request.method !== 'initialize' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
            throw new BridgeError('NOT_INITIALIZED', 'An authenticated initialization is required.')
          }
          if (typeof params.protocolVersion !== 'string' || !/^1\.\d+$/.test(params.protocolVersion) || params.runtime !== 'dsh') {
            throw new BridgeError('PROTOCOL_VERSION_MISMATCH', 'The bridge requires DSH protocol 1.x.')
          }
          const namespace = params.sessionNamespace ?? params.connectorId
          if (typeof namespace !== 'string' || !namespace || namespace.length > 512) throw new BridgeError('INVALID_PARAMS', 'A runtime namespace is required.')
          router = new RuntimeRouter(this.reader, namespace,
            batch => send({ jsonrpc: '2.0', method: 'runtime.sync.batch', params: batch }),
            (error, streamId) => {
              this.diagnostics.log('error', 'bridge.sync_failed', { connectionId }, error)
              const failure = publicError(error).toJSON()
              send({ jsonrpc: '2.0', method: 'runtime.error', params: {
                ...failure, data: { ...failure.data, scope: 'sync', streamId },
              } })
            })
          clearTimeout(authTimer)
          this.diagnostics.log('info', 'bridge.initialized', { connectionId, syncMode: this.reader.native ? 'events' : 'polling' })
          send({ jsonrpc: '2.0', id, result: {
            identity: { runtime: 'dsh', runtimeVersion: '0.1.2-rc.1', bridgeVersion: '0.1.0-dev.0', protocolVersion: '1.0', displayName: 'DeepSeek Harness' },
            storage: { mode: 'dsh-native', sameSessionWriterLimit: 1, crossProcessWriterExclusion: false },
            features: { attachments: Boolean(this.reader.native?.ctx.get('sessionController') && this.reader.native.ctx.get('attachments')),
              sessionDiscovery: true, timelineSuffixRead: false, approval: false, userQuestions: this.reader.native?.questions.available ?? false,
              readOnly: !this.reader.native?.ctx.get('sessionController'), snapshotPagination: true, syncMode: this.reader.native ? 'events' : 'polling', projectionVersion: 2 },
          } })
          return
        }
        const abort = new AbortController()
        inFlight.set(id, abort)
        let cancel: () => void = () => undefined
        const cancelled = new Promise<never>((_resolve, reject) => {
          cancel = () => reject(abort.signal.reason)
          abort.signal.addEventListener('abort', cancel, { once: true })
        })
        const timeout = setTimeout(() => abort.abort(), this.requestTimeoutMs)
        timeout.unref()
        try {
          // Release the request slot even when a native read ignores cancellation.
          // Its late result is observed but cannot send a second RPC response.
          const result = await Promise.race([router.request(request.method, params, abort.signal), cancelled])
          abort.signal.throwIfAborted()
          send({ jsonrpc: '2.0', id, result })
          if (method !== 'runtime.sync.ack') {
            const rejected = record(result).ok === false
            this.diagnostics.log(rejected ? 'warn' : 'debug', rejected ? 'rpc.rejected' : 'rpc.completed',
              { connectionId, method, elapsedMs: Math.round(performance.now() - start) })
          }
        } finally {
          clearTimeout(timeout)
          abort.signal.removeEventListener('abort', cancel)
          inFlight.delete(id)
        }
      } catch (error) {
        this.diagnostics.log('error', 'rpc.failed', { connectionId, method, elapsedMs: Math.round(performance.now() - start) }, error)
        fail(id, error)
        if (!router) socket.end()
      }
    }

    let discardingFrame = false
    socket.on('data', (data: Buffer) => {
      if (discardingFrame) {
        const end = data.indexOf(10)
        if (end < 0) return
        data = data.subarray(end + 1)
        discardingFrame = false
      }
      buffer = Buffer.concat([buffer, data])
      let newline: number
      while ((newline = buffer.indexOf(10)) >= 0) {
        const frame = buffer.subarray(0, newline)
        buffer = buffer.subarray(newline + 1)
        if (frame.length + 1 > MAX_FRAME_BYTES) {
          fail(null, new BridgeError('FRAME_TOO_LARGE', 'The request exceeds the bridge frame limit.'))
          continue
        }
        void dispatch(frame)
      }
      if (buffer.length >= MAX_FRAME_BYTES) {
        buffer = Buffer.alloc(0)
        discardingFrame = true
        fail(null, new BridgeError('FRAME_TOO_LARGE', 'The request exceeds the bridge frame limit.'))
      }
    })
    socket.on('close', () => {
      this.diagnostics.log('info', 'bridge.disconnected', { connectionId, initialized: Boolean(router), pendingRequests: inFlight.size })
      router?.close()
      clearTimeout(authTimer)
      for (const abort of inFlight.values()) abort.abort()
      this.sockets.delete(socket)
    })
  }
}
