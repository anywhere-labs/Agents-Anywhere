"use client"

import type { LucideIcon } from "lucide-react"
import { ExternalLink, RotateCw, X } from "lucide-react"


type PanelHeaderProps = {
  icon: LucideIcon
  title: string
  trailing?: React.ReactNode
  onDetach?: () => void
  onRefresh?: () => void
  onClose?: () => void
  collapsed?: boolean
}

export function PanelHeader({
  icon: Icon,
  title,
  trailing,
  onDetach,
  onRefresh,
  onClose,
}: PanelHeaderProps) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
      <Icon className="size-4 text-muted-foreground" />
      <span className="text-sm font-medium">{title}</span>
      {trailing}
      <div className="ml-auto flex items-center gap-0.5 text-muted-foreground">
        {onDetach ? (
          <PanelButton label="分离到独立窗口" onClick={onDetach}>
            <ExternalLink className="size-3.5" />
          </PanelButton>
        ) : null}
        {onRefresh ? (
          <PanelButton label="刷新" onClick={onRefresh}>
            <RotateCw className="size-3.5" />
          </PanelButton>
        ) : null}
        {onClose ? (
          <PanelButton label="关闭" onClick={onClose}>
            <X className="size-3.5" />
          </PanelButton>
        ) : null}
      </div>
    </div>
  )
}

function PanelButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="rounded-md p-1.5 transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}
