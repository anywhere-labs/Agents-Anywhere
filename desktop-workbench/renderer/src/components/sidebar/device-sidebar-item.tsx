"use client"

import { Copy, FolderOpen } from "lucide-react"
import { toast } from "sonner"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

export function DeviceSidebarItem({
  connector,
  isLocal,
  isActive,
  onOpen,
}: {
  connector: { id: string; name: string; status: string }
  isLocal: boolean
  isActive: boolean
  onOpen: () => void
}) {
  const t = useTranslations("dashboard")
  const tCommon = useTranslations("common")

  const copyDeviceId = async () => {
    try {
      await copyText(connector.id)
      toast.success(t("actions.copiedDeviceId"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("actions.copyFailed"))
    }
  }

  return (
    <ContextMenu>
      <SidebarMenuItem>
        <ContextMenuTrigger asChild>
          <div>
            <SidebarMenuButton
              className="code-mono text-[13px]"
              isActive={isActive}
              onClick={onOpen}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  connector.status === "online" ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
              />
              <span
                className={cn(
                  "flex min-w-0 flex-1",
                  connector.status === "offline" && "text-muted-foreground",
                )}
              >
                <span className="min-w-0 truncate">{connector.name}</span>
                {isLocal ? (
                  <span className="shrink-0">{tCommon("localDeviceSuffix")}</span>
                ) : null}
              </span>
            </SidebarMenuButton>
          </div>
        </ContextMenuTrigger>
      </SidebarMenuItem>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onOpen}>
          <FolderOpen className="size-4" />
          {t("actions.open")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void copyDeviceId()}>
          <Copy className="size-4" />
          {t("actions.copyDeviceId")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

