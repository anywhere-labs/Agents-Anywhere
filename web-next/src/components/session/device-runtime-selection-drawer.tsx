"use client"

import * as React from "react"
import { Check, Monitor } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type { SelectionOption } from "@/components/session/selection-settings-drawer"

/**
 * New-session target picker: a device plus one of its runtime instances.
 *
 * Despite the "agent" label used for the second column in product copy, the
 * value here is a runtime instance id, not a runtime agent. The runtime agent
 * picker is `agent-selection-drawer.tsx`.
 */
export function DeviceRuntimeSelectionDrawer({
  disabled,
  buttonLabel,
  title,
  description,
  deviceLabel,
  runtimeLabel,
  deviceItems,
  selectedDevice,
  onDeviceChange,
  runtimeItems,
  selectedRuntime,
  onRuntimeChange,
}: {
  disabled?: boolean
  buttonLabel: string
  title: string
  description?: string
  deviceLabel: string
  runtimeLabel: string
  deviceItems: SelectionOption[]
  selectedDevice: string
  onDeviceChange: (id: string) => void
  runtimeItems: SelectionOption[]
  selectedRuntime: string
  onRuntimeChange: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Drawer open={open} onOpenChange={setOpen} direction="bottom">
      <DrawerTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          className="rounded-xl text-muted-foreground"
          aria-label={buttonLabel}
          title={buttonLabel}
        >
          <Monitor />
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
          {description ? <DrawerDescription>{description}</DrawerDescription> : null}
        </DrawerHeader>
        <div className="flex max-h-[58vh] flex-col gap-5 overflow-y-auto px-4 pb-4">
          <SelectionSection title={deviceLabel}>
            {deviceItems.map((item) => (
              <SelectionRow
                key={item.id}
                selected={selectedDevice === item.id}
                label={item.label}
                onClick={() => onDeviceChange(item.id)}
              />
            ))}
          </SelectionSection>

          {runtimeItems.length > 0 ? (
            <>
              <Separator />
              <SelectionSection title={runtimeLabel}>
                {runtimeItems.map((item) => (
                  <SelectionRow
                    key={item.id}
                    selected={selectedRuntime === item.id}
                    label={item.label}
                    onClick={() => {
                      onRuntimeChange(item.id)
                      setOpen(false)
                    }}
                  />
                ))}
              </SelectionSection>
            </>
          ) : null}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function SelectionSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-sm font-medium text-foreground">{title}</h3>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  )
}

function SelectionRow({
  selected,
  label,
  onClick,
}: {
  selected: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors",
        selected ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <Check className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
    </button>
  )
}
