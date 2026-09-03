"use client"

import { Smartphone } from "lucide-react"
import { useTranslations } from "next-intl"

import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export function MobileConnectionsPage() {
  const t = useTranslations("dashboard.mobileConnections")

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 px-3">
        <DashboardSidebarToggle />
        <h1 className="text-sm font-semibold">{t("title")}</h1>
      </header>
      <main className="flex min-h-0 flex-1 items-center justify-center px-6 pb-14">
        <Empty className="max-w-lg border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Smartphone />
            </EmptyMedia>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    </div>
  )
}
