"use client"

import { startTransition, useEffect, useState } from "react"

/**
 * Turns true inside `startTransition` the first time `ready` becomes true,
 * allowing a newly mounted console shell's `<ViewTransition>` (`console-enter`)
 * to animate into view after an async session check resolves.
 */
export function useRevealInTransition(ready: boolean) {
  const [revealed, setRevealed] = useState(ready)
  useEffect(() => {
    if (ready && !revealed) startTransition(() => setRevealed(true))
  }, [ready, revealed])
  return revealed
}
