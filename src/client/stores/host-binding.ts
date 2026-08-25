/**
 * Wire-bound handle to the Agents Anywhere Host API.
 *
 * The DSH browser exposes the host connection as `ctx.connection`, whose
 * `rpc` field is a `ClientConnectionRpc` with the signature
 * `call(channel, endpoint, payload, signal?) => Promise<RpcResult<unknown>>`.
 * We call the shared `/api` channel through the Typert Gateway: the Host
 * service binds the `agentsAnywhereConnector` namespace, so the endpoint is
 * `agentsAnywhereConnector/<method>` and the payload is `{ args }`. We unwrap
 * the `RpcResult` envelope (`{ ok, value } | { ok, error }`) into plain
 * `Promise<T>` / thrown `Error`, which is what the connector store consumes.
 */

import {
  type ConnectorCredentials,
  type ConnectorHostApi,
  type ConnectorLogChunk,
  type ConnectorStateSnapshot,
  type EnvironmentInfo,
  type OperationResult,
  type PairingStartResult,
} from '../../common/types.js'

/** The Typert namespace bound by `AgentsAnywhereConnectorService`. */
const HOST_NAMESPACE = 'agentsAnywhereConnector'

/** Structural view of `ClientConnectionRpc` (avoids a hard type dependency). */
export type HostRpc = {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }>
}

/**
 * Build a typed `ConnectorHostApi` proxy backed by the DSH `connection.rpc`.
 * Every method resolves to the Host's `RpcResult.value`, or rejects with the
 * Host's `error.message`.
 */
export function createHostApi(rpc: HostRpc): ConnectorHostApi {
  const call = async <TResult>(method: string, args: Record<string, unknown> = {}): Promise<TResult> => {
    const result = await rpc.call('/api', `${HOST_NAMESPACE}/${method}`, { args })
    if (result.ok === true) return result.value as TResult
    throw new Error(result.error?.message ?? 'connector host rpc failed')
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
    saveCredentials: (credentials: ConnectorCredentials) => call<OperationResult>('saveCredentials', { credentials }),
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
