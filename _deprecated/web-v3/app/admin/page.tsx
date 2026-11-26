"use client"

import Link from "next/link"
import { ArrowRightIcon, CloudIcon } from "lucide-react"

import { ActionList, ActionRow } from "@/components/console/action-list"
import { PageContainer, PageHeader } from "@/components/console/page-header"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { ADMIN_DRIVE } from "@/lib/admin/paths"

export default function AdminOverviewPage() {
  const { t } = useI18n()
  return (
    <PageContainer>
      <PageHeader title={t("admin.overview.title")} description={t("admin.overview.description")} />
      <ActionList className="border-t">
        <ActionRow
          icon={CloudIcon}
          title={t("admin.nav.drive")}
          description={t("admin.drive.description")}
          action={
            <Button variant="outline" size="sm" render={<Link href={ADMIN_DRIVE} />} nativeButton={false}>
              {t("admin.open")}
              <ArrowRightIcon className="size-3.5" />
            </Button>
          }
        />
      </ActionList>
    </PageContainer>
  )
}
