"use client"

import type {
  ProtocolModelCatalog,
  ProtocolModelItem,
  ProtocolPermissionCatalog,
  ProtocolPermissionItem,
} from "@/features/dashboard/types"

const CUSTOM_PERMISSION_ID = "custom"

export function visiblePermissionItems(
  catalog: ProtocolPermissionCatalog | null | undefined,
): ProtocolPermissionItem[] {
  return catalog?.permissions.filter((item) => {
    const permissionId = item.id.trim().toLowerCase()
    const selectionId = item.selectionId.trim().toLowerCase()
    return permissionId !== CUSTOM_PERMISSION_ID &&
      selectionId !== CUSTOM_PERMISSION_ID &&
      !selectionId.endsWith(`:${CUSTOM_PERMISSION_ID}`)
  }) ?? []
}

export function catalogI18nText(
  translate: (key: string) => string,
  metadata: Record<string, unknown> | null | undefined,
  field: "labelKey" | "descriptionKey",
  fallback: string | null | undefined,
): string {
  const i18n = metadata?.i18n
  if (!isRecord(i18n)) return fallback ?? ""
  const rawKey = i18n[field]
  if (typeof rawKey !== "string" || !rawKey) return fallback ?? ""
  const key = rawKey.startsWith("dashboard.new.")
    ? rawKey.slice("dashboard.new.".length)
    : rawKey
  try {
    return translate(key)
  } catch {
    return fallback ?? ""
  }
}

export function modelCatalogDisplayName(
  item: ProtocolModelItem,
  models: readonly ProtocolModelItem[],
  label: string,
  defaultReasoningLabel: string,
): string {
  const provider = metadataString(item.metadata, "provider")
  const model = metadataString(item.metadata, "model")
  if (!provider || !model || item.metadata.reasoningEffort !== null) return label

  const hasExplicitReasoningVariant = models.some((candidate) =>
    metadataString(candidate.metadata, "provider") === provider &&
    metadataString(candidate.metadata, "model") === model &&
    typeof candidate.metadata.reasoningEffort === "string" &&
    candidate.metadata.reasoningEffort.length > 0,
  )
  if (!hasExplicitReasoningVariant || label.endsWith(` · ${defaultReasoningLabel}`)) return label
  return `${label} · ${defaultReasoningLabel}`
}

export function selectionIdForModelCatalog(
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

export function selectionIdForPermissionCatalog(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === "string" && value.length > 0 ? value : null
}
