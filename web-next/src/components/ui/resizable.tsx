"use client"

import * as React from "react"
import {
  Group,
  Panel,
  Separator,
} from "react-resizable-panels"

import { cn } from '@/lib/utils'

function ResizablePanelGroup({
  className,
  direction,
  ...props
}: React.ComponentProps<typeof Group> & {
  direction?: "horizontal" | "vertical"
}) {
  return (
    <Group
      data-slot="resizable-panel-group"
      orientation={direction}
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ className, ...props }: React.ComponentProps<typeof Panel>) {
  return <Panel data-slot="resizable-panel" className={cn("min-w-0 min-h-0", className)} {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean
}) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        // Draw a 1px separator while keeping an invisible drag hit area.
        "relative flex w-px items-center justify-center bg-border ring-offset-background",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2",
        "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
        // v4 exposes handle orientation with aria-orientation.
        "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full",
        "aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-2 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2",
        "[&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-1.5 shrink-0 rounded-full bg-muted-foreground/30" />
      )}
    </Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
