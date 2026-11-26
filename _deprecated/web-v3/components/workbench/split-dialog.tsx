"use client"

// The large dialog settings use (设置, an agent's settings, a device's settings): its own section list on the left,
// the open section on the right with its title and a close button, an optional footer under the section (a save
// button). Phones get it full screen: the section list first, a section opens as its own page with a back button.
import type * as React from "react"
import { ArrowLeftIcon, ChevronRightIcon, XIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

export interface SplitSection<Id extends string> {
  id: Id
  label: string
  Icon: React.ComponentType<{ className?: string }>
}

export function SplitDialog<Id extends string>({
  open,
  onOpenChange,
  title,
  heading,
  description,
  sections,
  section,
  onSection,
  footer,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The dialog's name (above the section list; on phones the list page's title). */
  title: string
  /** Shown instead of the plain title above the section list (an agent's icon and name). */
  heading?: React.ReactNode
  /** For screen readers. */
  description: string
  sections: readonly SplitSection<Id>[]
  /** null: phones show the section list (wider screens the first section). */
  section: Id | null
  onSection: (section: Id | null) => void
  footer?: React.ReactNode
  /** The open section's content. */
  children: React.ReactNode
}) {
  const { t } = useI18n()
  const phone = useIsMobile()
  const shown = sections.find((s) => s.id === section) ?? sections[0]
  const showList = phone && section === null

  const nav = (
    <nav aria-label={title} className={cn("flex flex-col gap-0.5", phone ? "px-4 pt-4 pb-8" : "px-3 pb-4")}>
      {sections.map(({ id, label, Icon }) => {
        const current = !phone && shown?.id === id
        return (
          <button
            key={id}
            type="button"
            aria-current={current ? "page" : undefined}
            onClick={() => onSection(id)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-full text-left text-sm transition-colors",
              phone ? "h-12 px-3" : "h-9 px-3",
              current ? "bg-surface-hover font-medium text-foreground" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {phone && <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />}
          </button>
        )
      })}
    </nav>
  )

  const close = (
    <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label={t("common.close")} />}>
      <XIcon />
    </DialogClose>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "flex gap-0 overflow-hidden p-0",
          phone
            ? "top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none"
            : "h-[min(680px,calc(100dvh-4rem))] w-[calc(100%-3rem)] max-w-[56rem] sm:max-w-[56rem]"
        )}
      >
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {phone ? (
          <div className="flex min-w-0 flex-1 flex-col" style={{ paddingTop: "env(safe-area-inset-top)" }}>
            <header className="flex h-14 shrink-0 items-center gap-1 px-2">
              {showList ? (
                <DialogTitle className="min-w-0 flex-1 truncate px-2 text-base font-semibold">{heading ?? title}</DialogTitle>
              ) : (
                <>
                  <Button variant="ghost" size="icon-sm" aria-label={t("common.back")} onClick={() => onSection(null)}>
                    <ArrowLeftIcon />
                  </Button>
                  <DialogTitle className="flex-1 truncate text-base font-semibold">{shown?.label}</DialogTitle>
                </>
              )}
              {close}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {showList ? nav : <div className="px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">{children}</div>}
            </div>
            {!showList && footer && (
              <div className="shrink-0 border-t border-border px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>
            )}
          </div>
        ) : (
          <>
            <aside className="flex w-56 shrink-0 flex-col overflow-y-auto bg-card">
              <DialogTitle className="min-w-0 px-6 pt-6 pb-4 text-base font-semibold">{heading ?? title}</DialogTitle>
              {nav}
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex h-16 shrink-0 items-center gap-2 pr-4 pl-8">
                <h2 className="flex-1 truncate text-base font-semibold">{shown?.label}</h2>
                {close}
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                <div className="mx-auto w-full max-w-2xl px-8 pb-10">{children}</div>
              </div>
              {footer && <div className="shrink-0 border-t border-border px-8 py-3">{footer}</div>}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
