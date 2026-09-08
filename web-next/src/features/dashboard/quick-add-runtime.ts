import { dashboardApi } from "@/features/dashboard/api"
import {
  reconfigurableRuntimeInstance,
  runtimeInstanceName,
  suggestedRuntimeInstanceName,
} from "@/features/dashboard/runtime-instances"
import type { DeviceRuntimeView, RuntimeTypeView } from "@/features/dashboard/types"

export async function quickAddRuntime({
  token,
  connectorId,
  runtimeType,
  name,
  config,
  runtimeId,
  onRuntimeUpdated,
}: {
  token: string
  connectorId: string
  runtimeType: RuntimeTypeView
  name?: string
  config?: Record<string, unknown>
  runtimeId?: string
  onRuntimeUpdated: (runtime: DeviceRuntimeView) => void
}): Promise<DeviceRuntimeView> {
  // A previous create may have persisted before startup failed. Read the current
  // inventory so retrying never creates a second instance from a stale dialog.
  const { runtimes } = await dashboardApi.getConnectorRuntimes(token, connectorId)
  const configured = runtimes.find((runtime) => (
    runtime.runtimeType === runtimeType.runtimeType && runtime.configured
      && (!name || runtimeInstanceName(runtime).toLocaleLowerCase() === name.toLocaleLowerCase())
  ))
  let existing = runtimeId
    ? runtimes.find((runtime) => runtime.runtimeId === runtimeId && runtime.runtimeType === runtimeType.runtimeType)
    : configured ?? reconfigurableRuntimeInstance(runtimeType, runtimes)
  if (runtimeId && !existing) throw new Error("Runtime instance no longer exists.")
  if (!existing) {
    const requestedName = name ?? suggestedRuntimeInstanceName(runtimeType, runtimes)
    try {
      const created = await dashboardApi.createConnectorRuntime(token, connectorId, {
        runtimeType: runtimeType.runtimeType,
        name: requestedName,
        config: config ?? {},
        active: true,
      })
      onRuntimeUpdated(created)
      return created
    } catch (error) {
      // Creation can persist before startup fails. Keep its identity even if the
      // user edits the name or chooses custom configuration before retrying.
      try {
        const current = await dashboardApi.getConnectorRuntimes(token, connectorId)
        const persisted = current.runtimes.find((runtime) => (
          runtime.runtimeType === runtimeType.runtimeType
            && runtimeInstanceName(runtime).toLocaleLowerCase() === requestedName.toLocaleLowerCase()
        ))
        if (persisted) onRuntimeUpdated(persisted)
      } catch {
        // Preserve the original error when the inventory refresh also fails.
      }
      throw error
    }
  }

  if (name && name !== runtimeInstanceName(existing)) {
    existing = await dashboardApi.renameConnectorRuntime(token, connectorId, existing.runtimeId, name)
    onRuntimeUpdated(existing)
  }
  if (config === undefined && existing.configured && existing.active && (existing.status === "running" || existing.status === "starting")) {
    onRuntimeUpdated(existing)
    return existing
  }
  if (!existing.configured || config !== undefined) {
    const saved = await dashboardApi.putConnectorRuntimeConfig(token, connectorId, existing.runtimeId, config ?? {})
    onRuntimeUpdated(saved)
  }
  const started = await dashboardApi.setConnectorRuntimeActive(token, connectorId, existing.runtimeId, true)
  onRuntimeUpdated(started)
  return started
}
