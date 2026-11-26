"use client"

// Dynamic route params that also work in the desktop static export.
//
// `AA_DESKTOP_EXPORT=1` builds each dynamic route once, for the placeholder param `_` (see the route's
// `layout.tsx`), and the desktop `app://` protocol serves that page for every concrete id. Next.js then
// reports the placeholder from `useParams()`, so in that build the params are read from the URL instead.

import { useParams, usePathname } from "next/navigation"
import { Fragment, type ReactNode } from "react"

import { desktopExport } from "@/lib/platform/export-params"

/** Match `pathname` against a pattern such as `/sessions/[deviceId]/[sessionId]`. */
export function matchRouteParams(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean)
  const have = pathname.split("/").filter(Boolean)
  if (want.length !== have.length) return null
  const out: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!
    const h = have[i]!
    const m = /^\[(.+)\]$/.exec(w)
    if (m) {
      try {
        out[m[1]!] = decodeURIComponent(h)
      } catch {
        out[m[1]!] = h
      }
    } else if (w !== h) {
      return null
    }
  }
  return out
}

export function useRouteParams<T extends Record<string, string>>(pattern: string): T {
  const params = useParams<T>()
  const pathname = usePathname()
  if (!desktopExport) return params
  return (matchRouteParams(pattern, pathname ?? "") as T | null) ?? params
}

/**
 * In the desktop export every id shares the placeholder segment, so Next.js would keep the page mounted when
 * navigating from one session to another. Key it by path to remount like the web build does.
 */
export function PathKeyed({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  if (!desktopExport) return children
  return <Fragment key={pathname}>{children}</Fragment>
}
