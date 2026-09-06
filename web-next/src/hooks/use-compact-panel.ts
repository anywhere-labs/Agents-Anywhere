"use client"

import * as React from "react"

// Use the tool's available width, including when both sidebars are open.
export function useCompactPanel() {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const [compact, setCompact] = React.useState(false)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => setCompact(element.getBoundingClientRect().width < 480)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, compact }
}
