import { dashboardApi } from "@/features/dashboard/api"
import type { ConnectorView } from "@/features/dashboard/types"
import { isApiError } from "@/lib/api/errors"
import { isTransientHttpStatus } from "@/lib/retry"

// Owned by the app-level Agent setup queue, so closing the pairing form does
// not cancel the wait. Disposal is reserved for completion or app teardown.
export function watchPairingConnector({
  token,
  connectorId,
  onOnline,
  onUnavailable,
}: {
  token: string
  connectorId: string
  onOnline: (connector: ConnectorView) => void
  onUnavailable: (connectorId: string) => void
}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async () => {
    let connector: ConnectorView
    try {
      const response = await dashboardApi.getConnector(token, connectorId)
      connector = response.connector
    } catch (error) {
      if (stopped) return
      if (isApiError(error) && !isTransientHttpStatus(error.status) && error.status !== 409) {
        stopped = true
        onUnavailable(connectorId)
        return
      }
      timer = setTimeout(() => void tick(), 3000)
      return
    }
    if (stopped) return
    if (connector.status === "online") {
      stopped = true
      onOnline(connector)
      return
    }
    timer = setTimeout(() => void tick(), 2000)
  }

  timer = setTimeout(() => void tick(), 1500)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
