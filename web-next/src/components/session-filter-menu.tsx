"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { defaultFilter, type FilterValue, type SessionStatus } from "@/lib/demo-api"
import { useWorkspace } from "@/components/workspace-context"
import { useTranslations } from "next-intl"

export function SessionFilterMenu() {
  const { filter, setFilter, connectors, sessions } = useWorkspace()
  const t = useTranslations("dashboard")
  const [open, setOpen] = React.useState(false)

  const active = filter.connectorId !== "all" || filter.runtime !== "all" || filter.status !== "all"

  const update = (patch: Partial<FilterValue>) => setFilter({ ...filter, ...patch })
  const statuses: { value: SessionStatus | "all"; label: string }[] = [
    { value: "all", label: t("filters.allStatus") },
    { value: "running", label: t("sessionStatus.running") },
    { value: "idle", label: t("sessionStatus.idle") },
    { value: "waiting_approval", label: t("sessionStatus.waiting_approval") },
    { value: "error", label: t("sessionStatus.error") },
  ]

  // Derive unique runtimes from sessions
  const runtimes = React.useMemo(
    () => Array.from(new Set(sessions.map((s) => s.runtime))).sort(),
    [sessions],
  )

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("actions.filter")}
          className={cn(
            "size-6 rounded-md p-0",
            active ? "text-foreground" : "text-sidebar-foreground/60",
          )}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="right"
        className="w-56"
      >
        <FilterSection
          label={t("filters.devices")}
          options={[
            { value: "all", label: t("filters.allDevices") },
            ...connectors.map((c) => ({ value: c.id, label: c.name })),
          ]}
          value={filter.connectorId}
          onSelect={(v) => update({ connectorId: v })}
        />
        <DropdownMenuSeparator />
        <FilterSection
          label={t("filters.agents")}
          options={[
            { value: "all", label: t("filters.allAgents") },
            ...runtimes.map((r) => ({ value: r, label: r })),
          ]}
          value={filter.runtime}
          onSelect={(v) => update({ runtime: v })}
        />
        <DropdownMenuSeparator />
        <FilterSection
          label={t("filters.status")}
          options={statuses}
          value={filter.status}
          onSelect={(v) => update({ status: v as SessionStatus | "all" })}
        />
        {active && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setFilter(defaultFilter)}>
              {t("filters.clear")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FilterSection({
  label,
  options,
  value,
  onSelect,
}: {
  label: string
  options: { value: string; label: string }[]
  value: string
  onSelect: (value: string) => void
}) {
  return (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground">{label}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={value} onValueChange={onSelect}>
      {options.map((opt) => (
        <DropdownMenuRadioItem
          key={opt.value}
          value={opt.value}
        >
          <span className="truncate">{opt.label}</span>
        </DropdownMenuRadioItem>
      ))}
      </DropdownMenuRadioGroup>
    </>
  )
}
