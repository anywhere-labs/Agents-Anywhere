import { ChevronRight } from "lucide-react"
import { ViewTransition } from "react"

/** Transition type for links that go one level deeper (list -> editor / section). */
export const NAV_FORWARD = "nav-forward"
/** Transition type for links that return one level up (editor / section -> list). */
export const NAV_BACK = "nav-back"

/**
 * Transition type for moves that must not animate: links in the phone's
 * navigation drawer, where view transition snapshots would show the arriving
 * page through the closing drawer.
 */
export const NAV_STILL = "nav-still"

const directions = {
  [NAV_FORWARD]: NAV_FORWARD,
  [NAV_BACK]: NAV_BACK,
  [NAV_STILL]: "none",
  default: "none",
}

/**
 * Wraps a console frame or content area in React `<ViewTransition>`:
 * - `arrival="enter"`: fades the whole console up into view (`console-enter`).
 * - `arrival="rise"`: gently lifts each arriving page (`page-rise`).
 * - `NAV_FORWARD` / `NAV_BACK`: directional horizontal slide between sections.
 */
export function PageTransition({
  arrival,
  children,
}: {
  arrival?: "rise" | "enter"
  children: React.ReactNode
}) {
  return (
    <ViewTransition
      enter={
        arrival ? { ...directions, default: `nav-${arrival}` } : directions
      }
      exit={directions}
      default="none"
    >
      {children}
    </ViewTransition>
  )
}

function defaultNavLevel(path: string) {
  if (path === "/admin" || path.startsWith("/admin/")) return 2
  if (path.startsWith("/org/")) return 1
  return 0
}

export function sectionTransitionTypes(
  pathname: string,
  href: string,
  getLevel: (path: string) => number = defaultNavLevel
) {
  const from = getLevel(pathname)
  const to = getLevel(href)
  if (from === to) return []
  return [to > from ? NAV_FORWARD : NAV_BACK]
}

export function ForwardIndicator() {
  return <ChevronRight aria-hidden className="-ml-1 text-muted-foreground" />
}
