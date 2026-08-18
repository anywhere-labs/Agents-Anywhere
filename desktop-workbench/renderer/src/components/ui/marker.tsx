"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const markerVariants = cva(
  "group/marker flex min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "rounded-md px-1 py-1 hover:text-foreground",
        border: "border-b border-border px-1 py-2 hover:text-foreground",
        separator:
          "justify-center gap-3 py-2 text-xs font-medium uppercase tracking-wide before:h-px before:min-w-8 before:flex-1 before:bg-border after:h-px after:min-w-8 after:flex-1 after:bg-border",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

function Marker({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof markerVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "div"

  return (
    <Comp
      data-slot="marker"
      data-variant={variant}
      className={cn(markerVariants({ variant, className }))}
      {...props}
    />
  )
}

function MarkerIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      data-slot="marker-icon"
      className={cn("flex shrink-0 items-center justify-center [&_svg]:size-4 [&_svg]:shrink-0", className)}
      {...props}
    />
  )
}

function MarkerContent({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="marker-content"
      className={cn("min-w-0 flex-1 truncate", className)}
      {...props}
    />
  )
}

export { Marker, MarkerContent, MarkerIcon, markerVariants }
