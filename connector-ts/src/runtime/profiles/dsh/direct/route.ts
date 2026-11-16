/**
 * The direct route: the Connector spawns DSH's automation ACP and drives it over stdio
 * (D7). One process serves every direct session of one DSH runtime instance.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { directCapabilities } from '../capabilities.js'
import { catalogsOf } from '../dialect.js'
import type { DshLaunchPlan } from '../launcher.js'
import type { Catalogs, NativeHistoryPage, NativeSessionPage, NativeSessionRef, NewSessionSpec, RuntimeCapabilities, RuntimeHandle } from '../port.js'
import { DshDirectSession } from './session.js'

export interface DirectRouteOptions {
  plan: DshLaunchPlan
  env: NodeJS.ProcessEnv
  /** Test seam: an already-connected ACP stream instead of a child process. */
  stream?: acp.Stream
  initializeTimeoutMs?: number
}

/** DSH's write lock surfaces as a bare internal error on resume (S7); name it. */
export class DshSessionBusyError extends Error {
  readonly code = 'writer_held'
  constructor(readonly externalSessionId: string, cause?: unknown) {
    super('Another DSH process holds this session (DSH Desktop or dsh web may have it open).', { cause })
  }
}

export class DshDirectRoute implements RuntimeHandle {
  private readonly sessions = new Map<string, DshDirectSession>()
  private lastConfig: acp.SessionConfigOption[] = []
  private stderr = ''
  private stopping: Promise<void> | undefined
  readonly exited: Promise<number | null>

  private constructor(readonly plan: DshLaunchPlan, private readonly child: ChildProcess | undefined,
    readonly conn: acp.ClientSideConnection, readonly init: acp.InitializeResponse, exited: Promise<number | null>) {
    this.exited = exited
    child?.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-8192) })
  }

  static async start(options: DirectRouteOptions): Promise<DshDirectRoute> {
    let child: ChildProcess | undefined
    let stream = options.stream
    let exited: Promise<number | null> = new Promise(() => {})
    if (!stream) {
      child = spawn(options.plan.command, options.plan.args, {
        env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group on POSIX so stop() reaches npx's child too.
        detached: process.platform !== 'win32', windowsHide: true,
      })
      exited = new Promise(resolve => child!.once('exit', code => resolve(code)))
      stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>)
    }
    let route: DshDirectRoute | undefined
    const client: acp.Client = {
      requestPermission: params => route?.sessions.get(params.sessionId)?.requestPermission(params)
        ?? Promise.resolve({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async params => { route?.sessions.get(params.sessionId)?.update(params) },
    }
    const conn = new acp.ClientSideConnection(() => client, stream)
    const timeout = options.initializeTimeoutMs ?? (options.plan.source === 'npx' ? 180_000 : 30_000)
    let timer: NodeJS.Timeout | undefined
    try {
      const init = await Promise.race([
        conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DSH did not answer initialize in time.')), timeout) }),
        exited.then(code => { throw new Error(`DSH exited during startup (code ${code}).`) }),
      ])
      route = new DshDirectRoute(options.plan, child, conn, init, exited)
      return route
    } catch (error) {
      if (child) killTree(child)
      throw error
    } finally { if (timer) clearTimeout(timer) }
  }

  get diagnostics(): { plan: DshLaunchPlan, stderrTail: string } { return { plan: this.plan, stderrTail: this.stderr } }

  capabilities(): RuntimeCapabilities { return directCapabilities(this.init, this.lastConfig) }

  async catalogs(): Promise<Catalogs> {
    // ACP has no session-less catalog; report what the last opened session advertised.
    return catalogsOf(this.lastConfig)
  }

  async listNativeSessions(cursor?: string): Promise<NativeSessionPage> {
    const page = await this.conn.listSessions({ ...(cursor ? { cursor } : {}) })
    return { sessions: page.sessions.map(item => ({ externalSessionId: item.sessionId, cwd: item.cwd,
      title: item.title ?? null, updatedAt: item.updatedAt ?? null })), nextCursor: page.nextCursor ?? null }
  }

  /** DSH's automation ACP replays nothing; history lives in the Connector's store. */
  async readNativeHistory(): Promise<NativeHistoryPage> { return { events: [], complete: false } }

  isOpen(externalSessionId: string): boolean { return this.sessions.has(externalSessionId) }
  get openSessions(): readonly DshDirectSession[] { return [...this.sessions.values()] }

  async open(target: NativeSessionRef | NewSessionSpec): Promise<DshDirectSession> {
    if ('externalSessionId' in target) {
      const existing = this.sessions.get(target.externalSessionId)
      if (existing) return existing
      let response: acp.ResumeSessionResponse
      try { response = await this.conn.resumeSession({ sessionId: target.externalSessionId, cwd: target.cwd, mcpServers: [] }) }
      catch (error) {
        if (error instanceof acp.RequestError && error.code === -32603) throw new DshSessionBusyError(target.externalSessionId, error)
        throw error
      }
      return this.track(target.externalSessionId, response.configOptions)
    }
    const response = await this.conn.newSession({ cwd: target.cwd, mcpServers: [] })
    return this.track(response.sessionId, response.configOptions)
  }

  private track(id: string, configOptions: acp.SessionConfigOption[] | null | undefined): DshDirectSession {
    if (configOptions?.length) this.lastConfig = [...configOptions]
    const session = new DshDirectSession(this.conn, id, directCapabilities(this.init, configOptions ?? this.lastConfig), configOptions,
      () => { this.sessions.delete(id) })
    this.sessions.set(id, session)
    return session
  }

  /** Close every session (releasing DSH's write locks), then end the process. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      await Promise.allSettled([...this.sessions.values()].map(session => session.close()))
      if (!this.child) return
      this.child.stdin?.end()
      const exited = await Promise.race([this.exited.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 5000))])
      if (!exited) killTree(this.child)
    })()
    return this.stopping
  }
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
    else child.kill()
  } catch { child.kill() }
}
