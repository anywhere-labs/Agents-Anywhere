/**
 * Shared types for the dsh-aa-connector plugin.
 *
 * This file is the single source of truth for the wire contract between the
 * Host (Node.js, `@agents-anywhere/dsh-aa-connector`) and the Client
 * (browser, exposed through the DSH `settings.section` slot). Both sides
 * import from here so the implementation stays in lockstep.
 */

export const PLUGIN_NAMESPACE = 'dsh-aa-connector'
export const BRIDGE_DESCRIPTOR_FILENAME = 'endpoint.json'

/** Stable identity used by the bridge locator discovery file. */
export interface BridgeEndpoint {
  readonly version: 1
  readonly host: '127.0.0.1'
  readonly port: number
  readonly token: string
  readonly pid: number
}

// ─── Runtime state ────────────────────────────────────────────────────────

export type ConnectorRuntimeState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'error'

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'

export type PairingStatus =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'claimed'
  | 'cancelled'
  | 'error'

export type PythonStatus = 'pending' | 'ready' | 'error'

export type UvSource =
  | 'custom'
  | 'system'
  | 'npm-bundled'
  | 'downloaded'
  | 'unresolved'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// ─── DTOs ────────────────────────────────────────────────────────────────

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

export interface PairingState {
  status: PairingStatus
  code: string | null
  claimUrl: string | null
  expiresAt: number | null
  serverUrl: string
  lastError: string | null
}

export interface EnvironmentInfo {
  autoStart: boolean
  uvSource: UvSource
  uvPath: string | null
  uvVersion: string | null
  pythonStatus: PythonStatus
  pythonVersion: string | null
  pypiMirror: string
}

export interface PairingStartResult {
  ok: boolean
  code?: string
  claimUrl?: string
  expiresAt?: number
  error?: string
}

export interface ConnectorLogChunk {
  entries: ConnectorLog[]
  total: number
}

export interface OperationResult {
  ok: boolean
  error?: string
}

// ─── State snapshot ───────────────────────────────────────────────────────

/**
 * Full snapshot of the connector host state, returned by `getState` and
 * pushed via the `connector/state-changed` event.
 */
export interface ConnectorStateSnapshot {
  version: 1
  runtime: ConnectorRuntimeState
  runtimeError: string | null
  connection: ConnectionState
  bridge: BridgeInfo | null
  device: DeviceBinding | null
  pairing: PairingState
  environment: EnvironmentInfo
  dataDir: string
  logBufferSize: number
}

// ─── Host RPC contract ────────────────────────────────────────────────────

/**
 * Methods the Client (browser) calls into the Host (Node.js). Implemented
 * by `AgentsAnywhereConnectorService` and exposed through the DSH wire
 * remote API as `agentsAnywhereConnector.*`.
 */
export interface ConnectorHostApi {
  // ── State ──
  getState(): Promise<ConnectorStateSnapshot>

  // ── Control ──
  start(): Promise<OperationResult>
  stop(): Promise<OperationResult>
  restart(): Promise<OperationResult>

  // ── Pairing ──
  startPairing(serverUrl?: string): Promise<PairingStartResult>
  cancelPairing(): Promise<OperationResult>
  clearCredentials(): Promise<OperationResult>

  // ── Environment & settings ──
  detectEnvironment(): Promise<EnvironmentInfo>
  saveEnvironment(patch: Partial<EnvironmentInfo>): Promise<OperationResult>

  // ── Logs ──
  getLogs(options?: { offset?: number; limit?: number; level?: string }): Promise<ConnectorLogChunk>
  clearLogs(): Promise<OperationResult>
  openConfigDirectory(): Promise<OperationResult>
}

// ─── Host → Client events ────────────────────────────────────────────────

/** Event payload envelope. The `kind` field identifies the schema. */
export interface ConnectorClientEvent {
  kind:
    | 'connector/state-changed'
    | 'connector/pairing-updated'
    | 'connector/log-appended'
    | 'connector/environment-updated'
    | 'connector/runtime-error'
  payload: unknown
}

export interface ConnectorStateChangedEvent extends ConnectorClientEvent {
  kind: 'connector/state-changed'
  payload: ConnectorStateSnapshot
}

export interface ConnectorPairingUpdatedEvent extends ConnectorClientEvent {
  kind: 'connector/pairing-updated'
  payload: PairingState
}

export interface ConnectorLogAppendedEvent extends ConnectorClientEvent {
  kind: 'connector/log-appended'
  payload: ConnectorLog
}

export interface ConnectorEnvironmentUpdatedEvent extends ConnectorClientEvent {
  kind: 'connector/environment-updated'
  payload: EnvironmentInfo
}

export interface ConnectorRuntimeErrorEvent extends ConnectorClientEvent {
  kind: 'connector/runtime-error'
  payload: { message: string }
}

// ─── Cordis registration ──────────────────────────────────────────────────

/** Default empty pairing state, mirrored on the Host and Client. */
export const INITIAL_PAIRING: PairingState = {
  status: 'idle',
  code: null,
  claimUrl: null,
  expiresAt: null,
  serverUrl: 'https://api.anywhere.app.com',
  lastError: null,
}

/** Default empty environment. */
export const INITIAL_ENVIRONMENT: EnvironmentInfo = {
  autoStart: true,
  uvSource: 'npm-bundled',
  uvPath: null,
  uvVersion: 'uv 0.6.14',
  pythonStatus: 'ready',
  pythonVersion: 'Python 3.12.6',
  pypiMirror: 'https://pypi.tuna.tsinghua.edu.cn/simple',
}