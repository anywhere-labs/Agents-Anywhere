"use client"

import { useState } from "react"
import { ChevronDown, Check, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"

interface SelectOption {
  id: string
  label: string
}

interface CascadingSelectorProps {
  icon?: React.ReactNode
  primaryOptions: SelectOption[]
  secondaryOptions: SelectOption[]
  selectedPrimary: string
  selectedSecondary: string
  onPrimaryChange: (id: string) => void
  onSecondaryChange: (id: string) => void
  secondaryLabel?: string
}

export function CascadingSelector({
  icon,
  primaryOptions,
  secondaryOptions,
  selectedPrimary,
  selectedSecondary,
  onPrimaryChange,
  onSecondaryChange,
  secondaryLabel = "Option",
}: CascadingSelectorProps) {
  const [open, setOpen] = useState(false)

  const primaryLabel = primaryOptions.find((opt) => opt.id === selectedPrimary)?.label ?? "Select"
  const secondaryValueLabel =
    secondaryOptions.find((opt) => opt.id === selectedSecondary)?.label ?? "None"

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
          {icon}
          <span className="text-foreground">{primaryLabel}</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-foreground">{secondaryValueLabel}</span>
          <ChevronDown className="size-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>

      {/* First level: only primary options. Hover expands submenu to the right. */}
      <DropdownMenuContent align="start" className="w-44">
        {primaryOptions.map((opt) => {
          const isSelected = selectedPrimary === opt.id
          return (
            <DropdownMenuSub key={opt.id}>
              {/*
                DropdownMenuSubTrigger opens the submenu on hover.
                Clicking it also selects this primary option (via onMouseDown so
                it fires before the menu close logic).
              */}
              <DropdownMenuSubTrigger
                className="flex cursor-pointer items-center gap-2"
                onPointerDown={() => {
                  onPrimaryChange(opt.id)
                }}
              >
                {isSelected ? (
                  <Check className="size-3.5 shrink-0" />
                ) : (
                  <span className="size-3.5 shrink-0" />
                )}
                <span className={isSelected ? "font-medium text-foreground" : ""}>
                  {opt.label}
                </span>
              </DropdownMenuSubTrigger>

              {/* Second level: secondary options, opens to the right */}
              <DropdownMenuSubContent className="w-40">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {secondaryLabel}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {secondaryOptions.map((sec) => {
                  const secSelected = isSelected && selectedSecondary === sec.id
                  return (
                    <DropdownMenuItem
                      key={sec.id}
                      className="flex items-center gap-2"
                      onSelect={() => {
                        onPrimaryChange(opt.id)
                        onSecondaryChange(sec.id)
                        setOpen(false)
                      }}
                    >
                      {secSelected ? (
                        <Check className="size-3.5 shrink-0" />
                      ) : (
                        <span className="size-3.5 shrink-0" />
                      )}
                      <span className={secSelected ? "font-medium text-foreground" : ""}>
                        {sec.label}
                      </span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
