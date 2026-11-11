"use client"

import { useTranslations } from "next-intl"

import {
  parseSettingsTab,
  settingsNavigation,
  settingsNavigationGroups,
  type SettingsTab,
} from "@/components/settings/settings-navigation"
import { WorkspaceSectionSidebar } from "@/components/workspace-section-sidebar"
import { useWorkspace } from "@/components/workspace-context"

export function SettingsSidebar({ contained = false }: { contained?: boolean }) {
  const t = useTranslations("pages.settings")
  const { settingsTab, navigate } = useWorkspace()

  return (
    <WorkspaceSectionSidebar<SettingsTab>
      contained={contained}
      title={t("title")}
      activeId={parseSettingsTab(settingsTab)}
      onNavigate={(tab) => navigate("settings", tab)}
      groups={settingsNavigationGroups.map((group) => ({
        id: group,
        label: group === "models" ? t("modelsGroup") : undefined,
        items: settingsNavigation
          .filter((item) => item.group === group)
          .map((item) => ({ id: item.id, label: t(item.labelKey), icon: item.icon })),
      }))}
    />
  )
}
