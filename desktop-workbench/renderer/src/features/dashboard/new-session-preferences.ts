const NEW_SESSION_PERMISSION_KEY = "aa-new-session-default-permission-v1";

export type NewSessionPreference = {
  connectorId: string
  agent: string
  selections?: Record<string, NewSessionSelectionPreference>
}

export type NewSessionSelectionPreference = {
  model?: string | null
  permission?: string | null
}

type NewSessionAvailableOption = {
  id: string
}

type NewSessionAvailableCatalogOption = NewSessionAvailableOption & {
  enabled: boolean
}

type NewSessionAvailableModelOption = NewSessionAvailableCatalogOption & {
  reasoningItems: readonly NewSessionAvailableCatalogOption[]
}

type NewSessionResolvedModelSelection = {
  modelId: string
  reasoningId: string
}

export type NewSessionAvailableSelectionPreference = {
  model: NewSessionResolvedModelSelection | null
  permissionId: string | null
}

export function preferredAvailableOptionId(
  options: readonly NewSessionAvailableOption[],
  currentId: string,
  preferredId: string | null | undefined,
): string {
  if (preferredId && options.some((option) => option.id === preferredId)) {
    return preferredId
  }
  if (currentId && options.some((option) => option.id === currentId)) {
    return currentId
  }
  return options[0]?.id ?? ""
}

export function availableNewSessionSelectionPreference(
  models: readonly NewSessionAvailableModelOption[],
  permissions: readonly NewSessionAvailableCatalogOption[],
  modelSelection: NewSessionResolvedModelSelection | null,
  permissionId: string,
): NewSessionAvailableSelectionPreference {
  const preferredModel = modelSelection
    ? models.find((option) => option.id === modelSelection.modelId && option.enabled)
    : undefined
  const preferredReasoningAvailable = preferredModel && (
    !modelSelection?.reasoningId || preferredModel.reasoningItems.some(
      (option) => option.id === modelSelection.reasoningId && option.enabled,
    )
  )
  const preferredPermission = permissionId
    ? permissions.find((option) => option.id === permissionId && option.enabled)
    : undefined

  return {
    model: preferredModel && preferredReasoningAvailable ? modelSelection : null,
    permissionId: preferredPermission?.id ?? null,
  }
}

export function withNewSessionSelectionPreference(
  current: NewSessionPreference | null,
  connectorId: string,
  agent: string,
  selection: NewSessionSelectionPreference,
): NewSessionPreference {
  const scope = newSessionSelectionScope(connectorId, agent)
  return {
    connectorId,
    agent,
    selections: {
      ...(current?.selections ?? {}),
      [scope]: {
        model: selection.model ?? null,
        permission: selection.permission ?? null,
      },
    },
  }
}

export function newSessionSelectionScope(connectorId: string, agent: string): string {
  return `${connectorId}:${agent}`
}

export function readNewSessionPermissionMode(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(NEW_SESSION_PERMISSION_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function writeNewSessionPermissionMode(value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NEW_SESSION_PERMISSION_KEY, value);
  } catch {
    // Ignore storage failures; the in-memory UI state still updates.
  }
}
