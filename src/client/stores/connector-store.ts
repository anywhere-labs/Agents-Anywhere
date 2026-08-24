/**
 * Host-backed connector state store.
 *
 * Every action proxies through the `agentsAnywhereConnector` Cordis service
 * (exposed via the DSH wire `connection.rpc`). A short polling loop keeps the
 * snapshot fresh — push events from the host will replace polling once the
 * bridge forwards `connector/state-changed` notifications to the browser.
 *
 * On any host error the store keeps the previous snapshot and surfaces the
 * message via `runtimeError` / `pairing.lastError` so the UI can show it.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import {
  type BridgeInfo,
  type ConnectionState,
  type ConnectorHostApi,
  type ConnectorLog,
  type ConnectorRuntimeState,
  type ConnectorStateSnapshot,
  type DeviceBinding,
  type EnvironmentInfo,
  type LogLevel,
  type PairingState,
  type PairingStatus,
  type PythonStatus,
  type UvSource,
} from '../../common/types.js'

// Re-export the shared types under the legacy aliases the cards import.
export type { ConnectorRuntimeState, PairingStatus, PythonStatus, UvSource, LogLevel }
export type { BridgeInfo, ConnectionState, DeviceBinding, EnvironmentInfo, PairingState, ConnectorLog }

/**
 * The cards consume a slightly wider shape than the wire DTO (they also
 * expect an in-memory `logs` array). This type is the on-screen projection.
 */
export interface ConnectorState {
  runtime: ConnectorRuntimeState
  runtimeError: string | null
  connection: ConnectionState
  bridge: BridgeInfo | null
  device: DeviceBinding | null
  pairing: PairingState
  environment: EnvironmentInfo
  logs: ConnectorLog[]
  dataDir: string
  /** Last host-call failure, surfaced in the Overview card. */
  lastError: string | null
}

type Action =
  | { type: 'hydrate'; snapshot: ConnectorStateSnapshot }
  | { type: 'runtime-error'; message: string }
  | { type: 'pairing-error'; message: string }
  | { type: 'logs-append'; entries: ConnectorLog[] }
  | { type: 'logs-clear' }

function reducer(state: ConnectorState, action: Action): ConnectorState {
  switch (action.type) {
    case 'hydrate':
      return {
        runtime: action.snapshot.runtime,
        runtimeError: action.snapshot.runtimeError,
        connection: action.snapshot.connection,
        bridge: action.snapshot.bridge,
        device: action.snapshot.device,
        pairing: action.snapshot.pairing,
        environment: action.snapshot.environment,
        logs: state.logs, // logs come from getLogs, not getState
        dataDir: action.snapshot.dataDir,
        lastError: null,
      }
    case 'runtime-error':
      return { ...state, runtimeError: action.message }
    case 'pairing-error':
      return { ...state, pairing: { ...state.pairing, lastError: action.message } }
    case 'logs-append':
      return { ...state, logs: [...state.logs, ...action.entries].slice(-500) }
    case 'logs-clear':
      return { ...state, logs: [] }
  }
}

function defaultState(): ConnectorState {
  return {
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
      pypiMirror: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    },
    logs: [],
    dataDir: '~/.agents-anywhere',
    lastError: null,
  }
}

const POLL_INTERVAL_MS = 2_000

export interface ConnectorActions {
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  setServerUrl(serverUrl: string): Promise<void>
  startPairing(): Promise<void>
  cancelPairing(): Promise<void>
  clearCredentials(): Promise<void>
  updateEnvironment(patch: Partial<EnvironmentInfo>): Promise<void>
  clearLogs(): Promise<void>
  refresh(): Promise<void>
}

/**
 * Primary hook: returns a `state` snapshot plus async `actions` that proxy to
 * the Host. Safe to call multiple times; each call returns its own store.
 *
 * The Host proxy is passed in (typically resolved by the section's slot
 * `inject` face) so this hook stays decoupled from the Cordis context.
 */
export function useConnectorStore(host: ConnectorHostApi): {
  state: ConnectorState
  actions: ConnectorActions
} {
  const [state, dispatch] = useReducer(reducer, undefined, defaultState)
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    if (host === undefined) return
    try {
      const [snapshot, logs] = await Promise.all([
        host.getState(),
        host.getLogs({ offset: 0, limit: 100 }).catch(() => ({ entries: [], total: 0 })),
      ])
      if (!mounted.current) return
      dispatch({ type: 'hydrate', snapshot })
      dispatch({ type: 'logs-clear' })
      dispatch({ type: 'logs-append', entries: logs.entries })
    } catch (error) {
      if (!mounted.current) return
      dispatch({ type: 'runtime-error', message: errorMessage(error) })
    }
  }, [host])

  // Initial + polling.
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [refresh])

  const actions = useMemo<ConnectorActions>(() => {
    // Defensive: if the wire hasn't delivered the Host proxy yet, throw a
    // friendly error instead of a raw `Cannot read properties of undefined`.
    const requireHost = (): ConnectorHostApi => {
      if (host === undefined) throw new Error('connector host unavailable')
      return host
    }
    return {
      refresh: () => refresh(),
      start: async () => {
        try {
          const result = await requireHost().start()
          if (!result.ok) dispatch({ type: 'runtime-error', message: result.error ?? 'unknown error' })
          await refresh()
        } catch (error) {
          dispatch({ type: 'runtime-error', message: errorMessage(error) })
        }
      },
      stop: async () => {
        try {
          const result = await requireHost().stop()
          if (!result.ok) dispatch({ type: 'runtime-error', message: result.error ?? 'unknown error' })
          await refresh()
        } catch (error) {
          dispatch({ type: 'runtime-error', message: errorMessage(error) })
        }
      },
      restart: async () => {
        try {
          const result = await requireHost().restart()
          if (!result.ok) dispatch({ type: 'runtime-error', message: result.error ?? 'unknown error' })
          await refresh()
        } catch (error) {
          dispatch({ type: 'runtime-error', message: errorMessage(error) })
        }
      },
      setServerUrl: async (serverUrl) => {
        // Persisted server URL — refresh will pull it back via getState once
        // the host picks it up. (The startPairing call also carries it.)
        try {
          await requireHost().startPairing(serverUrl)
        } catch (error) {
          dispatch({ type: 'pairing-error', message: errorMessage(error) })
        }
        await refresh()
      },
      startPairing: async () => {
        try {
          const result = await requireHost().startPairing()
          if (!result.ok) dispatch({ type: 'pairing-error', message: result.error ?? 'unknown error' })
          await refresh()
        } catch (error) {
          dispatch({ type: 'pairing-error', message: errorMessage(error) })
        }
      },
      cancelPairing: async () => {
        try {
          await requireHost().cancelPairing()
        } catch (error) {
          dispatch({ type: 'pairing-error', message: errorMessage(error) })
        }
        await refresh()
      },
      clearCredentials: async () => {
        try {
          await requireHost().clearCredentials()
        } catch (error) {
          dispatch({ type: 'pairing-error', message: errorMessage(error) })
        }
        await refresh()
      },
      updateEnvironment: async (patch) => {
        try {
          await requireHost().saveEnvironment(patch)
        } catch (error) {
          dispatch({ type: 'runtime-error', message: errorMessage(error) })
        }
        await refresh()
      },
      clearLogs: async () => {
        try {
          await requireHost().clearLogs()
        } catch (error) {
          dispatch({ type: 'runtime-error', message: errorMessage(error) })
        }
        await refresh()
      },
    }
  }, [host, refresh])

  return { state, actions }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
