"use client"

import { useTranslations } from "next-intl"
import { useOptionalWorkspace } from "@/components/workspace-context"
import { channelRowFor, usesAnywhere } from "@/features/model-config/channel"

/** Mark the channel only once the runtime verifiably uses the Anywhere connection. */
export function AnywhereChannelIcon({ connectorId, runtimeId }: { connectorId: string; runtimeId: string }) {
  const workspace = useOptionalWorkspace()
  const t = useTranslations("pages.settings.modelConfigs.channel")
  const modelConfig = workspace?.modelConfig
  const row = channelRowFor(modelConfig?.channel, workspace?.runtimes ?? [], modelConfig?.assignments ?? [], { connectorId, runtimeId })
  if (!usesAnywhere(row)) return null

  return (
    <span className="inline-flex shrink-0 items-center" title={t("title")}>
      <img src="/icon.svg" width={16} height={16} className="size-4" alt={t("title")} />
    </span>
  )
}
