"use client"

import * as React from "react"
import { Spinner } from "@/components/ui/spinner"

export function SessionPageTrigger({
  loading,
  label,
  onVisible,
}: {
  loading: boolean
  label: string
  onVisible: () => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const onVisibleRef = React.useRef(onVisible)
  onVisibleRef.current = onVisible

  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !loading) onVisibleRef.current()
      },
      { rootMargin: "160px 0px" },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [loading])

  return (
    <div ref={ref} className="flex h-9 items-center justify-center" aria-label={label}>
      {loading ? <Spinner className="size-4 text-muted-foreground" /> : null}
    </div>
  )
}
