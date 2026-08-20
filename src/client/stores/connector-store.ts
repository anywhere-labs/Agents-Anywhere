/**
 * Local UI state for the Agents Anywhere settings surface.
 *
 * The four cards (Overview / Pairing / Logs / Environment) all read from one
 * reducer-backed store so toggling tabs never loses scrollback, pairing flow
 * survives a navigation, and mocked actions update the same view the future
 * Host RPC will drive.
 *
 * No external state library: the store is a single `useReducer` keyed by a
 * monotonically incrementing version so memo selectors stay cheap.
 */

import { useEffect, useMemo, useReducer, useRef } from 'react'

export type ConnectorRuntimeState = 'stopped' | 'starting' | 'running' | 'error'
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
export type PairingStatus = 'idle' | 'starting' | 'waiting' | 'claimed' | 'cancelled' | 'error'
export type PythonStatus = 'pending' | 'ready' | 'error'
export type UvSource = 'custom' | 'system' | 'npm-bundled' | 'downloaded' | 'unresolved'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ConnectorLog {
  readonly id: string
  readonly time: number
  readonly level: LogLevel
  readonly logger: string
  readonly message: string
}

export interface DeviceBinding {
  readonly deviceId: string
  readonly deviceName: string
  readonly pairedAt: number
}

export interface BridgeInfo {
  readonly port: number
  readonly pid: number
  readonly activeSessions: number
  readonly pushChannel: 'open' | 'idle' | 'closed'
}

export interface EnvironmentSettings {
  autoStart: boolean
  uvSource: UvSource
  uvPath: string | null
  uvVersion: string | null
  pythonStatus: PythonStatus
  pythonVersion: string | null
  pypiMirror: string
}

export interface PairingState {
  status: PairingStatus
  code: string | null
  claimUrl: string | null
  expiresAt: number | null
  serverUrl: string
  lastError: string | null
}

export interface ConnectorState {
  version: number
  runtime: ConnectorRuntimeState
  runtimeError: string | null
  connection: ConnectionState
  bridge: BridgeInfo | null
  device: DeviceBinding | null
  pairing: PairingState
  environment: EnvironmentSettings
  logs: ConnectorLog[]
  dataDir: string
}

type Action =
  | { type: 'runtime/start' }
  | { type: 'runtime/running'; bridge: BridgeInfo }
  | { type: 'runtime/error'; message: string }
  | { type: 'runtime/stop' }
  | { type: 'connection/set'; state: ConnectionState }
  | { type: 'pairing/set-server'; serverUrl: string }
  | { type: 'pairing/start' }
  | { type: 'pairing/waiting'; code: string; claimUrl: string; expiresAt: number }
  | { type: 'pairing/claimed'; device: DeviceBinding }
  | { type: 'pairing/cancel' }
  | { type: 'pairing/error'; message: string }
  | { type: 'pairing/clear-credentials' }
  | { type: 'environment/set'; patch: Partial<EnvironmentSettings> }
  | { type: 'logs/append'; entry: ConnectorLog }
  | { type: 'logs/clear' }

const PYPI_MIRRORS: Record<string, string> = {
  tsinghua: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  aliyun: 'https://mirrors.aliyun.com/pypi/simple/',
  tencent: 'https://mirrors.cloud.tencent.com/pypi/simple/',
  official: 'https://pypi.org/simple',
}

export const PYPI_MIRROR_OPTIONS: ReadonlyArray<{ id: keyof typeof PYPI_MIRRORS; label: string; url: string }> = [
  { id: 'tsinghua', label: '清华大学开源软件镜像', url: PYPI_MIRRORS.tsinghua! },
  { id: 'aliyun', label: '阿里云 PyPI 镜像', url: PYPI_MIRRORS.aliyun! },
  { id: 'tencent', label: '腾讯云 PyPI 镜像', url: PYPI_MIRRORS.tencent! },
  { id: 'official', label: 'PyPI 官方源', url: PYPI_MIRRORS.official! },
]

function nowMs(): number {
  return Date.now()
}

function freshId(): string {
  return Math.random().toString(36).slice(2, 10)
}

const INITIAL_STATE: ConnectorState = {
  version: 0,
  runtime: 'stopped',
  runtimeError: null,
  connection: 'disconnected',
  bridge: null,
  device: null,
  pairing: {
    status: 'idle',
    code: null,
    claimUrl: null,
    expiresAt: null,
    serverUrl: 'https://api.anywhere.app.com',
    lastError: null,
  },
  environment: {
    autoStart: true,
    uvSource: 'npm-bundled',
    uvPath: null,
    uvVersion: 'uv 0.6.14',
    pythonStatus: 'ready',
    pythonVersion: 'Python 3.12.6',
    pypiMirror: PYPI_MIRRORS.tsinghua!,
  },
  logs: [
    {
      id: freshId(),
      time: nowMs() - 60_000,
      level: 'info',
      logger: 'bridge',
      message: 'Loopback endpoint bound to 127.0.0.1:54321 (token issued, descriptor published).',
    },
    {
      id: freshId(),
      time: nowMs() - 45_000,
      level: 'debug',
      logger: 'catalog',
      message: 'Model catalog refreshed (4 enabled, 0 disabled).',
    },
    {
      id: freshId(),
      time: nowMs() - 30_000,
      level: 'info',
      logger: 'session',
      message: 'Workspace backfill complete: 2 session(s) grouped, 0 failed.',
    },
    {
      id: freshId(),
      time: nowMs() - 18_000,
      level: 'warn',
      logger: 'env',
      message: 'Connector CLI not managed yet — uv resolution and subprocess control arrive in a follow-up step.',
    },
  ],
  dataDir: '~/.agents-anywhere',
}

function reducer(state: ConnectorState, action: Action): ConnectorState {
  switch (action.type) {
    case 'runtime/start':
      return { ...state, version: state.version + 1, runtime: 'starting', runtimeError: null }
    case 'runtime/running':
      return {
        ...state,
        version: state.version + 1,
        runtime: 'running',
        runtimeError: null,
        bridge: action.bridge,
      }
    case 'runtime/error':
      return {
        ...state,
        version: state.version + 1,
        runtime: 'error',
        runtimeError: action.message,
      }
    case 'runtime/stop':
      return {
        ...state,
        version: state.version + 1,
        runtime: 'stopped',
        runtimeError: null,
        bridge: null,
        connection: 'disconnected',
      }
    case 'connection/set':
      return { ...state, version: state.version + 1, connection: action.state }
    case 'pairing/set-server':
      return {
        ...state,
        version: state.version + 1,
        pairing: { ...state.pairing, serverUrl: action.serverUrl },
      }
    case 'pairing/start':
      return {
        ...state,
        version: state.version + 1,
        pairing: { ...state.pairing, status: 'starting', lastError: null },
      }
    case 'pairing/waiting':
      return {
        ...state,
        version: state.version + 1,
        pairing: {
          ...state.pairing,
          status: 'waiting',
          code: action.code,
          claimUrl: action.claimUrl,
          expiresAt: action.expiresAt,
          lastError: null,
        },
      }
    case 'pairing/claimed':
      return {
        ...state,
        version: state.version + 1,
        pairing: { ...state.pairing, status: 'claimed', code: null, claimUrl: null, expiresAt: null },
        device: action.device,
        connection: 'connected',
      }
    case 'pairing/cancel':
      return {
        ...state,
        version: state.version + 1,
        pairing: { ...state.pairing, status: 'cancelled', code: null, claimUrl: null, expiresAt: null },
      }
    case 'pairing/error':
      return {
        ...state,
        version: state.version + 1,
        pairing: { ...state.pairing, status: 'error', lastError: action.message, code: null, claimUrl: null, expiresAt: null },
      }
    case 'pairing/clear-credentials':
      return {
        ...state,
        version: state.version + 1,
        device: null,
        connection: 'disconnected',
        pairing: { ...state.pairing, status: 'idle', lastError: null },
      }
    case 'environment/set':
      return {
        ...state,
        version: state.version + 1,
        environment: { ...state.environment, ...action.patch },
      }
    case 'logs/append':
      return {
        ...state,
        version: state.version + 1,
        logs: [...state.logs, action.entry].slice(-500),
      }
    case 'logs/clear':
      return { ...state, version: state.version + 1, logs: [] }
  }
}

/** React hook returning the connector state plus a typed dispatch surface. */
export function useConnectorStore(): {
  state: ConnectorState
  actions: ConnectorActions
} {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)

  const actions = useMemo<ConnectorActions>(() => ({
    startRuntime: () => dispatch({ type: 'runtime/start' }),
    runtimeRunning: (bridge: BridgeInfo) => dispatch({ type: 'runtime/running', bridge }),
    runtimeError: (message: string) => dispatch({ type: 'runtime/error', message }),
    stopRuntime: () => dispatch({ type: 'runtime/stop' }),
    setConnection: (connection: ConnectionState) => dispatch({ type: 'connection/set', state: connection }),
    setServerUrl: (serverUrl: string) => dispatch({ type: 'pairing/set-server', serverUrl }),
    startPairing: () => dispatch({ type: 'pairing/start' }),
    pairingWaiting: (code: string, claimUrl: string, expiresAt: number) =>
      dispatch({ type: 'pairing/waiting', code, claimUrl, expiresAt }),
    pairingClaimed: (device: DeviceBinding) => dispatch({ type: 'pairing/claimed', device }),
    cancelPairing: () => dispatch({ type: 'pairing/cancel' }),
    pairingError: (message: string) => dispatch({ type: 'pairing/error', message }),
    clearCredentials: () => dispatch({ type: 'pairing/clear-credentials' }),
    updateEnvironment: (patch: Partial<EnvironmentSettings>) => dispatch({ type: 'environment/set', patch }),
    appendLog: (entry: ConnectorLog) => dispatch({ type: 'logs/append', entry }),
    clearLogs: () => dispatch({ type: 'logs/clear' }),
  }), [])

  return { state, actions }
}

export interface ConnectorActions {
  startRuntime(): void
  runtimeRunning(bridge: BridgeInfo): void
  runtimeError(message: string): void
  stopRuntime(): void
  setConnection(connection: ConnectionState): void
  setServerUrl(serverUrl: string): void
  startPairing(): void
  pairingWaiting(code: string, claimUrl: string, expiresAt: number): void
  pairingClaimed(device: DeviceBinding): void
  cancelPairing(): void
  pairingError(message: string): void
  clearCredentials(): void
  updateEnvironment(patch: Partial<EnvironmentSettings>): void
  appendLog(entry: ConnectorLog): void
  clearLogs(): void
}

/**
 * Demo-only ticker that pings the store with a realistic state transition once
 * per few seconds. Drop the call when the real Host RPC is wired up.
 */
export function useDemoStateMachine(actions: ConnectorActions): void {
  const counter = useRef(0)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const timer = setInterval(() => {
      counter.current += 1
      const tick = counter.current
      if (tick === 1) {
        actions.runtimeRunning({ port: 54321, pid: 4242, activeSessions: 3, pushChannel: 'open' })
        actions.appendLog({
          id: freshId(),
          time: nowMs(),
          level: 'info',
          logger: 'bridge',
          message: 'Bridge ready: dsh runtime exposed at 127.0.0.1:54321.',
        })
      } else if (tick === 2) {
        actions.setConnection('connecting')
        actions.appendLog({
          id: freshId(),
          time: nowMs(),
          level: 'info',
          logger: 'connector',
          message: 'Pairing channel opening against https://api.anywhere.app.com …',
        })
      } else if (tick === 3) {
        actions.setConnection('connected')
        actions.appendLog({
          id: freshId(),
          time: nowMs(),
          level: 'info',
          logger: 'connector',
          message: 'WebSocket link established (region: cn-hangzhou).',
        })
      }
      if (tick >= 4) clearInterval(timer)
    }, 1800)
    return () => clearInterval(timer)
  }, [actions])
}