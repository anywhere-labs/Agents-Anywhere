"use client"

import * as React from "react"
import { Check, Settings2 } from "lucide-react"

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

export type SelectionOption = {
  id: string
  label: string
}

export type ModelSelectionOption = SelectionOption & {
  reasoningItems: SelectionOption[]
}

export function SelectionSettingsDrawer({
  disabled,
  buttonLabel,
  title,
  description,
  permissionLabel,
  modelLabel,
  reasoningLabel,
  permissionItems,
  selectedPermission,
  onPermissionChange,
  modelItems,
  selectedModel,
  selectedReasoning,
  onModelChange,
}: {
  disabled?: boolean
  buttonLabel: string
  title: string
  description?: string
  permissionLabel: string
  modelLabel: string
  reasoningLabel: string
  permissionItems: SelectionOption[]
  selectedPermission: string
  onPermissionChange: (id: string) => void
  modelItems: ModelSelectionOption[]
  selectedModel: string
  selectedReasoning: string
  onModelChange: (modelId: string, reasoningId: string) => void
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
          className="h-8 gap-1.5 rounded-xl px-2.5 text-muted-foreground"
        >
          <Settings2 className="size-3.5" />
          <span className="text-foreground">{buttonLabel}</span>
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
          {description ? <DrawerDescription>{description}</DrawerDescription> : null}
        </DrawerHeader>
        <div className="flex max-h-[58vh] flex-col gap-5 overflow-y-auto px-4 pb-4">
          {permissionItems.length > 0 ? (
            <SelectionSection title={permissionLabel}>
              {permissionItems.map((item) => (
                <SelectionRow
                  key={item.id}
                  selected={selectedPermission === item.id}
                  label={item.label}
                  onClick={() => {
                    onPermissionChange(item.id)
                    setOpen(false)
                  }}
                />
              ))}
            </SelectionSection>
          ) : null}

          {permissionItems.length > 0 && modelItems.length > 0 ? <Separator /> : null}

          {modelItems.length > 0 ? (
            <SelectionSection title={modelLabel}>
              {modelItems.map((model) => (
                <div key={model.id} className="flex flex-col gap-1">
                  {model.reasoningItems.length === 0 ? (
                    <SelectionRow
                      selected={selectedModel === model.id}
                      label={model.label}
                      onClick={() => {
                        onModelChange(model.id, "")
                        setOpen(false)
                      }}
                    />
                  ) : (
                    <>
                      <p className="px-3 pt-2 text-xs font-medium text-muted-foreground">{model.label}</p>
                      {model.reasoningItems.map((reasoning) => (
                        <SelectionRow
                          key={reasoning.id}
                          selected={selectedModel === model.id && selectedReasoning === reasoning.id}
                          label={`${reasoning.label} · ${model.label}`}
                          helper={reasoningLabel}
                          onClick={() => {
                            onModelChange(model.id, reasoning.id)
                            setOpen(false)
                          }}
                        />
                      ))}
                    </>
                  )}
                </div>
              ))}
            </SelectionSection>
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
  helper,
  onClick,
}: {
  selected: boolean
  label: string
  helper?: string
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
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {helper ? <span className="block truncate text-xs opacity-70">{helper}</span> : null}
      </span>
    </button>
  )
}
