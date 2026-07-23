"use client"

import { AlertCircle, ChevronDown, KeyRound, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

export type AgentAuthMethod = {
  id: string
  name: string
}

type AgentAuthBannerProps = {
  agentName: string
  methods?: AgentAuthMethod[]
  hint?: string | null
  signingIn?: boolean
  disabled?: boolean
  className?: string
  compact?: boolean
  onSignIn: (methodId?: string) => void
}

/**
 * Compact ACP sign-in strip. Uses one primary action + optional method menu so
 * long method labels never blow out the conversation column.
 */
export function AgentAuthBanner({
  agentName,
  methods = [],
  hint,
  signingIn = false,
  disabled = false,
  className,
  compact = false,
  onSignIn,
}: AgentAuthBannerProps) {
  const t = useTranslations("dashboard.device")
  const tNew = useTranslations("dashboard.new")
  const busy = signingIn || disabled
  const multi = methods.length > 1
  const body = hint?.trim() || tNew("authRequiredBody")

  return (
    <div
      className={cn(
        "w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-amber-500/35 bg-amber-500/5",
        compact ? "px-3 py-2.5" : "px-3.5 py-3",
        className,
      )}
      role="status"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-amber-800 dark:text-amber-200">
              {tNew("authRequiredTitle", { name: agentName })}
            </p>
            <p className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
              {body}
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {multi ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 max-w-full gap-1.5"
                    disabled={busy}
                  >
                    {signingIn ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin" />
                    ) : (
                      <KeyRound className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">
                      {signingIn ? t("signingIn") : t("signInAgent")}
                    </span>
                    <ChevronDown className="size-3.5 shrink-0 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  // Override shared dropdown default w-(--radix-dropdown-menu-trigger-width)
                  // which clipped method labels to the narrow "Sign in" button width.
                  className="w-auto min-w-[16rem] max-w-[min(28rem,calc(100vw-2rem))]"
                >
                  {methods.map((method) => (
                    <DropdownMenuItem
                      key={method.id}
                      disabled={busy}
                      className="items-start gap-2 py-2"
                      onClick={() => onSignIn(method.id)}
                    >
                      <KeyRound className="mt-0.5 size-3.5 shrink-0 opacity-70" />
                      <span className="min-w-0 flex-1 whitespace-normal break-words text-left leading-snug">
                        {method.name?.trim() || method.id}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                type="button"
                size="sm"
                className="h-8 max-w-full gap-1.5"
                disabled={busy}
                onClick={() => onSignIn(methods[0]?.id)}
              >
                {signingIn ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                ) : (
                  <KeyRound className="size-3.5 shrink-0" />
                )}
                <span className="truncate">
                  {signingIn ? t("signingIn") : t("signInAgent")}
                </span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
