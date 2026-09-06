"use client"

import * as React from "react"
import { CheckCheck, MoreHorizontal } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { defaultFilter, type FilterValue } from "@/lib/demo-api"
import { useWorkspace } from "@/components/workspace-context"
import { useTranslations } from "next-intl"
import { runtimeLabel } from "@/components/session/session-utils"

export function SessionFilterMenu({
  onMarkAllRead,
}: {
  onMarkAllRead?: () => void | Promise<void>
}) {
  const { filter, setFilter, connectors, sessions } = useWorkspace()
  const t = useTranslations("dashboard")
  const [open, setOpen] = React.useState(false)

  const active = filter.connectorId !== "all" || filter.runtime !== "all"

  const update = (patch: Partial<FilterValue>) => setFilter({ ...filter, ...patch })

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
            "size-6 rounded-md p-0 transition-opacity",
            active || open
              ? "opacity-100 text-foreground"
              : "opacity-0 text-sidebar-foreground/60 group-hover/recent:opacity-100 group-focus-within/recent:opacity-100",
          )}
        >
          <MoreHorizontal />
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
            ...runtimes.map((runtime) => ({ value: runtime, label: runtimeLabel(runtime) })),
          ]}
          value={filter.runtime}
          onSelect={(v) => update({ runtime: v })}
        />
        {active || onMarkAllRead ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {onMarkAllRead ? (
                <DropdownMenuItem onSelect={() => void onMarkAllRead()}>
                  <CheckCheck />
                  {t("actions.markAllRead")}
                </DropdownMenuItem>
              ) : null}
              {active ? (
                <DropdownMenuItem onSelect={() => setFilter(defaultFilter)}>
                  {t("filters.clear")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
          </>
        ) : null}
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
