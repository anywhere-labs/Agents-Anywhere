// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/native_runtime.py @98dd0e6e5 (NativePiRuntime, history browsing)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/profiles/pi/runtime.py @98dd0e6e5 (ManagedPiRuntime)
//
// Pi's RuntimeHandle: the native session inventory and read-only history come from the native history companion
// layer; one Pi process per AA session (PiRuntimeSession). The managed environment is prepared in the background
// without blocking start.

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type {
  AgentProcessInfo,
  Capability,
  Catalogs,
  ConfigOption,
  HistoryWindow,
  NativeHistoryPage,
  NativeSessionPage,
  NativeSessionRef,
  NewSessionSpec,
  OpenOptions,
  OpenTarget,
  PreparedSession,
  PrepareOptions,
  RuntimeCapabilities,
  RuntimeHandle,
  RuntimeHandleEvent,
} from '../../../application/ports/runtime-session.js'
import { piNativeSessionId } from '../../../domain/identity/index.js'
import type { AcpDialect } from '../../acp/dialect.js'
import { RuntimeFailure } from '../../acp/errors.js'
import { AcpRuntimeHandle, WORKSPACE_PREPARATION_CAPABILITIES, catalogsFromConfig, processConnection, type AcpConnection } from '../../acp/handle.js'
import { prepareFailure, preparedSession } from '../../acp/prepared.js'
import { EventQueue } from '../../acp/queue.js'
import { runtimeError } from '../../acp/session.js'
import { piHistoryPage, piTimeline, PiNativeIndex } from '../../companions/native-history/index.js'
import { agentEnvironment } from '../../supervisor/environment.js'
import type { LocalLaunch } from '../launch.js'
import { PI_PERMISSION_OPTIONS } from './definition.js'
import { historyDirectories } from './installation.js'
import { PiSessionAliases } from './aliases.js'
import type { PiLayout } from './launch.js'
import { PermissionStore, PiRuntimeSession, type PiSessionHost } from './session.js'
import { updateDefaultModel, type PiSettings } from './settings.js'

/** A session's process is stopped after this much idle time (the session sleeps and restarts on the next input). */
export const DEFAULT_SESSION_IDLE_MS = 10 * 60_000
/** Idle time handed to the generic process pool: Pi sessions manage idleness themselves, so the pool must not act first. */
const POOL_IDLE_MS = 2 ** 31 - 1

/** Connection that starts a Pi process (tests replace it with an in-memory connection). */
export type PiConnect = (environment: Readonly<Record<string, string>>, dialect: AcpDialect) => Promise<AcpConnection>

export interface PiHandleOptions {
  readonly instanceId: string
  readonly settings: PiSettings
  readonly layout: PiLayout
  /** Launch preparation before every process start (re-verifies the installation, patch and execution source). */
  readonly launch: () => Promise<LocalLaunch>
  readonly connect?: PiConnect
  readonly idleMs?: number
  /**
   * Native session lock directory (defaults to ~/.cache/agents-anywhere/pi-native-locks, shared with other Connectors
   * on the same machine).
   */
  readonly lockDir?: string
  readonly onStderr?: (line: string) => void
  /**
   * Prepare the managed environment once in the background (downloading Node / npm packages can take long); status
   * is reported through events.
   */
  readonly warmUp?: boolean
  readonly env?: NodeJS.ProcessEnv
}

/** Capabilities before any process has started: those Pi always has (real values are updated after the first session handshake). */
const INITIAL_CAPABILITIES: readonly Capability[] = [
  { id: 'session.send_message', supported: true },
  { id: 'session.interrupt', supported: true },
  { id: 'session.interaction.approval', supported: true },
  { id: 'session.configuration.read', supported: true },
  { id: 'session.configuration.update', supported: true },
  { id: 'session.list', supported: true },
  { id: 'session.history.native', supported: true },
  { id: 'catalog.permission', supported: true },
  // A new session can start in plan mode from a prepared workspace (the planning intent of its creation).
  { id: 'session.planning', supported: true, parameters: { preparedCreation: true } },
  { id: 'session.plan_document', supported: true },
  { id: 'session.plan_review', supported: true },
]

export class PiRuntimeHandle implements RuntimeHandle {
  readonly type = 'pi'
  readonly instanceId: string
  readonly events = new EventQueue<RuntimeHandleEvent>()
  readonly index: PiNativeIndex
  readonly aliases: PiSessionAliases
  private readonly sessions = new Set<PiRuntimeSession>()
  private readonly permissions: PermissionStore
  private capabilityItems: readonly Capability[] = INITIAL_CAPABILITIES
  private revision = 1
  private lastConfig: readonly ConfigOption[] = []
  private stopped = false
  private ready: Promise<void> | undefined

  constructor(private readonly options: PiHandleOptions) {
    this.instanceId = options.instanceId
    const agentDir = options.layout.agentDir
    this.aliases = new PiSessionAliases(join(options.layout.root, 'pi-session-aliases.json'))
    this.index = new PiNativeIndex(() => [
      ...historyDirectories(options.settings as unknown as Parameters<typeof historyDirectories>[0], agentDir),
      ...(options.layout.sessionDir !== undefined ? [options.layout.sessionDir] : []),
    ], this.aliases)
    this.permissions = new PermissionStore(options.layout.permissionFile)
    if (options.warmUp) this.ready = this.warmUp()
  }

  private async warmUp(): Promise<void> {
    this.events.push({ type: 'status', status: 'starting' })
    try {
      await this.options.launch()
      this.events.push({ type: 'status', status: 'ready' })
    } catch (error) {
      const failure = error instanceof RuntimeFailure ? error.error : { code: 'pi_environment_failed', message: 'Pi 运行环境准备失败，请检查配置和网络后重试。' }
      this.events.push({ type: 'status', status: 'degraded', error: failure })
    }
  }

  capabilities(): RuntimeCapabilities {
    return { revision: this.revision, items: [...this.capabilityItems, ...WORKSPACE_PREPARATION_CAPABILITIES] }
  }

  async catalogs(): Promise<Catalogs> {
    return this.catalogsOf(this.lastConfig)
  }

  private catalogsOf(config: readonly ConfigOption[]): Catalogs {
    const fromConfig = catalogsFromConfig('pi', config)
    return {
      ...fromConfig,
      permissions: {
        runtime: 'pi',
        revision: 1,
        permissions: PI_PERMISSION_OPTIONS.map(([value, title]) => ({ id: value, displayName: title, description: null, default: value === 'ask', selectionId: value, metadata: {} })),
      },
    }
  }

  /** Read-only inventory of native JSONL files; does not start Pi. */
  listNativeSessions(cursor?: string): Promise<NativeSessionPage> {
    return this.index.list(cursor)
  }

  /**
   * Parse the file without opening or writing the native session. Browsing keeps the original history IDs.
   * A Conversation supplies its ID so its projected assistant replies match the live stream.
   */
  async readNativeHistory(ref: NativeSessionRef, window: HistoryWindow): Promise<NativeHistoryPage> {
    const source = await this.index.find(ref)
    const history = await this.index.read(source.path)
    const nativeKey = piNativeSessionId(this.instanceId, history.path, source.externalSessionId)
    return piHistoryPage(piTimeline(history, nativeKey, 'pi', window.sessionId), window, history.complete)
  }

  async open(target: OpenTarget, options: OpenOptions): Promise<PiRuntimeSession> {
    if (this.stopped) throw new RuntimeFailure({ code: 'runtime_stopped', message: 'Pi 实例已停止。' })
    await this.ready
    const session = target.kind === 'new'
      ? await PiRuntimeSession.open(this.host(), options.sessionId, { kind: 'new', spec: target.spec })
      : await PiRuntimeSession.open(this.host(), options.sessionId, { kind: 'existing', source: await this.index.find(target.ref), replay: options.replay })
    this.sessions.add(session)
    return session
  }

  /**
   * Starts a Pi process for `spec.cwd` and creates its session ahead of the AA session. A failure to set up the Pi
   * environment is definite (the Agent never got the request).
   */
  async prepare(spec: NewSessionSpec, options: PrepareOptions): Promise<PreparedSession> {
    if (this.stopped) throw new RuntimeFailure({ code: 'runtime_stopped', message: 'Pi 实例已停止。' })
    if (this.options.connect === undefined) {
      try {
        await this.options.launch()
      } catch (error) {
        throw prepareFailure(error instanceof RuntimeFailure ? error : new RuntimeFailure(runtimeError(error, 'pi_environment_failed')), true)
      }
    }
    let session: PiRuntimeSession
    try {
      session = await this.open({ kind: 'new', spec: { cwd: spec.cwd } }, { sessionId: options.preparationId, replay: 'none' })
    } catch (error) {
      throw prepareFailure(error, false)
    }
    return preparedSession(session, { catalogs: async () => this.catalogsOf(session.configOptions), canPlan: true })
  }

  /** Each Pi session runs its own process. */
  agentProcesses(): AgentProcessInfo[] {
    return [...this.sessions].flatMap(session => session.agentProcesses())
  }

  async stop(): Promise<void> {
    this.stopped = true
    await Promise.all([...this.sessions].map(session => session.close().catch(() => undefined)))
    this.events.push({ type: 'status', status: 'stopped' })
    this.events.close()
  }

  /**
   * When only the gateway's default model changed, the managed environment needs no restart: the private
   * settings.json is updated, sessions opened afterwards (each Pi process reads it at start) use the new model, and
   * existing sessions keep theirs. Returns false when not in the managed environment or it is not ready yet.
   */
  async applyDefaultModel(model: string | undefined): Promise<boolean> {
    if (!this.options.layout.managed) return false
    try {
      await updateDefaultModel(this.options.layout.agentDir, model)
      return true
    } catch {
      return false
    }
  }

  /** Number of sessions (tests and diagnostics). */
  get openSessions(): number {
    return this.sessions.size
  }

  private host(): PiSessionHost {
    const options = this.options
    return {
      instanceId: this.instanceId,
      index: this.index,
      permissions: this.permissions,
      aliases: this.aliases,
      planningDir: options.layout.planningDir,
      stateDir: options.layout.root,
      lockDir: options.lockDir ?? join(homedir(), '.cache/agents-anywhere/pi-native-locks'),
      idleMs: options.idleMs ?? DEFAULT_SESSION_IDLE_MS,
      spawn: (environment, dialect) => new AcpRuntimeHandle({
        type: 'pi',
        instanceId: this.instanceId,
        dialect,
        connect: () => this.connect(environment, dialect),
        idleMs: POOL_IDLE_MS,
        permissionOptions: PI_PERMISSION_OPTIONS,
      }),
      observe: (capabilities, config) => {
        if (JSON.stringify(capabilities) !== JSON.stringify(this.capabilityItems)) {
          this.capabilityItems = capabilities
          this.revision += 1
          this.events.push({ type: 'capabilities.changed', capabilities: this.capabilities() })
        }
        if (JSON.stringify(config) !== JSON.stringify(this.lastConfig)) {
          this.lastConfig = config
          void this.catalogs().then(catalogs => this.events.push({ type: 'catalogs.changed', catalogs }))
        }
      },
      released: session => {
        this.sessions.delete(session)
      },
    }
  }

  private async connect(environment: Readonly<Record<string, string>>, dialect: AcpDialect): Promise<AcpConnection> {
    if (this.options.connect) return this.options.connect(environment, dialect)
    let launch: LocalLaunch
    try {
      launch = await this.options.launch()
    } catch (error) {
      throw error instanceof RuntimeFailure ? error : new RuntimeFailure(runtimeError(error, 'pi_environment_failed'))
    }
    const onStderr = this.options.onStderr
    await mkdir(this.options.layout.root, { recursive: true, mode: 0o700 })
    return processConnection(
      {
        command: launch.command,
        args: launch.args,
        cwd: this.options.layout.root,
        env: agentEnvironment({ ...launch.environment, ...environment }, this.options.env ? { base: this.options.env } : {}),
      },
      dialect,
      onStderr ? { onStderr } : {},
    )()
  }
}
