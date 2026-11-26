"use client"

import { Search } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * A debounced pill search box that reports trimmed text shortly after typing
 * pauses, keeping list queries calm.
 */
export function SearchInput({
  onSearch,
  placeholder,
  label,
  defaultValue = "",
  delay = 300,
  className,
}: {
  onSearch: (value: string) => void
  placeholder: string
  label: string
  defaultValue?: string
  delay?: number
  className?: string
}) {
  const [value, setValue] = useState(defaultValue)
  const onSearchRef = useRef(onSearch)
  useEffect(() => {
    onSearchRef.current = onSearch
  })
  const lastSent = useRef(defaultValue.trim())

  useEffect(() => {
    const next = value.trim()
    if (next === lastSent.current) return
    const timer = window.setTimeout(() => {
      lastSent.current = next
      onSearchRef.current(next)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])

  return (
    <div className={cn("relative w-full sm:w-72", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="pl-9"
      />
    </div>
  )
}
