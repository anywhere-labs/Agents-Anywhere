"use client"

import type { ProtocolModelCatalog, ProtocolPermissionCatalog, ProtocolPermissionItem } from "@/features/dashboard/types"

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

export function permissionIdForRuntimeSettings(
  catalog: ProtocolPermissionCatalog | null,
  runtimeSettings: Record<string, unknown> | null | undefined,
): string {
  if (!catalog || !runtimeSettings) return ""
  const match = catalog.permissions.find((item) => runtimeSettingsMatchesPermission(runtimeSettings, item))
  return match?.id ?? ""
}

function runtimeSettingsMatchesPermission(
  runtimeSettings: Record<string, unknown>,
  permission: ProtocolPermissionItem,
): boolean {
  const expected = permissionRuntimeSettings(permission)
  if (Object.keys(expected).length === 0) {
    return typeof runtimeSettings.permissionMode === "string" && runtimeSettings.permissionMode === permission.id
  }
  return objectContains(runtimeSettings, expected)
}

function permissionRuntimeSettings(permission: ProtocolPermissionItem): Record<string, unknown> {
  const value = permission.metadata?.runtimeSettings
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function objectContains(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, expectedValue]) => valueMatches(actual[key], expectedValue))
}

function valueMatches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false
    return objectContains(actual as Record<string, unknown>, expected as Record<string, unknown>)
  }
  return actual === expected
}
