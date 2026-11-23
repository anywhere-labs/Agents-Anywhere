"use client"

import { LockIcon, ShieldAlertIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Badge } from "@/components/ui/badge"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { isDesktopApp } from "@/lib/platform/desktop"
import { cn } from "@/lib/utils"

/**
 * Web E2EE Trust Badge (`docs/v3/e2ee-admission-proposal.md` §9.1):
 * Web browser always renders a calm **grey lock** (`text-muted-foreground`) explaining
 * that Noise_IK protects against passive interception/storage leaks while independent
 * native apps (iOS / Android / Desktop) provide green-lock verified distribution.
 */
export function E2eeLockBadge({
  paired,
  compact = false,
  className,
}: {
  paired: boolean
  compact?: boolean
  className?: string
}) {
  const { t } = useI18n()

  if (!paired) {
    return (
      <HoverCard>
        <HoverCardTrigger
          delay={120}
          closeDelay={100}
          render={
            <span
              className={cn(
                "inline-flex cursor-help items-center gap-1 text-warning",
                className
              )}
            />
          }
        >
          <ShieldAlertIcon className="size-3.5 shrink-0" />
          {!compact && (
            <Badge variant="outline" className="text-warning">
              {t("devices.unpaired")}
            </Badge>
          )}
        </HoverCardTrigger>
        <HoverCardContent align="start" className="w-72 space-y-1.5 text-xs">
          <p className="font-medium text-foreground">{t("devices.unpaired")}</p>
          <p className="text-muted-foreground leading-relaxed">{t("devices.unpairedHint")}</p>
        </HoverCardContent>
      </HoverCard>
    )
  }

  // The desktop app ships this UI in its own bundle (verified app): green lock. A browser: grey lock.
  const verified = isDesktopApp()
  const tone = verified ? "text-success" : "text-muted-foreground"
  const title = t(verified ? "devices.greenLockTitle" : "devices.greyLockTitle")

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={120}
        closeDelay={100}
        render={
          <span
            className={cn(
              "inline-flex cursor-help items-center gap-1",
              tone,
              className
            )}
          />
        }
      >
        <LockIcon className={cn("size-3.5 shrink-0", tone)} />
        {!compact && (
          <Badge variant="secondary" className={tone}>
            {title}
          </Badge>
        )}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 space-y-1.5 text-xs">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <LockIcon className={cn("size-3.5", tone)} />
          {title}
        </p>
        <p className="text-muted-foreground leading-relaxed">
          {t(verified ? "devices.greenLockDesc" : "devices.greyLockDesc")}
        </p>
      </HoverCardContent>
    </HoverCard>
  )
}
