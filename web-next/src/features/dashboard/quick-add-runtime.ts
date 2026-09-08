import { dashboardApi } from "@/features/dashboard/api"
import {
  reconfigurableRuntimeInstance,
  suggestedRuntimeInstanceName,
} from "@/features/dashboard/runtime-instances"
import type { DeviceRuntimeView, RuntimeTypeView } from "@/features/dashboard/types"

export async function quickAddRuntime({
  token,
  connectorId,
  runtimeType,
  onRuntimeUpdated,
}: {
  token: string
  connectorId: string
  runtimeType: RuntimeTypeView
  onRuntimeUpdated: (runtime: DeviceRuntimeView) => void
}): Promise<DeviceRuntimeView> {
  // A previous create may have persisted before startup failed. Read the current
  // inventory so retrying never creates a second instance from a stale dialog.
  const { runtimes } = await dashboardApi.getConnectorRuntimes(token, connectorId)
  const configured = runtimes.find((runtime) => (
    runtime.runtimeType === runtimeType.runtimeType && runtime.configured
  ))
  const existing = configured ?? reconfigurableRuntimeInstance(runtimeType, runtimes)
  if (!existing) {
    const created = await dashboardApi.createConnectorRuntime(token, connectorId, {
      runtimeType: runtimeType.runtimeType,
      name: suggestedRuntimeInstanceName({
        ...runtimeType,
        displayName: runtimeType.runtimeType === "dsh" ? "DSH" : runtimeType.displayName,
      }, runtimes),
      config: {},
      active: true,
    })
    onRuntimeUpdated(created)
    return created
  }

  if (existing.configured && existing.active && (existing.status === "running" || existing.status === "starting")) {
    onRuntimeUpdated(existing)
    return existing
  }
  if (!existing.configured) {
    const saved = await dashboardApi.putConnectorRuntimeConfig(token, connectorId, existing.runtimeId, {})
    onRuntimeUpdated(saved)
  }
  const started = await dashboardApi.setConnectorRuntimeActive(token, connectorId, existing.runtimeId, true)
  onRuntimeUpdated(started)
  return started
}
