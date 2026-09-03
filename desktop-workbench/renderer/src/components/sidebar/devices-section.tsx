"use client"

import { Plus } from "lucide-react"
import { DeviceSidebarItem } from "@/components/sidebar/device-sidebar-item"
import { SidebarLoadingItem } from "@/components/sidebar/sidebar-loading-item"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar"
import type { AppPage } from "@/components/workspace-context"
import type { ConnectorView } from "@/lib/demo-api"
import { useTranslations } from "next-intl"

type DevicesSectionProps = {
  connectors: ConnectorView[]
  isLoading: boolean
  page: AppPage
  activeConnectorId: string | null
  isLocalConnector: (connectorId: string) => boolean
  onOpenDevice: (connectorId: string) => void
  onPairDevice: () => void
}

export function DevicesSection({
  connectors,
  isLoading,
  page,
  activeConnectorId,
  isLocalConnector,
  onOpenDevice,
  onPairDevice,
}: DevicesSectionProps) {
  const t = useTranslations("dashboard")

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="flex items-center justify-between pr-1" role="heading" aria-level={2}>
        <span>{t("sections.devices")}</span>
        <button
          type="button"
          aria-label={t("actions.pairDevice")}
          onClick={onPairDevice}
          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {isLoading ? (
            <SidebarLoadingItem label={t("status.loadingDevices")} />
          ) : connectors.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">{t("empty.noDevicesShort")}</p>
          ) : (
            connectors.map((connector) => (
              <DeviceSidebarItem
                key={connector.id}
                connector={connector}
                isLocal={isLocalConnector(connector.id)}
                isActive={
                  (page === "device" || page === "device-workspace") &&
                  activeConnectorId === connector.id
                }
                onOpen={() => onOpenDevice(connector.id)}
              />
            ))
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
