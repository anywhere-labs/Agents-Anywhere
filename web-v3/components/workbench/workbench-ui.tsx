"use client"

import { createContext, useContext } from "react"

/** Shell-level actions any page or the sidebar can trigger (the ⌘K palette, device dialogs). */
export interface WorkbenchUi {
  openPalette: () => void
  openRegisterDevice: () => void
  openPairDevice: () => void
}

const noop = () => {}

export const WorkbenchUiContext = createContext<WorkbenchUi>({
  openPalette: noop,
  openRegisterDevice: noop,
  openPairDevice: noop,
})

export const useWorkbenchUi = () => useContext(WorkbenchUiContext)
