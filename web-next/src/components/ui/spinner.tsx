import type * as React from "react"
import { cn } from '@/lib/utils'
import { RiLoaderLine } from "@remixicon/react"

type SpinnerProps = Omit<React.ComponentProps<"svg">, "children">;

function Spinner({ className, ...props }: SpinnerProps) {
  return (
    <RiLoaderLine data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
