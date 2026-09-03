"use client"

import { ChevronDown, ChevronRight } from "lucide-react"

import { CollapsibleTrigger } from "@/components/ui/collapsible"

type SidebarSectionTriggerProps = {
  label: string
  expanded: boolean
}

export function SidebarSectionTrigger({
  label,
  expanded,
}: SidebarSectionTriggerProps) {
  return (
    <CollapsibleTrigger asChild>
      <button
        type="button"
        aria-expanded={expanded}
        className="flex min-w-0 items-center gap-1 rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <span>{label}</span>
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
    </CollapsibleTrigger>
  )
}
