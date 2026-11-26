"use client"

import { useCallback, useState } from "react"

/** An element's border-box width, kept current with a ResizeObserver (0 until it is measured). */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0)
  const ref = useCallback((node: T | null) => {
    if (!node) return
    setWidth(node.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}
