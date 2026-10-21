"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

// Slightly longer than the slide so the fallback never cuts one short.
const SETTLE_FALLBACK_MS = 480

type Direction = "push" | "pop"

type Layer = {
  id: string
  depth: number
}

type Stack = {
  current: Layer
  leaving: Layer | null
  direction: Direction | null
}

/**
 * Slides between sidebars the way a carousel moves between pages: the two
 * sidebars sit next to each other on a track twice the sidebar's width and the
 * track glides one width, so nothing covers anything. A deeper sidebar comes
 * in from the right, a shallower one from the left. The leaving sidebar stays
 * mounted only for the ride and takes no input; the first sidebar mounts
 * without motion.
 */
export function SidebarSwitch({
  id,
  depth,
  children,
  className,
}: {
  id: string
  depth: number
  /** Renders the sidebar for a layer; called for the leaving layer too. */
  children: (id: string) => React.ReactNode
  className?: string
}) {
  const trackRef = React.useRef<HTMLDivElement | null>(null)
  const wasSlidingRef = React.useRef(false)
  const [stack, setStack] = React.useState<Stack>({
    current: { id, depth },
    leaving: null,
    direction: null,
  })

  if (stack.current.id !== id) {
    setStack({
      current: { id, depth },
      leaving: stack.current,
      direction: depth < stack.current.depth ? "pop" : "push",
    })
  }

  const { current, leaving, direction } = stack
  const sliding = leaving !== null
  // The shallower sidebar sits first on the track: a push moves the track left
  // to bring the deeper one in, a pop moves it back to the right.
  const panels = !leaving ? [current] : direction === "push" ? [leaving, current] : [current, leaving]
  const restingShift = sliding && direction === "push" ? -50 : 0

  const settle = React.useCallback(() => {
    setStack((state) => (state.leaving ? { ...state, leaving: null, direction: null } : state))
  }, [])

  React.useLayoutEffect(() => {
    const track = trackRef.current
    const wasSliding = wasSlidingRef.current
    wasSlidingRef.current = sliding
    if (!track || !sliding || wasSliding) return
    // Pin the track where the leaving sidebar is still in view with the
    // transition switched off: a child measuring itself in its own layout
    // effect may already have had the browser compute the committed resting
    // position, and the stray transition that starts from would swallow the
    // real one. Then hand the resting position to the transition. A slide
    // reversed midway is not restarted: React only changes the target and
    // the transition continues from wherever the track is.
    const start = restingShift === 0 ? -50 : 0
    track.style.transition = "none"
    track.style.transform = `translateX(${start}%)`
    void track.getBoundingClientRect()
    track.style.transition = ""
    track.style.transform = `translateX(${restingShift}%)`
  }, [sliding, restingShift])

  React.useEffect(() => {
    if (!sliding) return
    const timer = window.setTimeout(settle, SETTLE_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [stack, sliding, settle])

  return (
    <div className={cn("relative h-full min-h-0 overflow-hidden", className)}>
      <div
        ref={trackRef}
        data-slot="sidebar-track"
        data-state={sliding ? "sliding" : "idle"}
        className={cn(
          "flex h-full",
          sliding
            ? "w-[200%] will-change-transform transition-transform duration-400 ease-[cubic-bezier(0.05,0.7,0.1,1)]"
            : "w-full"
        )}
        style={sliding ? { transform: `translateX(${restingShift}%)` } : undefined}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "transform") settle()
        }}
      >
        {panels.map((panel) => {
          const isLeaving = panel.id === leaving?.id
          return (
            <div
              key={panel.id}
              data-slot="sidebar-layer"
              data-state={isLeaving ? "leaving" : "current"}
              aria-hidden={isLeaving || undefined}
              className={cn(
                "h-full min-w-0 shrink-0",
                sliding ? "w-1/2" : "w-full",
                isLeaving && "pointer-events-none"
              )}
            >
              {children(panel.id)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
