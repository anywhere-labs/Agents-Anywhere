"use client"

import * as React from "react"

export function useElementWidth<T extends HTMLElement>(ref: React.RefObject<T | null>) {
  const [width, setWidth] = React.useState(0)

  React.useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === "undefined") return

    const update = () => setWidth(element.getBoundingClientRect().width)
    update()
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      setWidth(entry?.contentRect.width ?? element.getBoundingClientRect().width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return width
}
