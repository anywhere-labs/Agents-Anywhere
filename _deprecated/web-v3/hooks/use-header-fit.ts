"use client"

// A one-line header that gives way in order. When the title (with what sits beside it) and the actions do not fit
// side by side, `compact` turns true and the caller shows its main action as an icon only; past that the title is
// truncated by CSS. Both sides are measured as if nothing were compacted or truncated (the title's hidden overflow is
// added back, the main action's full width is remembered), so the answer does not flip back and forth.
import { useLayoutEffect, useRef, useState } from "react"

export function useHeaderFit(contentKey: string) {
  const containerRef = useRef<HTMLDivElement>(null)
  /** The title group: content-sized (no flex-grow), its truncating name inside. */
  const titleRef = useRef<HTMLDivElement>(null)
  /** The element that truncates (overflow hidden, ellipsis). */
  const nameRef = useRef<HTMLElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  /** The action that gives way first. */
  const mainActionRef = useRef<HTMLElement>(null)
  const [compact, setCompact] = useState(false)
  const compactRef = useRef(false)
  const fullActionWidth = useRef(0)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const title = titleRef.current
      const actions = actionsRef.current
      const main = mainActionRef.current
      if (!title || !actions || !main) return
      if (!compactRef.current) fullActionWidth.current = main.offsetWidth
      const name = nameRef.current
      const hidden = name ? Math.max(0, name.scrollWidth - name.clientWidth) : 0
      const gap = parseFloat(getComputedStyle(container).columnGap) || 0
      const need = title.offsetWidth + hidden + gap + actions.offsetWidth - main.offsetWidth + fullActionWidth.current
      const next = need > container.clientWidth + 0.5
      if (next !== compactRef.current) {
        compactRef.current = next
        setCompact(next)
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    if (titleRef.current) observer.observe(titleRef.current)
    let alive = true
    void document.fonts?.ready.then(() => {
      if (alive) measure()
    })
    return () => {
      alive = false
      observer.disconnect()
    }
  }, [contentKey])

  return { containerRef, titleRef, nameRef, actionsRef, mainActionRef, compact }
}
