"use client"

import * as React from "react"
import { useTheme } from "next-themes"

import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"

export const WindowsTitleBarControlsContext = React.createContext<HTMLDivElement | null>(null)

export function WindowsTitleBarProvider({ children }: { children: React.ReactNode }) {
  const [controlsTarget, setControlsTarget] = React.useState<HTMLDivElement | null>(null)

  return (
    <WindowsTitleBarControlsContext.Provider value={controlsTarget}>
      <NativeWindowMaterial />
      <WindowsTitleBar onControlsMount={setControlsTarget} />
      {children}
    </WindowsTitleBarControlsContext.Provider>
  )
}

export function readTitleBarColors(element: HTMLElement) {
  const style = getComputedStyle(element)
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext("2d")
  if (!context) return null

  const toHex = (color: string) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    return "#" + Array.from(context.getImageData(0, 0, 1, 1).data)
      .slice(0, 3)
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")
  }

  return { color: toHex(style.backgroundColor), symbolColor: toHex(style.color) }
}

export function WindowsTitleBar({
  onControlsMount,
}: {
  onControlsMount?: React.RefCallback<HTMLDivElement>
} = {}) {
  const { resolvedTheme } = useTheme()
  const [enabled, setEnabled] = React.useState(false)
  const titleBarRef = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    const bridge = getDesktopWorkbenchBridge()
    if (bridge?.platform !== "win32" || !bridge.window) return
    document.documentElement.dataset.windowsTitleBar = "true"
    setEnabled(true)
    return () => { delete document.documentElement.dataset.windowsTitleBar }
  }, [])

  React.useEffect(() => {
    if (!enabled) return
    const frame = requestAnimationFrame(() => {
      if (!titleBarRef.current) return
      const colors = readTitleBarColors(titleBarRef.current)
      if (colors) {
        void getDesktopWorkbenchBridge()?.window?.setTitleBarColors(colors).catch(console.error)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [enabled, resolvedTheme])

  if (!enabled) return null

  return (
    <div ref={titleBarRef} className="aa-windows-title-bar aa-window-drag flex items-center bg-sidebar px-3 text-sidebar-foreground">
      <div
        ref={onControlsMount}
        data-slot="windows-title-bar-controls"
        className="flex min-w-0 items-center"
      />
    </div>
  )
}

function NativeWindowMaterial() {
  const { resolvedTheme } = useTheme()
  React.useLayoutEffect(() => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge) return
    const root = document.documentElement
    root.dataset.desktopPlatform = bridge.platform
    root.dataset.windowMaterial = bridge.windowMaterial ?? "opaque"
    return () => {
      delete root.dataset.desktopPlatform
      delete root.dataset.windowMaterial
    }
  }, [])
  React.useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return
    void getDesktopWorkbenchBridge()?.window?.setTheme?.(resolvedTheme).catch(console.error)
  }, [resolvedTheme])
  return null
}
