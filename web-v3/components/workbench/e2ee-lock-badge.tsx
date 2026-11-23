"use client"

import { LockIcon, ShieldAlertIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Badge } from "@/components/ui/badge"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
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

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={120}
        closeDelay={100}
        render={
          <span
            className={cn(
              "inline-flex cursor-help items-center gap-1 text-muted-foreground",
              className
            )}
          />
        }
      >
        <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
        {!compact && (
          <Badge variant="secondary" className="text-muted-foreground">
            {t("devices.greyLockTitle")}
          </Badge>
        )}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 space-y-1.5 text-xs">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <LockIcon className="size-3.5 text-muted-foreground" />
          {t("devices.greyLockTitle")}
        </p>
        <p className="text-muted-foreground leading-relaxed">{t("devices.greyLockDesc")}</p>
      </HoverCardContent>
    </HoverCard>
  )
}
