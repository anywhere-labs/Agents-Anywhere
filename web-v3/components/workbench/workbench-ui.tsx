"use client"

import { createContext, useContext } from "react"

import type { SettingsSection } from "@/components/workbench/settings-dialog"

/** Shell-level actions any page or the sidebar can trigger (the ⌘K palette, device dialogs, settings). */
export interface WorkbenchUi {
  openPalette: () => void
  openRegisterDevice: () => void
  openPairDevice: () => void
  openSettings: (section?: SettingsSection) => void
}

const noop = () => {}

export const WorkbenchUiContext = createContext<WorkbenchUi>({
  openPalette: noop,
  openRegisterDevice: noop,
  openPairDevice: noop,
  openSettings: noop,
})

export const useWorkbenchUi = () => useContext(WorkbenchUiContext)
