"use client"

import { AlertCircle } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { runtimeErrorMessage } from "@/features/dashboard/runtime-instances"

export function RuntimeErrorBadge({ error }: { error: Record<string, unknown> | null }) {
  const t = useTranslations("dashboard.device")
  const message = runtimeErrorMessage(error)
  if (!error) return null

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="destructive"
            className="shrink-0"
            tabIndex={0}
            aria-label={`${t("runtimeIssue")}: ${message ?? t("runtimeUnknownError")}`}
          >
            <AlertCircle data-icon="inline-start" />
            {t("runtimeIssue")}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm">
          {message ?? t("runtimeUnknownError")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
