"use client"

// What stays on screen while the sidebar is folded away, as in ChatGPT and Claude.ai: a button to bring it back and
// one for a new conversation. `floating` pins it over the top-left of a page that has no top bar of its own (wide
// screens only; phones have their own bar); otherwise it sits inline in a page's top bar, where phones get the
// sidebar button only.
import Link from "next/link"
import { PanelLeftIcon, SquarePenIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { useSidebar } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isMacPlatform } from "@/components/workbench/shortcuts-dialog"
import { cn } from "@/lib/utils"

export function SidebarReopen({ floating = false }: { floating?: boolean }) {
  const { t } = useI18n()
  const { state, isMobile, toggleSidebar } = useSidebar()
  if (floating ? isMobile || state !== "collapsed" : !isMobile && state !== "collapsed") return null
  const mac = isMacPlatform()
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-0.5",
        floating && "absolute top-3 left-3 z-30 rounded-full bg-background/80 backdrop-blur",
        !isMobile && "animate-in fade-in duration-300 motion-reduce:animate-none"
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              data-sidebar="trigger"
              aria-label={isMobile ? t("shell.openNavigation") : t("shell.expandSidebar")}
              onClick={toggleSidebar}
            />
          }
        >
          <PanelLeftIcon className="size-4" />
        </TooltipTrigger>
        <TooltipContent>
          {t("shell.expandSidebar")} · {mac ? "⌘B" : "Ctrl+B"}
        </TooltipContent>
      </Tooltip>
      {!isMobile && (
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label={t("wb.newConversation")} render={<Link href="/new" />} nativeButton={false} />}
          >
            <SquarePenIcon className="size-4" />
          </TooltipTrigger>
          <TooltipContent>
            {t("wb.newConversation")} · {mac ? "⌘⇧O" : "Ctrl+Shift+O"}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
