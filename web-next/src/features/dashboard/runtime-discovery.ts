import { isApiError } from "@/lib/api/errors"
import { isTransientHttpStatus, retryWithDelays, waitFor } from "@/lib/retry"

import { dashboardApi } from "@/features/dashboard/api"
import { mergeRuntimeTypes } from "@/features/dashboard/runtime-instances"
import type { DeviceRuntimeView, RuntimeTypeView } from "@/features/dashboard/types"

const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000] as const

export type ConnectorRuntimeOverview = {
  runtimes: DeviceRuntimeView[]
  runtimeTypes: RuntimeTypeView[]
}

export async function loadConnectorRuntimeOverview(
  token: string,
  connectorId: string,
): Promise<ConnectorRuntimeOverview> {
  const [runtimeResponse, typeResponse] = await Promise.all([
    dashboardApi.getConnectorRuntimes(token, connectorId),
    dashboardApi.getConnectorRuntimeTypes(token, connectorId),
  ])
  return {
    runtimes: runtimeResponse.runtimes,
    runtimeTypes: mergeRuntimeTypes(typeResponse.runtimeTypes, runtimeResponse.runtimes),
  }
}

export async function discoverConnectorRuntimeOverview(
  token: string,
  connectorId: string,
  options: {
    initialDelayMs?: number
    retryDelaysMs?: readonly number[]
  } = {},
): Promise<ConnectorRuntimeOverview> {
  if (options.initialDelayMs) await waitFor(options.initialDelayMs)
  return retryWithDelays(
    async () => {
      const typeResponse = await dashboardApi.discoverConnectorRuntimeTypes(token, connectorId)
      const runtimeResponse = await dashboardApi.getConnectorRuntimes(token, connectorId)
      return {
        runtimes: runtimeResponse.runtimes,
        runtimeTypes: mergeRuntimeTypes(typeResponse.runtimeTypes, runtimeResponse.runtimes),
      }
    },
    options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
    isRetryableRuntimeDiscoveryError,
  )
}

function isRetryableRuntimeDiscoveryError(error: unknown): boolean {
  return isApiError(error) && isTransientHttpStatus(error.status)
}
