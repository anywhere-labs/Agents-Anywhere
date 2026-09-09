"use client"

import type { ReactNode } from "react"
import { ChevronLeft } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"

export function PageHeader({
  title,
  description,
  onBack,
  children,
}: {
  title: string
  description?: string
  onBack: () => void
  children?: ReactNode
}) {
  const tCommon = useTranslations("common")

  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft data-icon="inline-start" />
          {tCommon("back")}
        </Button>
        {children}
      </div>
    </header>
  )
}
