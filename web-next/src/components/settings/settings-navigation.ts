import { Archive, Smartphone, Sun, User } from "lucide-react"

export const settingsNavigation = [
  { id: "account", labelKey: "account", icon: User },
  { id: "appearance", labelKey: "appearance", icon: Sun },
  { id: "mobile-connections", labelKey: "mobileConnections", icon: Smartphone },
  { id: "archived-sessions", labelKey: "archivedSessions", icon: Archive },
] as const

export type SettingsTab = (typeof settingsNavigation)[number]["id"]

export const DEFAULT_SETTINGS_TAB: SettingsTab = "account"

export function parseSettingsTab(value: string | undefined): SettingsTab {
  return settingsNavigation.find((item) => item.id === value)?.id ?? DEFAULT_SETTINGS_TAB
}
