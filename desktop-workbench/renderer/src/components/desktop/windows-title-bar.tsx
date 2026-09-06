"use client"

import * as React from "react"
import { useTheme } from "next-themes"

import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"
import appIcon from "../../../../build/icon-mac-source.png"

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

export function WindowsTitleBar() {
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
    <div ref={titleBarRef} className="aa-windows-title-bar aa-window-drag flex items-center gap-2 bg-sidebar px-3 text-xs text-sidebar-foreground">
      <img
        src={appIcon.src}
        alt=""
        className="size-4 shrink-0 object-contain"
        draggable={false}
      />
      <span className="truncate">Agents Anywhere</span>
    </div>
  )
}
