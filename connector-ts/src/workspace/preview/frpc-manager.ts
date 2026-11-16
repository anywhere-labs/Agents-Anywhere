// Manages the device's frpc process (09-port-preview.md §7): one process, proxies added and removed through the
// frpc admin API without restarting, tokens only from the Server and only in a private config file.
import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { WorkspaceError } from '../errors.js'
import { parseFrpsAddr, renderFrpcConfig, type FrpsEndpoint, type PreviewProxy } from './frpc-config.js'

/** One preview as the device serves it. */
export interface PreviewSpec extends PreviewProxy {
  readonly frpsAddr: string
  readonly tokenExpiresAt: string
}

/**
 * The data plane behind port preview. frp today; a built-in tunnel or LAN direct path can replace it without
 * touching the control plane (09 §3, §10).
 */
export interface PreviewTransport {
  open(spec: PreviewSpec): Promise<void>
  close(previewId: string): Promise<boolean>
  /** Closes every preview of a port that stopped listening; returns their ids. */
  closePort(port: number): Promise<string[]>
  closeAll(): Promise<void>
  openPreviews(): readonly PreviewSpec[]
}

export interface ChildLike {
  readonly pid?: number | undefined
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export interface FrpcManagerOptions {
  /** The frpc binary: bundled with Desktop, downloaded and verified by the CLI. `null` disables previews. */
  readonly frpcPath: string | null
  /** Private directory for the generated config (it holds short-lived tokens). */
  readonly dir: string
  /** The Connector's outbound proxy (NetworkEgress), so frpc leaves the same way as the device link. */
  readonly proxyUrl?: string | null
  readonly spawn?: (command: string, args: readonly string[]) => ChildLike
  readonly fetch?: typeof fetch
  readonly freePort?: () => Promise<number>
  readonly now?: () => number
  readonly log?: (message: string) => void
}

const READY_TIMEOUT_MS = 5000

export async function freeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}

const sameEndpoint = (a: FrpsEndpoint, b: FrpsEndpoint): boolean => a.protocol === b.protocol && a.host === b.host && a.port === b.port

export class FrpcManager implements PreviewTransport {
  private readonly previews = new Map<string, PreviewSpec>()
  private child: ChildLike | null = null
  private endpoint: FrpsEndpoint | null = null
  private loginToken = ''
  private loginExpiresAt = 0
  private admin: { port: number; user: string; password: string } | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private restartDelay = 1000
  private restartTimer: NodeJS.Timeout | undefined
  private stopping = false

  public constructor(private readonly options: FrpcManagerOptions) {}

  public openPreviews(): readonly PreviewSpec[] {
    return [...this.previews.values()]
  }

  /** Adds or refreshes a preview; reopening the same preview id replaces its port and token. */
  public open(spec: PreviewSpec): Promise<void> {
    return this.serial(async () => {
      if (this.options.frpcPath === null) throw new WorkspaceError('preview_unavailable', 'port preview is not available on this device (frpc missing)')
      const endpoint = parseFrpsAddr(spec.frpsAddr)
      this.previews.set(spec.previewId, spec)
      const expiresAt = Date.parse(spec.tokenExpiresAt)
      const needsRestart = this.child === null || this.endpoint === null || !sameEndpoint(this.endpoint, endpoint) ||
        // A login token only matters when frpc (re)connects; replace it once the current one has expired.
        (spec.token !== this.loginToken && this.loginExpiresAt <= this.now())
      this.loginToken = spec.token
      this.loginExpiresAt = Number.isFinite(expiresAt) ? expiresAt : this.now()
      this.endpoint = endpoint
      try {
        if (needsRestart) await this.restart()
        else await this.reload()
      } catch (error) {
        this.previews.delete(spec.previewId)
        throw error
      }
    })
  }

  public close(previewId: string): Promise<boolean> {
    return this.serial(async () => {
      if (!this.previews.delete(previewId)) return false
      await this.afterRemoval()
      return true
    })
  }

  public closePort(port: number): Promise<string[]> {
    return this.serial(async () => {
      const closed = [...this.previews.values()].filter(p => p.port === port).map(p => p.previewId)
      for (const id of closed) this.previews.delete(id)
      if (closed.length > 0) await this.afterRemoval()
      return closed
    })
  }

  public closeAll(): Promise<void> {
    return this.serial(async () => {
      this.previews.clear()
      await this.stop()
    })
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private configPath(): string {
    return join(this.options.dir, 'frpc.toml')
  }

  private async writeConfig(): Promise<void> {
    if (this.endpoint === null || this.admin === null) return
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 })
    const text = renderFrpcConfig({
      server: this.endpoint,
      loginToken: this.loginToken,
      admin: this.admin,
      proxyUrl: this.options.proxyUrl ?? null,
      proxies: [...this.previews.values()],
    })
    await writeFile(this.configPath(), text, { mode: 0o600 })
  }

  private async afterRemoval(): Promise<void> {
    if (this.previews.size === 0) await this.stop()
    else await this.reload()
  }

  private async restart(): Promise<void> {
    await this.stop()
    this.stopping = false
    this.admin = {
      port: await (this.options.freePort ?? freeLoopbackPort)(),
      user: 'aa',
      password: randomBytes(18).toString('base64url'),
    }
    await this.writeConfig()
    const child = (this.options.spawn ?? defaultSpawn)(this.options.frpcPath!, ['-c', this.configPath()])
    this.child = child
    child.once('exit', (code, signal) => this.exited(child, code, signal))
    await this.waitReady()
    this.restartDelay = 1000
  }

  private exited(child: ChildLike, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.child = null
    if (this.stopping || this.previews.size === 0) return
    this.options.log?.(`frpc exited (${code ?? signal}); restarting in ${this.restartDelay} ms`)
    const delay = this.restartDelay
    this.restartDelay = Math.min(this.restartDelay * 2, 30_000)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.serial(async () => {
        if (this.child === null && this.previews.size > 0) await this.restart().catch(error => this.options.log?.(`frpc restart failed: ${String(error)}`))
      })
    }, delay)
    this.restartTimer.unref?.()
  }

  private async adminCall(path: string): Promise<Response> {
    const admin = this.admin!
    const auth = Buffer.from(`${admin.user}:${admin.password}`).toString('base64')
    return await (this.options.fetch ?? fetch)(`http://127.0.0.1:${admin.port}${path}`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(3000),
    })
  }

  private async waitReady(): Promise<void> {
    const deadline = this.now() + READY_TIMEOUT_MS
    for (;;) {
      if (this.child === null) throw new WorkspaceError('preview_unavailable', 'frpc exited during startup')
      try {
        if ((await this.adminCall('/api/status')).ok) return
      } catch {
        // Not listening yet.
      }
      if (this.now() >= deadline) throw new WorkspaceError('preview_unavailable', 'frpc did not start in time')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  /** Hot-swaps the proxy list: rewrite the config, then ask frpc to reload it. */
  private async reload(): Promise<void> {
    if (this.child === null) return await this.restart()
    await this.writeConfig()
    const response = await this.adminCall('/api/reload?strictConfig=true').catch(() => null)
    if (response === null || !response.ok) await this.restart()
  }

  private async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    const child = this.child
    this.child = null
    if (child !== null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 2000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        if (!child.kill('SIGTERM')) {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    // Tokens never outlive the process that used them.
    await rm(this.configPath(), { force: true }).catch(() => undefined)
  }
}

function defaultSpawn(command: string, args: readonly string[]): ChildLike {
  return nodeSpawn(command, [...args], { stdio: 'ignore', windowsHide: true })
}
