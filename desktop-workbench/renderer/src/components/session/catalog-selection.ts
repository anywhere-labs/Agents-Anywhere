"use client"

import type {
  ProtocolModelCatalog,
  ProtocolModelItem,
  ProtocolPermissionCatalog,
  ProtocolPermissionItem,
  ProtocolReasoningItem,
} from "@/features/dashboard/types"

type CatalogItem = ProtocolModelItem | ProtocolPermissionItem | ProtocolReasoningItem

export function catalogItemEnabled(item: CatalogItem): boolean {
  if (typeof item.enabled === "boolean") return item.enabled
  return typeof item.metadata?.enabled === "boolean" ? item.metadata.enabled : true
}

export function catalogItemDisabledReason(item: CatalogItem): string | null {
  if (typeof item.disabledReason === "string" && item.disabledReason.trim()) {
    return item.disabledReason.trim()
  }
  const metadataReason = item.metadata?.disabledReason
  return typeof metadataReason === "string" && metadataReason.trim()
    ? metadataReason.trim()
    : null
}

const dshPermissionLabelKeys: Record<string, string> = {
  "read-only": "permissionModes.dsh.readOnly.label",
  "workspace-write": "permissionModes.dsh.workspaceWrite.label",
  "danger-full-access": "permissionModes.dsh.fullAccess.label",
}

export function catalogI18nText(
  translate: (key: string) => string,
  metadata: Record<string, unknown> | null | undefined,
  field: "labelKey" | "descriptionKey",
  fallback: string | null | undefined,
): string {
  const i18n = metadata?.i18n
  const preset = metadata?.preset
  const rawKey = (isRecord(i18n) ? i18n[field] : undefined)
    ?? (field === "labelKey" && typeof preset === "string" ? dshPermissionLabelKeys[preset] : undefined)
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

  const hasExplicitReasoningVariant = models.some(
    (candidate) =>
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
  if (!model || !catalogItemEnabled(model)) return null
  if (reasoningId) {
    const reasoning = model.reasoningItems.find((item) => item.id === reasoningId)
    return reasoning && catalogItemEnabled(reasoning) ? reasoning.selectionId : null
  }
  return model.selectionId
    ?? model.reasoningItems.find((item) => item.default && catalogItemEnabled(item))?.selectionId
    ?? null
}

export function modelIdsForSelectionId(
  catalog: ProtocolModelCatalog | null,
  selectionId: string | null | undefined,
  includeDisabled = false,
): { modelId: string; reasoningId: string } | null {
  if (!catalog || !selectionId) return null
  for (const model of catalog.models) {
    if (!includeDisabled && !catalogItemEnabled(model)) continue
    if (model.selectionId === selectionId) return { modelId: model.id, reasoningId: "" }
    const reasoning = model.reasoningItems.find(
      (item) => item.selectionId === selectionId && (includeDisabled || catalogItemEnabled(item)),
    )
    if (reasoning) return { modelId: model.id, reasoningId: reasoning.id }
  }
  return null
}

export function selectionIdForPermissionCatalog(
  catalog: ProtocolPermissionCatalog | null,
  permissionId: string,
): string | null {
  if (!catalog || !permissionId) return null
  return catalog.permissions.find(
    (item) => item.id === permissionId && catalogItemEnabled(item),
  )?.selectionId ?? null
}

export function permissionIdForSelectionId(
  catalog: ProtocolPermissionCatalog | null,
  selectionId: string | null | undefined,
  includeDisabled = false,
): string {
  if (!catalog || !selectionId) return ""
  return catalog.permissions.find(
    (item) => item.selectionId === selectionId && (includeDisabled || catalogItemEnabled(item)),
  )?.id ?? ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === "string" && value.length > 0 ? value : null
}
