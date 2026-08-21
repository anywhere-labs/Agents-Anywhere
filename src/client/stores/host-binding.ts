/**
 * Wire-bound handle to the Agents Anywhere Host API.
 *
 * Built lazily from a `connection` handle (the DSH wire carrier). The
 * returned surface is `ConnectorHostApi`-shaped so consumers get full type
 * safety at the call site.
 *
 * The factory is invoked from the slot's `inject` face so it can be wired
 * into the section component's props without exposing the raw Cordis
 * context to the renderer.
 */

import type {
  ConnectorHostApi,
  ConnectorLogChunk,
  ConnectorStateSnapshot,
  EnvironmentInfo,
  OperationResult,
  PairingStartResult,
} from '../../common/types.js'

export type HostConnection = {
  call<TResult>(apiName: string, method: string, params: Record<string, unknown>): Promise<TResult>
}

const HOST_API_NAME = 'agentsAnywhereConnector'

/**
 * Build a typed `ConnectorHostApi` proxy backed by the DSH wire connection.
 * The returned object is safe to keep in component props; it memoizes the
 * proxy functions on first construction.
 */
export function createHostApi(connection: HostConnection): ConnectorHostApi {
  const call = <TResult>(method: string, params: Record<string, unknown> = {}): Promise<TResult> => {
    return Promise.resolve(
      connection.call<TResult>(HOST_API_NAME, method, params),
    ) as Promise<TResult>
  }

  return {
    getState: () => call<ConnectorStateSnapshot>('getState'),
    start: () => call<OperationResult>('start'),
    stop: () => call<OperationResult>('stop'),
    restart: () => call<OperationResult>('restart'),
    startPairing: (serverUrl) =>
      call<PairingStartResult>('startPairing', serverUrl === undefined ? {} : { serverUrl }),
    cancelPairing: () => call<OperationResult>('cancelPairing'),
    clearCredentials: () => call<OperationResult>('clearCredentials'),
    detectEnvironment: () => call<EnvironmentInfo>('detectEnvironment'),
    saveEnvironment: (patch) => call<OperationResult>('saveEnvironment', { patch }),
    getLogs: (options) =>
      call<ConnectorLogChunk>('getLogs', options === undefined ? {} : { options }),
    clearLogs: () => call<OperationResult>('clearLogs'),
    openConfigDirectory: () => call<OperationResult>('openConfigDirectory'),
  }
}

/**
 * Convenience hook that pulls a `ConnectorHostApi` off the section's
 * `host` prop and memoizes it. Components consume it like a normal hook.
 */
export type HostProp = ConnectorHostApi | undefined