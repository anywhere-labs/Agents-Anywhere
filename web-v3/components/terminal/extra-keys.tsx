"use client"

import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon } from "lucide-react"
import type { ReactNode } from "react"

import { useI18n } from "@/components/i18n-provider"
import { cn } from "@/lib/utils"
import { EXTRA_KEY_ROW, type ExtraKey } from "@/lib/terminal/keys"
import type { MessageKey } from "@/lib/i18n"

const LABEL_KEY: Record<ExtraKey | "ctrl", MessageKey> = {
  escape: "terminal.keyEscape",
  ctrl: "terminal.keyCtrl",
  tab: "terminal.keyTab",
  up: "terminal.keyUp",
  down: "terminal.keyDown",
  left: "terminal.keyLeft",
  right: "terminal.keyRight",
  home: "terminal.keyHome",
  end: "terminal.keyEnd",
  pageUp: "terminal.keyPageUp",
  pageDown: "terminal.keyPageDown",
}

const ICON: Partial<Record<ExtraKey, ReactNode>> = {
  up: <ArrowUpIcon className="size-3.5" />,
  down: <ArrowDownIcon className="size-3.5" />,
  left: <ArrowLeftIcon className="size-3.5" />,
  right: <ArrowRightIcon className="size-3.5" />,
}

/**
 * On-screen Esc / Ctrl / Tab / arrows / PgUp / PgDn / Home / End for touch devices. Keys never take focus away
 * from the terminal (so the soft keyboard stays up); the key → bytes mapping lives in `lib/terminal/keys.ts`.
 */
export function TerminalExtraKeys({
  disabled,
  ctrlActive,
  onToggleCtrl,
  onKey,
}: {
  disabled: boolean
  ctrlActive: boolean
  onToggleCtrl: () => void
  onKey: (key: ExtraKey) => void
}) {
  const { t } = useI18n()
  return (
    <div
      role="toolbar"
      aria-label={t("terminal.extraKeys")}
      className="flex gap-1 overflow-x-auto scrollbar-thin px-1 py-1.5"
    >
      {EXTRA_KEY_ROW.map((key) => {
        const label = t(LABEL_KEY[key])
        const active = key === "ctrl" && ctrlActive
        return (
          <button
            key={key}
            type="button"
            disabled={disabled}
            aria-label={label}
            aria-pressed={key === "ctrl" ? ctrlActive : undefined}
            // Keep focus (and the soft keyboard) on the terminal.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (key === "ctrl" ? onToggleCtrl() : onKey(key))}
            className={cn(
              "flex h-8 min-w-10 shrink-0 items-center justify-center rounded-lg px-2.5 text-xs font-medium tabular-nums transition-colors select-none",
              "bg-secondary text-foreground hover:bg-surface-hover disabled:opacity-40",
              active && "bg-foreground text-background hover:bg-foreground"
            )}
          >
            {key !== "ctrl" && ICON[key] ? ICON[key] : label}
          </button>
        )
      })}
    </div>
  )
}
