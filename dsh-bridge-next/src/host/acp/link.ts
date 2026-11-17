/**
 * Dials the Connector published in connector-acp.json and serves the plugin's ACP
 * Agent on that connection (contracts/dsh-bridge/3.0 §1). One connection per host;
 * the link follows the rendezvous when the Connector is replaced and redials with
 * backoff after a disconnect. Losing the connection never touches host sessions.
 */
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { basename, dirname } from 'node:path'
import { Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { BRIDGE_PROTOCOL, type BridgeHandshakeReply, type BridgeHello, type BridgeRendezvousV3, type HostKind } from '../../contracts/bridge-v3.js'
import type { NativeRuntime } from '../dsh-runtime/native.js'
import { record } from '../dsh-runtime/types.js'
import { DshAcpAgent, type HostFacts } from './agent.js'

const MAX_HANDSHAKE_LINE = 64 * 1024

export function parseRendezvousV3(text: string): BridgeRendezvousV3 | undefined {
  let value: Record<string, unknown>
  try { value = record(JSON.parse(text)) } catch { return undefined }
  const endpoint = record(value.endpoint)
  const local = typeof endpoint.unixPath === 'string' && endpoint.unixPath ? { unixPath: endpoint.unixPath }
    : typeof endpoint.pipe === 'string' && endpoint.pipe ? { pipe: endpoint.pipe } : undefined
  if (value.version !== 3 || value.protocol !== 'acp' || !local || typeof value.instanceId !== 'string' || !value.instanceId
    || typeof value.key !== 'string' || !/^ak_[0-9a-f]{64,}$/.test(value.key) || typeof value.pid !== 'number') return undefined
  return { version: 3, protocol: 'acp', instanceId: value.instanceId, pid: value.pid, endpoint: local, key: value.key }
}

export class HandshakeError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** Send hello and read the single-line reply; returns the socket bytes that followed it. */
export async function handshake(socket: Socket, hello: BridgeHello, timeoutMs = 10_000): Promise<{ reply: Extract<BridgeHandshakeReply, { t: 'welcome' }>, rest: Buffer }> {
  socket.write(`${JSON.stringify(hello)}\n`)
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => finish(new HandshakeError('timeout', 'The Connector did not answer the handshake.')), timeoutMs)
    const finish = (error?: Error, value?: { reply: Extract<BridgeHandshakeReply, { t: 'welcome' }>, rest: Buffer }) => {
      clearTimeout(timer)
      socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose)
      if (error) reject(error)
      else resolve(value!)
    }
    const onError = (error: Error) => finish(error)
    const onClose = () => finish(new HandshakeError('closed', 'The Connector closed the connection during the handshake.'))
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf(0x0a)
      if (newline < 0) {
        if (buffered.length > MAX_HANDSHAKE_LINE) finish(new HandshakeError('protocol', 'Handshake reply is too long.'))
        return
      }
      socket.pause()
      let reply: BridgeHandshakeReply
      try { reply = JSON.parse(buffered.subarray(0, newline).toString('utf8')) as BridgeHandshakeReply }
      catch { finish(new HandshakeError('protocol', 'Handshake reply is not JSON.')); return }
      if (reply.t === 'reject') finish(new HandshakeError(reply.code, reply.message))
      else if (reply.t !== 'welcome' || !/^3\./.test(reply.bridgeProtocol)) finish(new HandshakeError('protocol', 'Unexpected handshake reply.'))
      else finish(undefined, { reply, rest: buffered.subarray(newline + 1) })
    }
    socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose)
  })
}

/** Web streams over a socket whose first bytes were already read during the handshake. */
export function acpStream(socket: Socket, rest: Buffer): acp.Stream {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      if (rest.length) controller.enqueue(new Uint8Array(rest))
      socket.on('data', chunk => controller.enqueue(new Uint8Array(chunk)))
      socket.on('end', () => { try { controller.close() } catch { /* already closed */ } })
      socket.on('error', error => { try { controller.error(error) } catch { /* already closed */ } })
      socket.on('close', () => { try { controller.close() } catch { /* already closed */ } })
      socket.resume()
    },
  })
  return acp.ndJsonStream(Writable.toWeb(socket) as WritableStream<Uint8Array>, input)
}

export interface LinkStatus { state: 'waiting' | 'connecting' | 'connected' | 'retrying' | 'closed', connectorInstance?: string, lastError?: string }

export class AcpBridgeLink {
  private watcher: FSWatcher | undefined
  private timer: NodeJS.Timeout | undefined
  private retry: NodeJS.Timeout | undefined
  private socket: Socket | undefined
  private agent: DshAcpAgent | undefined
  private current: BridgeRendezvousV3 | undefined
  private attempt = 0
  private checking: Promise<void> | undefined
  private closed = false
  status: LinkStatus = { state: 'waiting' }

  constructor(readonly rendezvousPath: string, private readonly native: NativeRuntime,
    private readonly facts: HostFacts & { hostKind: HostKind, dshHome?: string },
    private readonly pollMs = 1000, private readonly onStatus?: (status: LinkStatus) => void) {}

  get connectedAgent(): DshAcpAgent | undefined { return this.agent }
  get hostInstance(): string { return this.facts.hostInstance }

  private started = false

  start(): void {
    if (this.started || this.closed) return
    this.started = true
    try {
      this.watcher = watch(dirname(this.rendezvousPath), (_event, name) => {
        if (!name || name.toString() === basename(this.rendezvousPath)) this.check()
      })
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined })
    } catch { /* The directory may not exist yet; polling covers it. */ }
    this.timer = setInterval(() => this.check(), this.pollMs)
    this.timer.unref?.()
    this.check()
  }

  private setStatus(status: LinkStatus): void {
    this.status = status
    this.onStatus?.(status)
  }

  private check(): void {
    if (this.closed || this.checking) return
    this.checking = this.refresh().catch(() => undefined).finally(() => { this.checking = undefined })
  }

  private async refresh(): Promise<void> {
    let next: BridgeRendezvousV3 | undefined
    try { next = parseRendezvousV3(await readFile(this.rendezvousPath, 'utf8')) } catch { next = undefined }
    const same = next && this.current && next.instanceId === this.current.instanceId && next.key === this.current.key
    if (same && (this.socket || this.retry)) return
    if (!same) {
      this.disconnect()
      this.attempt = 0
      if (this.retry) { clearTimeout(this.retry); this.retry = undefined }
    }
    this.current = next
    if (!next) { this.setStatus({ state: 'waiting' }); return }
    await this.dial(next)
  }

  private async dial(target: BridgeRendezvousV3): Promise<void> {
    this.setStatus({ state: 'connecting', connectorInstance: target.instanceId })
    const socket = connect('unixPath' in target.endpoint ? target.endpoint.unixPath : target.endpoint.pipe)
    this.socket = socket
    try {
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
      const { rest } = await handshake(socket, { t: 'hello', bridgeProtocol: BRIDGE_PROTOCOL, key: target.key,
        hostInstance: this.facts.hostInstance, hostKind: this.facts.hostKind, dshVersion: this.facts.dshVersion,
        pluginVersion: this.facts.pluginVersion, ...(this.facts.dshHome ? { dshHome: this.facts.dshHome } : {}) })
      if (this.socket !== socket || this.closed) { socket.destroy(); return }
      const connection = new acp.AgentSideConnection(conn => {
        this.agent = new DshAcpAgent(conn, this.native, this.facts)
        return this.agent
      }, acpStream(socket, rest))
      this.attempt = 0
      this.setStatus({ state: 'connected', connectorInstance: target.instanceId })
      // The SDK builds the Agent before its connection exists; watch the signal from here.
      connection.signal.addEventListener('abort', () => this.lost(socket), { once: true })
      socket.once('close', () => this.lost(socket))
    } catch (error) {
      socket.destroy()
      if (this.socket === socket) this.socket = undefined
      this.scheduleRetry(error)
    }
  }

  private lost(socket: Socket): void {
    if (this.socket !== socket) return
    this.socket = undefined
    this.agent?.close()
    this.agent = undefined
    this.scheduleRetry(new Error('Connector connection closed'))
  }

  private scheduleRetry(error: unknown): void {
    if (this.closed || this.retry) return
    // bad_key: wait for the rendezvous to change; it means we read a stale file.
    const delay = error instanceof HandshakeError && error.code === 'unsupported_protocol' ? 60_000
      : Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5))
    this.setStatus({ state: 'retrying', ...(this.current ? { connectorInstance: this.current.instanceId } : {}),
      lastError: error instanceof Error ? error.message : String(error) })
    this.retry = setTimeout(() => {
      this.retry = undefined
      if (this.current && !this.socket && !this.closed) void this.dial(this.current)
    }, delay)
    this.retry.unref?.()
  }

  private disconnect(): void {
    const socket = this.socket
    this.socket = undefined
    this.agent?.close()
    this.agent = undefined
    socket?.destroy()
  }

  async close(): Promise<void> {
    this.closed = true
    this.watcher?.close()
    if (this.timer) clearInterval(this.timer)
    if (this.retry) clearTimeout(this.retry)
    this.disconnect()
    await this.checking
    this.setStatus({ state: 'closed' })
  }
}

