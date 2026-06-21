"use client"

import * as React from "react"
import { ChevronRight, Check } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { defaultFilter, type FilterValue, type SessionStatus } from "@/lib/api"
import { useWorkspace } from "@/components/workspace-context"

const statuses: { value: SessionStatus | "all"; label: string }[] = [
  { value: "all", label: "全部状态" },
  { value: "running", label: "运行中" },
  { value: "idle", label: "空闲" },
  { value: "waiting_approval", label: "等待审批" },
  { value: "error", label: "出错" },
]

export function SessionFilterMenu() {
  const { filter, setFilter, connectors, sessions } = useWorkspace()
  const [open, setOpen] = React.useState(false)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const active = filter.connectorId !== "all" || filter.runtime !== "all" || filter.status !== "all"

  const openNow = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const closeSoon = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 160)
  }

  const update = (patch: Partial<FilterValue>) => setFilter({ ...filter, ...patch })

  // Derive unique runtimes from sessions
  const runtimes = React.useMemo(
    () => Array.from(new Set(sessions.map((s) => s.runtime))).sort(),
    [sessions],
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="筛选会话"
          onClick={() => setOpen((o) => !o)}
          onMouseEnter={openNow}
          onMouseLeave={closeSoon}
          className={cn(
            "rounded-md p-0.5 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            active ? "text-foreground" : "text-sidebar-foreground/60",
          )}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="right"
        className="w-56 p-2"
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
      >
        <FilterSection
          label="设备"
          options={[
            { value: "all", label: "全部设备" },
            ...connectors.map((c) => ({ value: c.id, label: c.name })),
          ]}
          value={filter.connectorId}
          onSelect={(v) => update({ connectorId: v })}
        />
        <Separator className="my-1.5" />
        <FilterSection
          label="Agent"
          options={[
            { value: "all", label: "全部 Agent" },
            ...runtimes.map((r) => ({ value: r, label: r })),
          ]}
          value={filter.runtime}
          onSelect={(v) => update({ runtime: v })}
        />
        <Separator className="my-1.5" />
        <FilterSection
          label="状态"
          options={statuses}
          value={filter.status}
          onSelect={(v) => update({ status: v as SessionStatus | "all" })}
        />
        {active && (
          <>
            <Separator className="my-1.5" />
            <button
              type="button"
              onClick={() => setFilter(defaultFilter)}
              className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              清除筛选
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
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
    <div>
      <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{label}</div>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onSelect(opt.value)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
        >
          <Check className={cn("size-3.5 shrink-0", value === opt.value ? "opacity-100" : "opacity-0")} />
          <span className="truncate">{opt.label}</span>
        </button>
      ))}
    </div>
  )
}
