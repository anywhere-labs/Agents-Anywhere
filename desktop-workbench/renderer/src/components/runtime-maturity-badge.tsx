"use client"

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import type { RuntimeMaturity } from "@/features/dashboard/types"
import { maturityBadge } from "@/features/model-config/presentation"

/** Shown beside a runtime's status, never instead of it: "Pi Beta · 运行中". */
export function RuntimeMaturityBadge({ maturity, className }: { maturity: RuntimeMaturity | null | undefined; className?: string }) {
  const t = useTranslations("runtimeMaturity")
  const badge = maturityBadge(maturity)
  if (!badge) return null
  return (
    <Badge variant="outline" className={className} title={t(`${badge}Description`)}>
      {t(badge)}
    </Badge>
  )
}
