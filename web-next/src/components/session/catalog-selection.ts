"use client"

import type { ProtocolModelCatalog, ProtocolPermissionCatalog } from "@/features/dashboard/types"

export function modelSelectionIdForCatalog(
  catalog: ProtocolModelCatalog | null,
  modelId: string,
  reasoningId: string,
): string | null {
  if (!catalog || !modelId) return null
  const model = catalog.models.find((item) => item.id === modelId)
  if (!model) return null
  if (reasoningId) {
    return model.reasoningItems.find((item) => item.id === reasoningId)?.selectionId ?? null
  }
  return model.selectionId ?? model.reasoningItems.find((item) => item.default)?.selectionId ?? null
}

export function modelIdsForSelectionId(
  catalog: ProtocolModelCatalog | null,
  selectionId: string | null | undefined,
): { modelId: string; reasoningId: string } | null {
  if (!catalog || !selectionId) return null
  for (const model of catalog.models) {
    if (model.selectionId === selectionId) return { modelId: model.id, reasoningId: "" }
    const reasoning = model.reasoningItems.find((item) => item.selectionId === selectionId)
    if (reasoning) return { modelId: model.id, reasoningId: reasoning.id }
  }
  return null
}

export function permissionSelectionIdForCatalog(
  catalog: ProtocolPermissionCatalog | null,
  permissionId: string,
): string | null {
  if (!catalog || !permissionId) return null
  return catalog.permissions.find((item) => item.id === permissionId)?.selectionId ?? null
}

export function permissionIdForSelectionId(
  catalog: ProtocolPermissionCatalog | null,
  selectionId: string | null | undefined,
): string {
  if (!catalog || !selectionId) return ""
  return catalog.permissions.find((item) => item.selectionId === selectionId)?.id ?? ""
}
