// Only UI preferences live in browser storage. The Connector owns the terminal
// inventory, processes and output; every restoration must query that inventory.
export type SessionTerminalPreference = {
  sessionId: string
  connectorId: string
  root: string
  open: boolean
  expanded: boolean
  preferredWidth: number | null
  activeTerminalId: string | null
}

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">

export function terminalPreferenceKey(server: string, userId: string) {
  return `aa-terminal-sidebar-v1:${JSON.stringify([server, userId])}`
}

export function readTerminalPreferences(
  storage: PreferenceStorage | null,
  key: string,
): SessionTerminalPreference[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? "null")
    if (!Array.isArray(value)) return []
    return value.filter((item): item is SessionTerminalPreference => (
      item !== null && typeof item === "object"
      && typeof item.sessionId === "string" && Boolean(item.sessionId)
      && typeof item.connectorId === "string" && Boolean(item.connectorId)
      && typeof item.root === "string" && Boolean(item.root)
      && typeof item.open === "boolean" && typeof item.expanded === "boolean"
      && (item.preferredWidth === null || (
        typeof item.preferredWidth === "number" && Number.isFinite(item.preferredWidth)
        && item.preferredWidth > 0 && item.preferredWidth <= 880
      ))
      && (item.activeTerminalId === null || typeof item.activeTerminalId === "string")
    )).slice(-100).map(({ sessionId, connectorId, root, open, expanded, preferredWidth, activeTerminalId }) => (
      { sessionId, connectorId, root, open, expanded, preferredWidth, activeTerminalId }
    ))
  } catch {
    return []
  }
}

export function writeTerminalPreferences(
  storage: PreferenceStorage | null,
  key: string,
  preferences: SessionTerminalPreference[],
) {
  try {
    storage?.setItem(key, JSON.stringify(preferences.slice(-100)))
  } catch {
    // Querying existing terminals still works when browser storage is disabled.
  }
}
