"use client"

import { useCallback, useState } from "react"

/**
 * A side panel's width: dragged by its edge, kept in this browser (it is about the screen, not the account).
 * `max` is read when the width is set; callers that know the room actually left pass a smaller cap at render.
 */
export interface PanelWidthSpec {
  /** localStorage key */
  key: string
  initial: number
  min: number
  /** The widest it may be for the current window. */
  max: () => number
}

export function clampWidth(spec: PanelWidthSpec, width: number, cap = Infinity) {
  const max = Math.max(spec.min, Math.min(spec.max(), cap))
  return Math.round(Math.min(max, Math.max(spec.min, width)))
}

function stored(spec: PanelWidthSpec) {
  if (typeof window === "undefined") return spec.initial
  try {
    const n = Number(window.localStorage.getItem(spec.key))
    return n > 0 ? clampWidth(spec, n) : spec.initial
  } catch {
    return spec.initial
  }
}

/** Specs must be module constants: the callbacks depend on them. */
export function usePanelWidth(spec: PanelWidthSpec) {
  const [width, setWidth] = useState(() => stored(spec))
  /** While dragging: follow the pointer without saving. */
  const preview = useCallback((w: number) => setWidth(clampWidth(spec, w)), [spec])
  const commit = useCallback(
    (w: number) => {
      const next = clampWidth(spec, w)
      setWidth(next)
      try {
        window.localStorage.setItem(spec.key, String(next))
      } catch {
        // Private mode and the like: the width just is not remembered.
      }
    },
    [spec]
  )
  const reset = useCallback(() => {
    setWidth(spec.initial)
    try {
      window.localStorage.removeItem(spec.key)
    } catch {
      // as above
    }
  }, [spec])
  return { width, preview, commit, reset }
}
