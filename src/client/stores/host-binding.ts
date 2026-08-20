/**
 * Wire-bound handle to the Agents Anywhere Host API.
 *
 * The hook returns a typed surface that proxies every method through
 * `ctx.connection.call` against the registered `agentsAnywhereConnector`
 * Cordis entry. Callers receive Promises that resolve with the typed DTO.
 *
 * NOTE: the cards in this milestone still drive their UI off the local
 * `useConnectorStore` (mock data); switching them to the live host is the
 * follow-up step. The hook exists so the wire contract is in place and
 * exercises the `ConnectorHostApi` types against the real shape.
 */

import { useMemo } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConnectorHostApi,
  ConnectorStateSnapshot,
  EnvironmentInfo,
  OperationResult,
  PairingStartResult,
  ConnectorLogChunk,
} from '../../common/types.js'

const HOST_API_NAME = 'agentsAnywhereConnector'

/**
 * Lazy proxy that turns method calls into `ctx.connection.call(...)`. The
 * returned surface is `ConnectorHostApi`-shaped so consumers get full type
 * safety at the call site.
 */
export function useHostApi(ctx: ClientContext): ConnectorHostApi {
  return useMemo<ConnectorHostApi>(() => {
    const call = <TResult>(method: string, params: Record<string, unknown> = {}): Promise<TResult> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connection = (ctx as any).connection
      if (connection === undefined) {
        return Promise.reject(new Error('DSH connection service unavailable'))
      }
      if (typeof connection.call !== 'function') {
        return Promise.reject(new Error('DSH connection does not expose call()'))
      }
      return Promise.resolve(connection.call(HOST_API_NAME, method, params)) as Promise<TResult>
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
  }, [ctx])
}