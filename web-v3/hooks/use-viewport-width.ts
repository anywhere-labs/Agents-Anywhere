import * as React from "react"

/** The window's inner width, kept current (1280 while prerendering). */
export function useViewportWidth(): number {
  return React.useSyncExternalStore(
    (onChange) => {
      window.addEventListener("resize", onChange)
      return () => window.removeEventListener("resize", onChange)
    },
    () => window.innerWidth,
    () => 1280
  )
}
