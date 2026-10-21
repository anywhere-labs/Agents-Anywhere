import { Archive, Laptop, Logs, Rocket, Smartphone, Sun, User } from "lucide-react"

export const settingsNavigation = [
  { id: "account", labelKey: "account", icon: User },
  { id: "appearance", labelKey: "appearance", icon: Sun },
  { id: "mobile-connections", labelKey: "mobileConnections", icon: Smartphone },
  { id: "desktop", labelKey: "desktop", icon: Laptop },
  { id: "startup", labelKey: "startup", icon: Rocket },
  { id: "logs", labelKey: "logs", icon: Logs },
  { id: "archived-sessions", labelKey: "archivedSessions", icon: Archive },
] as const

export type SettingsTab = (typeof settingsNavigation)[number]["id"]

export const DEFAULT_SETTINGS_TAB: SettingsTab = "account"

export function parseSettingsTab(value: string | undefined): SettingsTab {
  return settingsNavigation.find((item) => item.id === value)?.id ?? DEFAULT_SETTINGS_TAB
}
