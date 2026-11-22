"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CircleAlertIcon,
  HomeIcon,
  KeyRoundIcon,
  LaptopIcon,
  LoaderCircleIcon,
  LockIcon,
  LogOutIcon,
  MessageSquarePlusIcon,
  MonitorIcon,
  PlusIcon,
  ServerIcon,
  SettingsIcon,
  SparklesIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react"

import { BrandWordmark } from "@/components/brand-wordmark"
import { UserAvatar } from "@/components/console/user-avatar"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { useAssistant } from "@/lib/state/assistant-context"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { DevicePlatform, SessionSummary } from "@/lib/types/v3"
import { cn } from "@/lib/utils"

const PLATFORM_ICON: Record<DevicePlatform, typeof LaptopIcon> = {
  macos: LaptopIcon,
  linux: ServerIcon,
  windows: MonitorIcon,
}

function SessionStatusDot({ state, unread }: { state: SessionSummary["state"]; unread: boolean }) {
  if (state === "running") {
    return <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
  }
  if (state === "waiting") {
    return <span className="size-2 rounded-full bg-warning" />
  }
  if (state === "error") {
    return <CircleAlertIcon className="size-3.5 text-destructive" />
  }
  if (unread) {
    return <span className="size-2 rounded-full bg-foreground" />
  }
  return null
}

export function WorkbenchSidebar({
  onOpenRegisterDevice,
  onOpenPairDevice,
}: {
  onOpenRegisterDevice: () => void
  onOpenPairDevice: () => void
}) {
  const { t } = useI18n()
  const pathname = usePathname()
  const router = useRouter()
  const {
    accounts,
    activeAccount,
    devices,
    deviceTrusts,
    sessions,
    preferences,
    switchAccount,
    signOutAccount,
    signOutAllAccounts,
  } = useWorkbench()
  const {
    conversations,
    activeConversationId,
    selectConversation,
    startNewConversation,
    deleteConversation,
    encryptionEnabled,
  } = useAssistant()

  // Assistant-first drill-down subpage state: clicking a work device flips sidebar into that device's view.
  const [drilledDeviceId, setDrilledDeviceId] = useState<string | null>(null)

  const drilledDevice = useMemo(
    () => (drilledDeviceId ? devices.find((d) => d.id === drilledDeviceId) ?? null : null),
    [devices, drilledDeviceId]
  )

  const pinnedSessions = useMemo(() => sessions.filter((s) => s.pinned), [sessions])
  const recentSessions = useMemo(
    () => sessions.filter((s) => !s.pinned).slice(0, 12),
    [sessions]
  )

  const renderSessionRow = (s: SessionSummary) => {
    const href = `/sessions/${encodeURIComponent(s.device_id)}/${encodeURIComponent(s.id)}`
    const isEncrypted =
      Boolean(deviceTrusts[s.device_id]) ||
      devices.find((d) => d.id === s.device_id)?.mode_hint === "encrypted"
    return (
      <SidebarMenuItem key={`${s.device_id}:${s.id}`}>
        <SidebarMenuButton
          isActive={pathname === href}
          render={<Link href={href} />}
          className="pr-8"
        >
          {isEncrypted && <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="truncate">{s.title || s.id}</span>
        </SidebarMenuButton>
        <SidebarMenuBadge>
          <SessionStatusDot state={s.state} unread={s.unread} />
        </SidebarMenuBadge>
      </SidebarMenuItem>
    )
  }

  return (
    <Sidebar collapsible="offcanvas">
      {/* Hover-free wordmark header (Anywhere UI rule) */}
      <SidebarHeader className="px-3 pt-4 pb-2">
        <Link
          href="/"
          onClick={() => setDrilledDeviceId(null)}
          className="inline-flex h-9 w-fit items-center rounded-md px-2 text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <BrandWordmark size="default" className="pointer-events-none" />
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {preferences.assistantPrimary ? (
          drilledDevice ? (
            /* Assistant-first mode: drilled into a specific work device sub-page */
            <>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton onClick={() => setDrilledDeviceId(null)}>
                        <ArrowLeftIcon />
                        <span>{t("shell.backToAssistantList")}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={pathname === `/devices/${encodeURIComponent(drilledDevice.id)}`}
                        render={<Link href={`/devices/${encodeURIComponent(drilledDevice.id)}`} />}
                      >
                        {(() => {
                          const Icon = PLATFORM_ICON[drilledDevice.platform] ?? LaptopIcon
                          return <Icon />
                        })()}
                        <span className="truncate font-medium">{drilledDevice.name}</span>
                        {(drilledDevice.mode_hint === "encrypted" ||
                          Boolean(deviceTrusts[drilledDevice.id])) && (
                          <LockIcon className="ml-auto size-3.5 text-muted-foreground" />
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>

              <SidebarGroup>
                <SidebarGroupLabel>{t("shell.navSessions")}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {sessions
                      .filter((s) => s.device_id === drilledDevice.id)
                      .map(renderSessionRow)}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          ) : (
            /* Assistant-first mode: Assistant conversations are primary in sidebar */
            <>
              <SidebarGroup>
                <SidebarGroupLabel>{t("assistant.title")}</SidebarGroupLabel>
                <SidebarGroupAction
                  title={t("assistant.newChat")}
                  onClick={async () => {
                    await startNewConversation()
                    router.push("/assistant")
                  }}
                >
                  <MessageSquarePlusIcon />
                </SidebarGroupAction>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {conversations.length === 0 ? (
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          onClick={async () => {
                            await startNewConversation()
                            router.push("/assistant")
                          }}
                        >
                          <SparklesIcon />
                          <span>{t("assistant.newChat")}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ) : (
                      conversations.slice(0, 20).map((conv) => (
                        <SidebarMenuItem key={conv.id}>
                          <SidebarMenuButton
                            isActive={
                              (pathname === "/" || pathname === "/assistant") &&
                              conv.id === activeConversationId
                            }
                            onClick={() => {
                              selectConversation(conv.id)
                              if (pathname !== "/" && pathname !== "/assistant") {
                                router.push("/assistant")
                              }
                            }}
                          >
                            {encryptionEnabled ? (
                              <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <span className="truncate">{conv.title}</span>
                          </SidebarMenuButton>
                          <SidebarMenuAction
                            showOnHover
                            aria-label={t("common.delete")}
                            onClick={() => void deleteConversation(conv.id)}
                          >
                            <Trash2Icon />
                          </SidebarMenuAction>
                        </SidebarMenuItem>
                      ))
                    )}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>

              <SidebarGroup>
                <SidebarGroupLabel>{t("shell.navDevices")}</SidebarGroupLabel>
                <SidebarGroupAction title={t("devices.register")} onClick={onOpenRegisterDevice}>
                  <PlusIcon />
                </SidebarGroupAction>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {devices.map((dev) => {
                      const Icon = PLATFORM_ICON[dev.platform] ?? LaptopIcon
                      const isEnc = dev.mode_hint === "encrypted" || Boolean(deviceTrusts[dev.id])
                      return (
                        <SidebarMenuItem key={dev.id}>
                          <SidebarMenuButton
                            onClick={() => setDrilledDeviceId(dev.id)}
                            className={cn(dev.presence === "offline" && "text-muted-foreground")}
                          >
                            <Icon />
                            <span className="truncate">{dev.name}</span>
                            {isEnc && <LockIcon className="size-3 text-muted-foreground" />}
                            <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground" />
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                    <SidebarMenuItem>
                      <SidebarMenuButton onClick={onOpenPairDevice}>
                        <KeyRoundIcon />
                        <span>{t("devices.pair")}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )
        ) : (
          /* Default Device-first mode */
          <>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive={pathname === "/"} render={<Link href="/" />}>
                      <HomeIcon />
                      <span>{t("shell.navHome")}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={pathname === "/assistant"}
                      render={<Link href="/assistant" />}
                    >
                      <SparklesIcon />
                      <span>{t("shell.navAssistant")}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            {pinnedSessions.length > 0 && (
              <SidebarGroup>
                <SidebarGroupLabel>{t("shell.navPinned")}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>{pinnedSessions.map(renderSessionRow)}</SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {recentSessions.length > 0 && (
              <SidebarGroup>
                <SidebarGroupLabel>{t("shell.navRecent")}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>{recentSessions.map(renderSessionRow)}</SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            <SidebarGroup>
              <SidebarGroupLabel>{t("shell.navDevices")}</SidebarGroupLabel>
              <SidebarGroupAction title={t("devices.register")} onClick={onOpenRegisterDevice}>
                <PlusIcon />
              </SidebarGroupAction>
              <SidebarGroupContent>
                <SidebarMenu>
                  {devices.map((dev) => {
                    const Icon = PLATFORM_ICON[dev.platform] ?? LaptopIcon
                    const href = `/devices/${encodeURIComponent(dev.id)}`
                    const isEnc = dev.mode_hint === "encrypted" || Boolean(deviceTrusts[dev.id])
                    return (
                      <SidebarMenuItem key={dev.id}>
                        <SidebarMenuButton
                          isActive={pathname === href}
                          render={<Link href={href} />}
                          className={cn("pr-14", dev.presence === "offline" && "text-muted-foreground")}
                        >
                          <Icon />
                          <span className="truncate">{dev.name}</span>
                          {isEnc && <LockIcon className="size-3 shrink-0 text-muted-foreground" />}
                        </SidebarMenuButton>
                        <SidebarMenuBadge>
                          <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                            <span
                              className={cn(
                                "size-1.5 rounded-full",
                                dev.presence === "online"
                                  ? "bg-success"
                                  : "bg-muted-foreground/40"
                              )}
                            />
                            {dev.presence === "online"
                              ? t("devices.online")
                              : t("devices.offline")}
                          </span>
                        </SidebarMenuBadge>
                      </SidebarMenuItem>
                    )
                  })}
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={onOpenPairDevice}>
                      <KeyRoundIcon />
                      <span>{t("devices.pair")}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}

        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === "/settings"}
                  render={<Link href="/settings" />}
                >
                  <SettingsIcon />
                  <span>{t("shell.navSettings")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Bottom Footer Account Switcher (Anywhere UI pattern) */}
      {activeAccount && (
        <SidebarFooter className="p-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2.5 rounded-full px-2.5 py-2 hover:bg-sidebar-accent"
                />
              }
            >
              <UserAvatar user={activeAccount.user} className="size-6 text-[10px]" />
              <div className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                <span className="truncate text-sm font-medium text-sidebar-foreground">
                  {activeAccount.user.display_name || activeAccount.user.email}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {activeAccount.user.email ?? activeAccount.user.id}
                </span>
              </div>
              <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("shell.accountsLabel")}</DropdownMenuLabel>
                {accounts.map((acct) => (
                  <DropdownMenuItem
                    key={acct.accountId}
                    onClick={() => void switchAccount(acct.accountId)}
                  >
                    <UserAvatar user={acct.user} className="size-7 text-xs" />
                    <div className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-sm">
                        {acct.user.display_name || acct.user.email}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {acct.user.email ?? acct.serverUrl}
                      </span>
                    </div>
                    {acct.accountId === activeAccount.accountId && (
                      <CheckIcon className="size-4 shrink-0" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push("/sign-in?add=1")}>
                <UserPlusIcon />
                <span>{t("shell.addAccount")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void signOutAccount()}>
                <LogOutIcon />
                <span>{t("shell.signOut")}</span>
              </DropdownMenuItem>
              {accounts.length > 1 && (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => void signOutAllAccounts()}
                >
                  <LogOutIcon />
                  <span>{t("shell.signOutAll")}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
      )}
      <SidebarRail />
    </Sidebar>
  )
}
