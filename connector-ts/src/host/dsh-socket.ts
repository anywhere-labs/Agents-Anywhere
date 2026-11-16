// The local socket DSH Bridge 3.0 plugins dial (contracts/dsh-bridge/3.0 §1): a Unix socket (macOS, Linux) or a
// named pipe (Windows), the rendezvous file `~/.agents-anywhere/dsh-bridge/connector-acp.json`, and the one-line
// hello/welcome handshake. After the handshake the connection is a plain byte stream that carries ACP ndjson; the
// DSH plugin route (E, `runtime/profiles/dsh/plugin-route/`) takes it from here.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'

export const BRIDGE_PROTOCOL = '3.0'
const HELLO_MAX_BYTES = 64 * 1024
const HELLO_TIMEOUT_MS = 10_000

export interface DshHello {
  readonly t: 'hello'
  readonly bridgeProtocol: string
  readonly key: string
  readonly hostInstance: string
  readonly hostKind: 'desktop' | 'web' | 'headless' | 'unknown'
  readonly dshVersion: string
  readonly pluginVersion: string
  readonly dshHome?: string
}

export type RejectCode = 'bad_key' | 'unsupported_protocol' | 'duplicate_host' | 'busy'

export interface Rendezvous {
  readonly version: 3
  readonly protocol: 'acp'
  readonly instanceId: string
  readonly pid: number
  readonly endpoint: { readonly unixPath: string } | { readonly pipe: string }
  readonly key: string
}

/** A host's verified connection: the hello it sent and the stream ACP runs on. */
export interface DshHostConnection {
  readonly hello: DshHello
  readonly socket: Socket
}

export interface DshBridgeListenerOptions {
  /** `~/.agents-anywhere/dsh-bridge` */
  readonly dir: string
  readonly instanceId: string
  readonly connectorVersion: string
  /** Called once per verified connection; a newer connection of the same host replaces (closes) the old one. */
  readonly onConnection: (connection: DshHostConnection) => void
  readonly platform?: NodeJS.Platform
  readonly pid?: number
  readonly helloTimeoutMs?: number
  /** False while the Connector cannot serve yet (no lease, no store): hosts get `busy` and retry with backoff. */
  readonly accepting?: () => boolean
}

const HOST_INSTANCE = /^[A-Za-z0-9_-]{8,128}$/u

/** Checks a hello line; returns the reject code or the parsed hello. */
export function checkHello(line: string, keyDigest: Buffer): DshHello | { reject: RejectCode; message: string } {
  let value: Partial<DshHello>
  try {
    value = JSON.parse(line) as Partial<DshHello>
  } catch {
    return { reject: 'unsupported_protocol', message: 'The first line must be a JSON hello.' }
  }
  if (value === null || typeof value !== 'object' || value.t !== 'hello') return { reject: 'unsupported_protocol', message: 'The first line must be a hello.' }
  if (typeof value.bridgeProtocol !== 'string' || !/^3\.[0-9]+$/u.test(value.bridgeProtocol)) {
    return { reject: 'unsupported_protocol', message: `Bridge protocol ${String(value.bridgeProtocol)} is not supported; this Connector speaks ${BRIDGE_PROTOCOL}.` }
  }
  const given = createHash('sha256').update(typeof value.key === 'string' ? value.key : '').digest()
  if (!timingSafeEqual(given, keyDigest)) return { reject: 'bad_key', message: 'The key does not match the current rendezvous file.' }
  if (typeof value.hostInstance !== 'string' || !HOST_INSTANCE.test(value.hostInstance)
    || !['desktop', 'web', 'headless', 'unknown'].includes(value.hostKind as string)
    || typeof value.dshVersion !== 'string' || value.dshVersion === '' || typeof value.pluginVersion !== 'string' || value.pluginVersion === '') {
    return { reject: 'unsupported_protocol', message: 'The hello is missing required fields.' }
  }
  return value as DshHello
}

export class DshBridgeListener {
  private server: Server | undefined
  private key = ''
  private keyDigest = Buffer.alloc(32)
  private readonly hosts = new Map<string, Socket>()
  private readonly pending = new Set<Socket>()
  private readonly platform: NodeJS.Platform

  public constructor(private readonly options: DshBridgeListenerOptions) {
    this.platform = options.platform ?? process.platform
  }

  public get rendezvousPath(): string {
    return join(this.options.dir, 'connector-acp.json')
  }

  public get endpoint(): Rendezvous['endpoint'] {
    return this.platform === 'win32'
      ? { pipe: `\\\\.\\pipe\\agents-anywhere-acp-${this.options.instanceId}` }
      : { unixPath: join(this.options.dir, `acp-${this.options.instanceId}.sock`) }
  }

  /** Listens and publishes the rendezvous file (0600, atomic); a new key every start. */
  public async start(): Promise<Rendezvous> {
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 })
    this.key = `ak_${randomBytes(32).toString('hex')}`
    this.keyDigest = createHash('sha256').update(this.key).digest()
    const endpoint = this.endpoint
    const address = 'unixPath' in endpoint ? endpoint.unixPath : endpoint.pipe
    if ('unixPath' in endpoint) await rm(endpoint.unixPath, { force: true })
    const server = createServer(socket => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, () => {
        server.off('error', reject)
        resolve()
      })
    })
    // Only this user may connect (the directory is 0700 as well); the key check comes on top.
    if ('unixPath' in endpoint) await chmod(endpoint.unixPath, 0o600)
    this.server = server
    const rendezvous: Rendezvous = { version: 3, protocol: 'acp', instanceId: this.options.instanceId, pid: this.options.pid ?? process.pid, endpoint, key: this.key }
    const temporary = `${this.rendezvousPath}.${randomBytes(4).toString('hex')}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(rendezvous, null, 2)}\n`)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, this.rendezvousPath)
    } finally {
      await rm(temporary, { force: true })
    }
    return rendezvous
  }

  private reply(socket: Socket, frame: Record<string, unknown>): void {
    socket.write(`${JSON.stringify(frame)}\n`)
  }

  private accept(socket: Socket): void {
    this.pending.add(socket)
    let buffered = Buffer.alloc(0)
    let done = false
    const timer = setTimeout(() => finish(() => socket.destroy()), this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
    const finish = (then: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.off('data', onData)
      this.pending.delete(socket)
      then()
    }
    const reject = (code: RejectCode, message: string): void => finish(() => {
      this.reply(socket, { t: 'reject', code, message })
      socket.end()
    })
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf(0x0a)
      if (newline < 0) {
        if (buffered.length > HELLO_MAX_BYTES) reject('unsupported_protocol', 'The hello line is too long.')
        return
      }
      if (newline > HELLO_MAX_BYTES) {
        reject('unsupported_protocol', 'The hello line is too long.')
        return
      }
      const line = buffered.subarray(0, newline).toString('utf8')
      const rest = buffered.subarray(newline + 1)
      if (this.options.accepting?.() === false) {
        reject('busy', 'The Connector is starting; retry shortly.')
        return
      }
      const hello = checkHello(line, this.keyDigest)
      if ('reject' in hello) {
        reject(hello.reject, hello.message)
        return
      }
      finish(() => {
        socket.pause()
        // Anything after the hello line is already ACP: give it back to the stream.
        if (rest.length > 0) socket.unshift(rest)
        const previous = this.hosts.get(hello.hostInstance)
        this.hosts.set(hello.hostInstance, socket)
        previous?.destroy()
        socket.once('close', () => {
          if (this.hosts.get(hello.hostInstance) === socket) this.hosts.delete(hello.hostInstance)
        })
        this.reply(socket, { t: 'welcome', bridgeProtocol: BRIDGE_PROTOCOL, connectorInstance: this.options.instanceId, connectorVersion: this.options.connectorVersion })
        this.options.onConnection({ hello, socket })
      })
    }
    socket.on('data', onData)
    socket.on('error', () => finish(() => socket.destroy()))
  }

  /** Host instances with a live connection. */
  public connectedHosts(): string[] {
    return [...this.hosts.keys()]
  }

  /** Closes every connection, stops listening and removes the rendezvous file if it is still ours. */
  public async stop(): Promise<void> {
    for (const socket of [...this.pending, ...this.hosts.values()]) socket.destroy()
    this.pending.clear()
    this.hosts.clear()
    const server = this.server
    this.server = undefined
    if (server !== undefined) await new Promise<void>(resolve => server.close(() => resolve()))
    const current = await readFile(this.rendezvousPath, 'utf8').then(text => JSON.parse(text) as Partial<Rendezvous>, () => null)
    if (current?.instanceId === this.options.instanceId) await rm(this.rendezvousPath, { force: true })
    const endpoint = this.endpoint
    if ('unixPath' in endpoint) await rm(endpoint.unixPath, { force: true })
  }
}
