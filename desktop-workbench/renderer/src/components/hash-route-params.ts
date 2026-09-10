"use client"

import * as React from "react"

function searchFromHash(hash: string): string | null {
  const queryStart = hash.indexOf("?")
  if (queryStart < 0) return null
  return hash.slice(queryStart + 1)
}

export function useRouteSearchParams() {
  const [hash, setHash] = React.useState(() => (typeof window === "undefined" ? "" : window.location.hash))

  React.useEffect(() => {
    const handler = () => setHash(window.location.hash)
    window.addEventListener("hashchange", handler)
    return () => window.removeEventListener("hashchange", handler)
  }, [])

  return React.useMemo(() => {
    if (typeof window === "undefined") return new URLSearchParams()
    const hashSearch = searchFromHash(hash)
    return new URLSearchParams(hashSearch ?? window.location.search)
  }, [hash])
}
