import { dashboardApi } from "@/features/dashboard/api"
import type { SessionCreateAndStartRequest } from "@/features/dashboard/types"
import { ApiError } from "@/lib/api/errors"
import { CAPABILITY, capabilityIsUsable, findCapability } from "./capabilities"
import { catalogItemEnabled, modelIdsForSelectionId, permissionIdForSelectionId } from "./catalog-selection"

export async function validateCreationRetry(token: string, request: SessionCreateAndStartRequest): Promise<void> {
  const runtimeId = request.runtimeId ?? request.runtime
  const { capabilitySet } = await dashboardApi.getConnectorRuntimeCapabilities(token, request.connectorId, runtimeId)
  const scope = { runtimeId, runtimeType: request.runtime }
  const invalid = () => { throw new ApiError({ status: 422, kind: "validation", code: "creation_configuration_required",
    detail: "Review the model, permissions and Agent mode before retrying. Your draft and attachments are retained." }) }
  const modelRequired = request.runtime === "dsh" || findCapability(capabilitySet, CAPABILITY.modelCatalog, scope)?.supported
  if (modelRequired || request.selections?.model) {
    if (!capabilityIsUsable(capabilitySet, CAPABILITY.modelCatalog, scope)) invalid()
    const { catalog } = await dashboardApi.getConnectorRuntimeModelCatalog(token, request.connectorId, runtimeId)
    if (!modelIdsForSelectionId(catalog, request.selections?.model)) invalid()
  }
  const permissionRequired = findCapability(capabilitySet, CAPABILITY.permissionCatalog, scope)?.supported
  if (permissionRequired || request.selections?.permission) {
    if (!capabilityIsUsable(capabilitySet, CAPABILITY.permissionCatalog, scope)) invalid()
    const { catalog } = await dashboardApi.getConnectorRuntimePermissionCatalog(token, request.connectorId, runtimeId)
    const id = permissionIdForSelectionId(catalog, request.selections?.permission)
    if (!catalog.permissions.some(item => item.id === id && catalogItemEnabled(item))) invalid()
  }
  if (request.runtime === "dsh") {
    const { runtimes } = await dashboardApi.getConnectorRuntimes(token, request.connectorId)
    const runtime = runtimes.find(item => item.runtimeId === runtimeId)
    const preset = request.runtimeOptions?.agentPreset
    const field = (runtime?.schema?.properties as Record<string, { enum?: unknown[] }> | undefined)?.defaultAgentPreset
    const ui = runtime?.uiSchema.defaultAgentPreset as { options?: { value: string; disabled?: boolean }[] } | undefined
    if (typeof preset !== "string" || !preset || !field?.enum?.includes(preset)
      || !ui?.options?.some(item => item.value === preset && !item.disabled)) invalid()
  }
}
