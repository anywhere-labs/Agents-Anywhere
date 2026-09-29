"use client"

import * as React from "react"
import { Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { cn } from "@/lib/utils"
import type { SelectionOption } from "@/components/session/selection-settings-drawer"

/**
 * Runtime agent picker (Build/Plan-style). The selected value is the catalog
 * agent id, which is what `session.updateSelections` sends as the `agent` key.
 *
 * This is not the new-session device/target picker — that one lives in
 * `device-runtime-selection-drawer.tsx`.
 */
export function AgentSelectionDrawer({
  disabled,
  buttonLabel,
  title,
  description,
  options,
  selectedAgent,
  onAgentChange,
}: {
  disabled?: boolean
  buttonLabel: string
  title: string
  description?: string
  options: SelectionOption[]
  selectedAgent: string
  onAgentChange: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Drawer open={open} onOpenChange={setOpen} direction="bottom">
      <DrawerTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-8 min-w-0 shrink gap-1.5 rounded-xl px-2.5 text-muted-foreground"
          aria-label={buttonLabel}
          title={buttonLabel}
        >
          <span className="min-w-0 max-w-40 truncate text-foreground">{buttonLabel}</span>
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
          {description ? <DrawerDescription>{description}</DrawerDescription> : null}
        </DrawerHeader>
        <div className="flex max-h-[58vh] flex-col gap-1 overflow-y-auto px-4 pb-4">
          {options.map((item) => (
            <SelectionRow
              key={item.id}
              selected={selectedAgent === item.id}
              label={item.label}
              helper={item.enabled === false ? item.disabledReason ?? undefined : item.description ?? undefined}
              disabled={disabled || item.enabled === false}
              onClick={() => {
                onAgentChange(item.id)
                setOpen(false)
              }}
            />
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function SelectionRow({
  selected,
  label,
  helper,
  disabled = false,
  onClick,
}: {
  selected: boolean
  label: string
  helper?: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors",
        selected ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
      )}
    >
      <Check className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {helper ? <span className="block truncate text-xs opacity-70">{helper}</span> : null}
      </span>
    </button>
  )
}
