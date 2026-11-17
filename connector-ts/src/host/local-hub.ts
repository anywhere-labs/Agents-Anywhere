// ported from the v2 Connector's connector/mesh/hub.py (Agents Anywhere 2.x), in TypeScript on meshcall 9334405.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, renameSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LocalRouter, Mesh, type RunningServer } from 'meshcall'

import { rpcLogger } from '../mesh/index.js'
import { agentsAnywhereHome } from './paths.js'

/**
 * The Router a packaged build ships next to its bundle (`<bundle>/router/meshcall-router`, see
 * scripts/fetch-router.mjs). Running from source there is none, and meshcall's own lookup applies.
 */
export function shippedRouterBinary(base: string | URL = import.meta.url): string | undefined {
  const path = fileURLToPath(new URL(`./router/${process.platform === 'win32' ? 'meshcall-router.exe' : 'meshcall-router'}`, base))
  return existsSync(path) ? path : undefined
}

export const CONTROL_SERVICE = 'aa.local.v2.Control'
export const LOGS_SERVICE = 'aa.local.v2.Logs'
export const DSH_SYNC_SERVICE = 'aa.dsh.v2.Sync'
export const DSH_BRIDGE_SERVICE = 'aa.dsh.v2.Bridge'
export const REGISTRY_SERVICE = 'meshcall.router.v1.Registry'

export type LocalRole = 'connector' | 'host' | 'dsh-bridge' | 'handover' | 'client-pairing'

/** register: services the role may serve; call: service/method rules (local-machine 2.0 + `handover`). */
export const ROLE_PERMISSIONS: Readonly<Record<LocalRole, { register: readonly string[]; call: readonly string[] }>> = {
  connector: { register: [CONTROL_SERVICE, LOGS_SERVICE, DSH_SYNC_SERVICE], call: [`${DSH_BRIDGE_SERVICE}/*`, `${REGISTRY_SERVICE}/*`] },
  // The Registry lets `meshcall router inspect` / `call` describe the services.
  host: { register: [], call: [`${CONTROL_SERVICE}/*`, `${LOGS_SERVICE}/*`, `${REGISTRY_SERVICE}/*`] },
  'dsh-bridge': { register: [DSH_BRIDGE_SERVICE], call: [`${DSH_SYNC_SERVICE}/*`, ...['write', 'read', 'tail'].map(method => `${LOGS_SERVICE}/${method}`)] },
  // A newer Connector on this machine asking this one to hand over (04-connector.md §9.1): that method only.
  handover: { register: [], call: [`${CONTROL_SERVICE}/requestHandover`] },
  // `anywhere-cli pair-client` while another host owns the machine: a pairing invitation and nothing else (no
  // confirmations, no direct grants, no lifecycle).
  'client-pairing': { register: [], call: [`${CONTROL_SERVICE}/startClientPairing`] },
}

const UNIX_PATH_LIMIT = 103
const WATCH_MS = 1000
const RESTART_DELAY_MS = 1000

export type LocalEndpoint = { readonly unixPath: string } | { readonly pipe: string }

export interface LocalDescriptor {
  readonly instanceId: string
  readonly pid: number
  readonly endpoint: LocalEndpoint
  readonly key: string
}

export function routerDirectory(home?: string): string {
  return join(agentsAnywhereHome(home), 'router')
}

/** A MeshCall API key (`mk_<id>_<secret>`) and the digest the Router stores. */
export function apiKey(role: LocalRole): { key: string; digest: string } {
  const key = `mk_${role}_${randomBytes(32).toString('hex')}`
  return { key, digest: createHash('sha256').update(key).digest('hex') }
}

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true })
  if (process.platform !== 'win32') chmodSync(path, 0o700)
  return path
}

/** Atomically replaces `path` with `payload`, readable by this user only. */
export function writePrivateJson(path: string, payload: unknown): void {
  privateDirectory(resolve(path, '..'))
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600, flag: 'wx' })
  try {
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function socketLive(path: string): Promise<boolean> {
  return new Promise(resolvePromise => {
    const probe = connect(path)
    const timer = setTimeout(() => done(false), 200)
    function done(live: boolean): void {
      clearTimeout(timer)
      probe.destroy()
      resolvePromise(live)
    }
    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
  })
}

/** Removes sockets left by Routers that died without unlinking them. */
export async function sweepStaleSockets(directory: string): Promise<void> {
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.sock')) continue
    const path = join(directory, name)
    try {
      if (statSync(path).isSocket() && !(await socketLive(path))) rmSync(path, { force: true })
    } catch {
      // gone already
    }
  }
}

export interface LocalHubOptions {
  readonly directory?: string
  /** The Router binary; default `MESHCALL_ROUTER_BINARY` or meshcall's own lookup. */
  readonly binaryPath?: string
  readonly maxFrameSize?: number
  readonly onLog?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
}

/**
 * One local MeshCall Router and one Mesh per Connector process, with one random API key per role
 * (`ROLE_PERMISSIONS`), regenerated per process. The Router listens on a Unix socket under
 * `~/.agents-anywhere/router` (a named pipe on Windows), exits with this process, and a Router that dies on its
 * own is restarted on the same endpoint with the same keys so every peer's reconnect brings it back.
 */
export class LocalHub {
  public readonly instanceId = randomBytes(8).toString('hex')
  public readonly directory: string
  public readonly endpoint: LocalEndpoint
  private readonly keys: Record<LocalRole, { key: string; digest: string }>
  private router: LocalRouter | null = null
  private meshValue: Mesh | null = null
  private server: RunningServer | null = null
  private readonly services: object[] = []
  private supervisor: ReturnType<typeof setInterval> | null = null
  private stopping = false
  private busy: Promise<void> = Promise.resolve()
  private readonly cleanups: (() => Promise<void> | void)[] = []
  private readonly rpcLog = rpcLogger((level, message) => this.log(level, message))

  public constructor(private readonly options: LocalHubOptions = {}) {
    let directory = options.directory ?? routerDirectory()
    this.keys = { connector: apiKey('connector'), host: apiKey('host'), 'dsh-bridge': apiKey('dsh-bridge'), handover: apiKey('handover'), 'client-pairing': apiKey('client-pairing') }
    if (process.platform === 'win32') {
      this.endpoint = { pipe: `agents-anywhere-${this.instanceId}` }
    } else {
      let path = join(directory, `${this.instanceId}.sock`)
      if (Buffer.byteLength(resolve(path)) > UNIX_PATH_LIMIT) {
        directory = join(tmpdir(), `agents-anywhere-${process.getuid?.() ?? 'user'}`)
        path = join(directory, `${this.instanceId}.sock`)
      }
      this.endpoint = { unixPath: path }
    }
    this.directory = directory
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.options.onLog?.(level, message)
  }

  public get running(): boolean {
    return this.router?.isRunning === true
  }

  public get serving(): boolean {
    return this.server !== null
  }

  public get mesh(): Mesh {
    if (this.meshValue === null) throw new Error('The local router is not started')
    return this.meshValue
  }

  public key(role: LocalRole): string {
    return this.keys[role].key
  }

  /** What a peer needs to reach this Router as `role`. */
  public descriptor(role: LocalRole): LocalDescriptor {
    return { instanceId: this.instanceId, pid: process.pid, endpoint: this.endpoint, key: this.key(role) }
  }

  public authDocument(): Record<string, unknown> {
    return {
      api_keys: (Object.keys(ROLE_PERMISSIONS) as LocalRole[]).map(role => ({
        id: role,
        key_hash: this.keys[role].digest,
        roles: ROLE_PERMISSIONS[role].register.length > 0 ? ['client', 'server'] : ['client'],
        ...(ROLE_PERMISSIONS[role].register.length > 0 ? { register: ROLE_PERMISSIONS[role].register } : {}),
        call: ROLE_PERMISSIONS[role].call,
      })),
    }
  }

  /** Runs `cleanup` before the Router stops (published files). */
  public onStop(cleanup: () => Promise<void> | void): void {
    this.cleanups.push(cleanup)
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.busy.then(work)
    this.busy = run.then(() => undefined, () => undefined)
    return run
  }

  public start(): Promise<void> {
    return this.serial(async () => {
      if (this.running && this.meshValue !== null) return
      this.stopping = false
      await this.launch()
      if (this.supervisor === null) {
        this.supervisor = setInterval(() => void this.supervise(), WATCH_MS)
        this.supervisor.unref()
      }
    })
  }

  /** Serves `services` too. MeshCall freezes the service list while serving, so serving restarts. */
  public mount(...services: object[]): Promise<void> {
    return this.serial(async () => {
      if (this.stopping) throw new Error('The local router is stopping')
      if (!this.running || this.meshValue === null) await this.launch()
      await this.stopServing()
      this.services.push(...services)
      await this.startServing()
    })
  }

  public stop(): Promise<void> {
    this.stopping = true
    return this.serial(async () => {
      if (this.supervisor !== null) clearInterval(this.supervisor)
      this.supervisor = null
      await this.stopServing()
      for (const cleanup of this.cleanups.splice(0).reverse()) {
        try {
          await cleanup()
        } catch (error) {
          this.log('error', `local router cleanup failed: ${(error as Error).message}`)
        }
      }
      const mesh = this.meshValue
      this.meshValue = null
      await mesh?.close().catch(() => undefined)
      const router = this.router
      this.router = null
      await router?.stop().catch(() => undefined)
    })
  }

  private async launch(): Promise<void> {
    privateDirectory(this.directory)
    if ('unixPath' in this.endpoint) await sweepStaleSockets(this.directory)
    const authFile = join(this.directory, `${this.instanceId}.auth.json`)
    writePrivateJson(authFile, this.authDocument())
    // Restart the same instance: the endpoint and keys stay, so peers reconnect by themselves.
    const router = this.router ?? new LocalRouter({
      ...this.endpoint,
      authFile,
      maxFrameSize: this.options.maxFrameSize ?? 4 * 1024 * 1024,
      ...routerBinaryOption(this.options.binaryPath),
    })
    try {
      await router.start()
    } finally {
      // The Router reads its accounts once, at startup.
      rmSync(authFile, { force: true })
    }
    this.router = router
    this.meshValue ??= new Mesh(router, { token: this.key('connector'), peerId: `connector-${this.instanceId}`, logger: this.rpcLog })
    this.log('info', `local router listening ${JSON.stringify(this.endpoint)}`)
  }

  private async startServing(): Promise<void> {
    if (this.services.length === 0) return
    const mesh = this.mesh
    mesh.mount(...this.services, { instanceId: `connector-${this.instanceId}`, accessLog: false, logger: this.rpcLog })
    this.server = await mesh.startServing()
  }

  private async stopServing(): Promise<void> {
    const server = this.server
    this.server = null
    // Control/Logs streams never finish: draining would stall for the whole drain timeout.
    if (server !== null) await server.close({ drain: false }).catch(() => undefined)
    // A new Mesh for the next mount: meshcall's mount list only grows.
    if (this.meshValue !== null && this.router !== null) {
      await this.meshValue.close().catch(() => undefined)
      this.meshValue = new Mesh(this.router, { token: this.key('connector'), peerId: `connector-${this.instanceId}`, logger: this.rpcLog })
    }
  }

  private async supervise(): Promise<void> {
    const router = this.router
    if (this.stopping || router === null) return
    if (router.isRunning) {
      if (this.services.length > 0 && this.server === null) await this.serial(() => this.startServing()).catch(error => this.log('error', `local serving restart failed: ${(error as Error).message}`))
      return
    }
    this.log('warn', 'local router exited; restarting')
    await new Promise(resolvePromise => setTimeout(resolvePromise, RESTART_DELAY_MS))
    await this.serial(async () => {
      if (this.stopping || this.router === null || this.router.isRunning) return
      await this.router.stop().catch(() => undefined)
      // The old server handle died with the Router.
      await this.stopServing()
      await this.launch()
      await this.startServing()
    }).catch(error => this.log('error', `local router restart failed: ${(error as Error).message}`))
  }
}

/** Explicit path, then `MESHCALL_ROUTER_BINARY`, then the shipped Router; none leaves meshcall to search. */
function routerBinaryOption(configured: string | undefined): { binaryPath?: string } {
  const binaryPath = configured ?? (process.env.MESHCALL_ROUTER_BINARY || undefined) ?? shippedRouterBinary()
  return binaryPath !== undefined ? { binaryPath } : {}
}
