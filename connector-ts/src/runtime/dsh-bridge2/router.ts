/**
 * The local MeshCall Router a 2.0 plugin connects to, and the `connector.json`
 * rendezvous that tells it where (contracts/dsh-bridge/2.0 "拓扑与发现", "鉴权").
 *
 * v3 keeps this only for already-installed 2.0 plugins (04-connector.md §5.6, 08 §3.0.0).
 * The Router may be shared with the Desktop control channel (`aa.local.v2.Control/Logs`,
 * owned by `host/`): MeshCall freezes the service list once serving starts, so whoever
 * owns the Router mounts `SyncService` before `startServing()`. `Bridge2Router.start()`
 * is the self-contained form for a Connector without that channel, and for tests.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { LocalRouter, Mesh, Router, type RunningServer } from 'meshcall'
import { BRIDGE_SERVICE } from './client.js'
import { SYNC_SERVICE, SyncService, type RelaySlot } from './service.js'

export const CONTROL_SERVICE = 'aa.local.v2.Control'
export const LOGS_SERVICE = 'aa.local.v2.Logs'
export const REGISTRY_SERVICE = 'meshcall.router.v1.Registry'
export const RENDEZVOUS_VERSION = 2

export type LocalEndpoint = { unixPath: string } | { pipe: string }

export interface Bridge2Rendezvous {
  version: 2
  protocol: 'meshcall'
  instanceId: string
  pid: number
  endpoint: LocalEndpoint
  key: string
}

/** hub.py `ROLE_PERMISSIONS`, limited to the two roles the DSH bridge needs. */
export const ROLE_PERMISSIONS = {
  connector: { register: [CONTROL_SERVICE, LOGS_SERVICE, SYNC_SERVICE], call: [`${BRIDGE_SERVICE}/*`, `${REGISTRY_SERVICE}/*`] },
  'dsh-bridge': { register: [BRIDGE_SERVICE], call: [`${SYNC_SERVICE}/*`, ...['write', 'read', 'tail'].map(method => `${LOGS_SERVICE}/${method}`)] },
} as const
export type Bridge2Role = keyof typeof ROLE_PERMISSIONS

/** A MeshCall API key `mk_<id>_<secret>` and the digest the Router stores. */
export function apiKey(role: string): { key: string, digest: string } {
  const key = `mk_${role.replaceAll('_', '-')}_${randomBytes(32).toString('hex')}`
  return { key, digest: createHash('sha256').update(key).digest('hex') }
}

export function routerAuthDocument(keys: Record<Bridge2Role, { digest: string }>) {
  return {
    api_keys: (Object.keys(ROLE_PERMISSIONS) as Bridge2Role[]).map(role => ({
      id: role.replaceAll('_', '-'), key_hash: keys[role].digest,
      roles: ROLE_PERMISSIONS[role].register.length ? ['client', 'server'] : ['client'],
      register: [...ROLE_PERMISSIONS[role].register], call: [...ROLE_PERMISSIONS[role].call],
    })),
  }
}

/** provider_config.py `endpoint_path`: `<user home>/.agents-anywhere/dsh-bridge/connector.json`. */
export function rendezvousPath(home: string = userInfo().homedir || homedir()): string {
  return join(home, '.agents-anywhere', 'dsh-bridge', 'connector.json')
}

/** hub.py `write_private_json`: atomic replace, readable by this user only. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.${path.split(/[\\/]/).pop()}.${randomBytes(4).toString('hex')}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.close()
    await rename(temporary, path)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function publishRendezvous(path: string, rendezvous: Bridge2Rendezvous): Promise<void> {
  await writePrivateJson(path, rendezvous)
}

/** Remove the rendezvous only if it is still ours: a replacement Connector may own it now. */
export async function unpublishRendezvous(path: string, instanceId: string): Promise<void> {
  try {
    const current = JSON.parse(await readFile(path, 'utf8')) as { instanceId?: unknown }
    if (current.instanceId === instanceId) await unlink(path)
  } catch { /* already gone or unreadable: nothing of ours to remove */ }
}

const UNIX_PATH_LIMIT = 103

/** hub.py: `~/.agents-anywhere/router/<instanceId>.sock`, or the temp directory when that path is too long. */
export function routerEndpoint(instanceId: string, home: string = userInfo().homedir || homedir()): LocalEndpoint {
  if (process.platform === 'win32') return { pipe: `agents-anywhere-${instanceId}` }
  const preferred = join(home, '.agents-anywhere', 'router', `${instanceId}.sock`)
  if (Buffer.byteLength(preferred) <= UNIX_PATH_LIMIT) return { unixPath: preferred }
  return { unixPath: join(tmpdir(), `agents-anywhere-${process.getuid?.() ?? 'user'}`, `${instanceId.slice(0, 16)}.sock`) }
}

export interface Bridge2RouterOptions {
  home?: string
  slot: RelaySlot
  /** Extra services the Connector serves on the same Router (mounted before serving). */
  services?: object[]
}

/** A Router of its own, the Connector's Mesh on it with `SyncService` mounted, and the published rendezvous. */
export class Bridge2Router {
  private constructor(readonly instanceId: string, readonly endpoint: LocalEndpoint, readonly rendezvousPath: string,
    readonly mesh: Mesh, private readonly router: LocalRouter, private readonly server: RunningServer,
    private readonly bridgeKey: string, private readonly authFile: string) {}

  static async start(options: Bridge2RouterOptions): Promise<Bridge2Router> {
    const home = options.home ?? (userInfo().homedir || homedir())
    const instanceId = randomUUID().replaceAll('-', '')
    const endpoint = routerEndpoint(instanceId, home)
    if ('unixPath' in endpoint) await mkdir(dirname(endpoint.unixPath), { recursive: true, mode: 0o700 })
    const keys = { connector: apiKey('connector'), 'dsh-bridge': apiKey('dsh-bridge') }
    const authFile = join(home, '.agents-anywhere', 'router', `${instanceId}.auth.json`)
    await writePrivateJson(authFile, routerAuthDocument(keys))
    const router = await LocalRouter.start({ ...endpoint, authFile })
    let mesh: Mesh | undefined
    try {
      mesh = new Mesh(new Router(endpoint), { token: keys.connector.key, peerId: `connector-${instanceId}` })
      mesh.mount(new SyncService(options.slot), ...(options.services ?? []), { instanceId: `connector-${instanceId}` })
      const server = await mesh.startServing()
      const path = rendezvousPath(home)
      const host = new Bridge2Router(instanceId, endpoint, path, mesh, router, server, keys['dsh-bridge'].key, authFile)
      await host.publish()
      return host
    } catch (error) {
      await mesh?.close().catch(() => undefined)
      await router.stop().catch(() => undefined)
      await rm(authFile, { force: true })
      throw error
    }
  }

  get rendezvous(): Bridge2Rendezvous {
    return { version: RENDEZVOUS_VERSION, protocol: 'meshcall', instanceId: this.instanceId, pid: process.pid, endpoint: this.endpoint, key: this.bridgeKey }
  }

  publish(): Promise<void> { return publishRendezvous(this.rendezvousPath, this.rendezvous) }

  async stop(): Promise<void> {
    await unpublishRendezvous(this.rendezvousPath, this.instanceId)
    await this.server.close().catch(() => undefined)
    await this.mesh.close().catch(() => undefined)
    await this.router.stop().catch(() => undefined)
    await rm(this.authFile, { force: true })
  }
}
