"use client"

import type * as React from "react"
import { PanelLeft, PanelRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function WorkspaceSidebarToggleButton({
  side,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children" | "variant" | "size" | "asChild"> & {
  side: "left" | "right"
}) {
  const Icon = side === "left" ? PanelLeft : PanelRight

  return (
    <Button
      type="button"
      {...props}
      variant="ghost"
      size="icon-sm"
      className={cn(
        "shrink-0 text-muted-foreground hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground hover:aria-expanded:bg-muted hover:aria-expanded:text-foreground",
        className,
      )}
    >
      <Icon />
    </Button>
  )
}
