import { Archive, Boxes, Smartphone, Sun, User } from "lucide-react"

export const settingsNavigation = [
  { id: "account", labelKey: "account", icon: User, group: "general" },
  { id: "appearance", labelKey: "appearance", icon: Sun, group: "general" },
  { id: "mobile-connections", labelKey: "mobileConnections", icon: Smartphone, group: "general" },
  { id: "archived-sessions", labelKey: "archivedSessions", icon: Archive, group: "general" },
  { id: "model-configs", labelKey: "modelConfigsTitle", icon: Boxes, group: "models" },
] as const

// Sidebar groups, top to bottom. Only non-general groups get a heading; the
// sidebar title already names the general one.
export const settingsNavigationGroups = ["general", "models"] as const

export type SettingsTab = (typeof settingsNavigation)[number]["id"]

export const DEFAULT_SETTINGS_TAB: SettingsTab = "account"

export function parseSettingsTab(value: string | undefined): SettingsTab {
  if (value === "service-models" || value === "channel-switch") return "model-configs"
  return settingsNavigation.find((item) => item.id === value)?.id ?? DEFAULT_SETTINGS_TAB
}
