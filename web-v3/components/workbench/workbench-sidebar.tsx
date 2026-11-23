"use client"

// The workbench sidebar (docs/v3/client-experience-proposal.md §2.1 / §2.2).
//
// Device-first (default): New conversation and Orches, Devices (one line each, with presence and lock), Pinned, then
// Recent across devices. The header folds the sidebar away (⌘B); its right edge is dragged to resize it.
//
// Assistant-first: Orches' conversations are the main list, devices below; picking a device flips the sidebar to
// that device's page (back button, its conversations, a new conversation on it).
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CircleAlertIcon,
  CloudIcon,
  CopyIcon,
  EllipsisIcon,
  KeyRoundIcon,
  LaptopIcon,
  LoaderCircleIcon,
  LockIcon,
  LogOutIcon,
  PanelLeftIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SquarePenIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react"
import { toast } from "sonner"

import { BrandWordmark } from "@/components/brand-wordmark"
import { UserAvatar } from "@/components/console/user-avatar"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
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
  useSidebar,
} from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isMacPlatform } from "@/components/workbench/shortcuts-dialog"
import { useWorkbenchUi } from "@/components/workbench/workbench-ui"
import { OrchesIcon } from "@/components/workbench/orches-icon"
import { DeviceStatusIcon } from "@/components/workbench/device-status"
import { ResizeHandle } from "@/components/workbench/resize-handle"
import { useAssistant } from "@/lib/state/assistant-context"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { DeviceRecord, SessionSummary } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { toggleIn, useLocalPrefs } from "@/lib/workbench/local-prefs"
import { shortAgo } from "@/lib/workbench/time"
import { agentLabel, deviceHref, sessionHref, sessionKey } from "@/lib/workbench/tree"

const RECENT_LIMIT = 40

function SessionStatus({ state, unread }: { state: SessionSummary["state"]; unread: boolean }) {
  if (state === "running") return <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
  if (state === "waiting") return <span className="size-2 rounded-full bg-warning" />
  if (state === "error") return <CircleAlertIcon className="size-3.5 text-destructive" />
  if (unread) return <span className="size-2 rounded-full bg-foreground" />
  return null
}

/** The sidebar's width, owned by the shell (it sets `--sidebar-width` on the sidebar's wrapper). */
export interface SidebarResize {
  width: number
  min: number
  max: number
  preview: (width: number) => void
  commit: (width: number) => void
  reset: () => void
  onResizing: (resizing: boolean) => void
}

export function WorkbenchSidebar({ resize }: { resize: SidebarResize }) {
  const { t, locale } = useI18n()
  const pathname = usePathname()
  const router = useRouter()
  const { isMobile, setOpenMobile, state: sidebarState, toggleSidebar } = useSidebar()
  const { openPalette, openRegisterDevice, openPairDevice, openSettings } = useWorkbenchUi()
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
    tunnelManager,
    refreshSessions,
  } = useWorkbench()
  const [renaming, setRenaming] = useState<{ session: SessionSummary; title: string } | null>(null)
  const {
    conversations,
    activeConversationId,
    selectConversation,
    startNewConversation,
    deleteConversation,
    encryptionEnabled,
    drawerOpen,
    setDrawerOpen,
  } = useAssistant()
  const [prefs, setPrefs] = useLocalPrefs(activeAccount?.accountId)

  // The device the current page belongs to (/sessions/<device>/…, /devices/<device>).
  const routeDeviceId = useMemo(() => {
    const m = /^\/(?:sessions|devices)\/([^/]+)/.exec(pathname)
    return m ? decodeURIComponent(m[1]) : null
  }, [pathname])

  // Assistant-first page flip: follows the route into a device, the back button leaves it.
  const [drill, setDrill] = useState<{ id: string | null; route: string | null; dir: "in" | "out" }>({
    id: routeDeviceId,
    route: routeDeviceId,
    dir: "in",
  })
  if (drill.route !== routeDeviceId) {
    setDrill({ id: routeDeviceId ?? drill.id, route: routeDeviceId, dir: "in" })
  }
  const drilledDevice = drill.id ? (devices.find((d) => d.id === drill.id) ?? null) : null
  const drilledSessions = useMemo(
    () =>
      drilledDevice
        ? sessions.filter((s) => s.device_id === drilledDevice.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        : [],
    [drilledDevice, sessions]
  )

  const pins = useMemo(() => new Set(prefs.pins), [prefs.pins])
  const isPinned = (s: SessionSummary) => s.pinned || pins.has(sessionKey(s))
  const pinnedSessions = useMemo(
    () => sessions.filter((s) => s.pinned || pins.has(sessionKey(s))),
    [pins, sessions]
  )
  const recentSessions = useMemo(
    () =>
      [...sessions]
        .filter((s) => !(s.pinned || pins.has(sessionKey(s))))
        // Running conversations first, then by last activity (v2 session-list-order).
        .sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || b.updated_at.localeCompare(a.updated_at))
        .slice(0, RECENT_LIMIT),
    [pins, sessions]
  )
  const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? id
  const isEncrypted = (id: string) =>
    Boolean(deviceTrusts[id]) || devices.find((d) => d.id === id)?.mode_hint === "encrypted"

  const go = (href: string) => {
    router.push(href)
    if (isMobile) setOpenMobile(false)
  }
  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false)
  }

  const togglePin = (s: SessionSummary) =>
    setPrefs((p) => ({ pins: toggleIn(p.pins, sessionKey(s)) }))

  const hasIndicator = (s: SessionSummary) => s.state === "running" || s.state === "waiting" || s.state === "error" || s.unread

  /** The row's menu (v2 session row context menu): pin, rename, copy ID, open the device. */
  const rowMenu = (s: SessionSummary) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<SidebarMenuAction showOnHover className="top-1/2! -translate-y-1/2" aria-label={t("conv.more")} />}
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-52">
        <DropdownMenuItem onClick={() => togglePin(s)}>
          <PinIcon />
          {isPinned(s) ? t("wb.unpin") : t("wb.pin")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={devices.find((d) => d.id === s.device_id)?.presence !== "online"}
          onClick={() => setRenaming({ session: s, title: s.title })}
        >
          <SquarePenIcon />
          {t("conv.rename")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            void navigator.clipboard
              ?.writeText(s.id)
              .then(() => toast.success(t("common.copied")))
              .catch(() => toast.error(t("common.copyFailed")))
          }
        >
          <CopyIcon />
          {t("conv.copyId")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => go(deviceHref(s.device_id))}>
          <LaptopIcon />
          {t("conv.openDevice")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const submitRename = async () => {
    if (!renaming || !tunnelManager) return
    const next = renaming.title.trim()
    const dev = devices.find((d) => d.id === renaming.session.device_id)
    setRenaming(null)
    if (!next || !dev || next === renaming.session.title) return
    try {
      await tunnelManager.renameSession(dev, renaming.session.id, next)
      void refreshSessions()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * A conversation row: one line, like any chat app. Agent and device are in the tooltip; an encrypted device's
   * conversations carry a lock. Running / waiting / unread marks give way to the row's menu on hover.
   */
  const renderRow = (s: SessionSummary, showAge = false) => {
    const href = sessionHref(s.device_id, s.id)
    return (
      <SidebarMenuItem key={sessionKey(s)}>
        <SidebarMenuButton
          isActive={pathname === href}
          render={<Link href={href} onClick={closeOnMobile} />}
          title={`${agentLabel(s.agent)} · ${deviceName(s.device_id)}`}
        >
          {isEncrypted(s.device_id) && <LockIcon className="size-3.5! text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">{s.title || t("wb.untitled")}</span>
        </SidebarMenuButton>
        {hasIndicator(s) ? (
          <SidebarMenuBadge className="top-1/2! -translate-y-1/2 transition-opacity group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0 group-has-data-popup-open/menu-item:opacity-0">
            <SessionStatus state={s.state} unread={s.unread} />
          </SidebarMenuBadge>
        ) : (
          showAge && (
            <SidebarMenuBadge className="top-1/2! -translate-y-1/2 transition-opacity group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0 group-has-data-popup-open/menu-item:opacity-0">
              <span className="text-xs font-normal tabular-nums text-muted-foreground">{shortAgo(s.updated_at, locale)}</span>
            </SidebarMenuBadge>
          )
        )}
        {rowMenu(s)}
      </SidebarMenuItem>
    )
  }

  const header = (
    <SidebarHeader className="h-14 justify-center px-3 py-0">
      <div className="flex items-center gap-0.5">
        <Link
          href="/"
          onClick={() => {
            setDrill({ id: null, route: routeDeviceId, dir: "out" })
            closeOnMobile()
          }}
          className="mr-auto inline-flex h-9 w-fit items-center rounded-md px-2 text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
        >
          <BrandWordmark size="sm" className="pointer-events-none" />
        </Link>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("wb.search")}
                onClick={() => {
                  closeOnMobile()
                  openPalette()
                }}
              />
            }
          >
            <SearchIcon className="size-4" />
          </TooltipTrigger>
          <TooltipContent>
            {t("wb.search")} · {isMacPlatform() ? "⌘K" : "Ctrl+K"}
          </TooltipContent>
        </Tooltip>
        {!isMobile && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("shell.collapseSidebar")}
                  onClick={toggleSidebar}
                />
              }
            >
              <PanelLeftIcon className="size-4" />
            </TooltipTrigger>
            <TooltipContent>
              {t("shell.collapseSidebar")} · {isMacPlatform() ? "⌘B" : "Ctrl+B"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </SidebarHeader>
  )

  /** One line per device: its state (online, offline, locked, unlocked, a problem) as one mark, then its name. */
  const deviceRows = (onPick: (dev: DeviceRecord) => void, drillIn: boolean) =>
    devices.map((dev) => {
      const href = deviceHref(dev.id)
      return (
        <SidebarMenuItem key={dev.id}>
          <SidebarMenuButton
            isActive={pathname === href}
            onClick={() => onPick(dev)}
            className={cn(dev.presence === "offline" && "text-muted-foreground")}
          >
            <DeviceStatusIcon device={dev} />
            <span className="min-w-0 flex-1 truncate">{dev.name}</span>
            {drillIn && <ChevronRightIcon className="size-3.5! text-muted-foreground" />}
          </SidebarMenuButton>
        </SidebarMenuItem>
      )
    })

  const devicesGroup = (assistantMode: boolean) => (
    <SidebarGroup>
      <SidebarGroupLabel>{t("shell.navDevices")}</SidebarGroupLabel>
      <DropdownMenu>
        <DropdownMenuTrigger render={<SidebarGroupAction title={t("wb.addDevice")} />}>
          <PlusIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-56">
          <DropdownMenuItem onClick={openRegisterDevice}>
            <LaptopIcon />
            {t("devices.register")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={openPairDevice}>
            <KeyRoundIcon />
            {t("devices.pair")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SidebarGroupContent>
        <SidebarMenu>
          {devices.length === 0 && (
            <SidebarMenuItem>
              <p className="px-3 py-1.5 text-sm text-muted-foreground">{t("wb.noDevicesHint")}</p>
            </SidebarMenuItem>
          )}
          {assistantMode
            ? deviceRows((dev) => setDrill({ id: dev.id, route: routeDeviceId, dir: "in" }), true)
            : deviceRows((dev) => go(deviceHref(dev.id)), false)}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )

  /** New conversation, as a plain row like ChatGPT's and Claude.ai's (on a device's page: on that device). */
  const newConversationRow = (deviceId?: string) => {
    const href = deviceId ? `/new?device=${encodeURIComponent(deviceId)}` : "/new"
    return (
      <SidebarMenuItem>
        <SidebarMenuButton isActive={pathname === "/new"} render={<Link href={href} onClick={closeOnMobile} />}>
          <SquarePenIcon />
          <span className="min-w-0 flex-1 truncate">{t("wb.newConversation")}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  /** Orches, docked on the right (Effi's assistant): the row opens and closes it and stays lit while it is open. */
  const orchesRow = (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={drawerOpen}
        aria-pressed={drawerOpen}
        onClick={() => {
          closeOnMobile()
          setDrawerOpen(!drawerOpen)
        }}
      >
        <OrchesIcon />
        <span className="min-w-0 flex-1 truncate">{t("shell.navAssistant")}</span>
        <kbd className="ml-auto font-sans text-xs text-muted-foreground">{isMacPlatform() ? "⌘J" : "Ctrl+J"}</kbd>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )

  /** The cloud drive: files to keep, share between devices and point conversations at (`drive:/…`). */
  const driveRow = (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={pathname === "/drive"} render={<Link href="/drive" onClick={closeOnMobile} />}>
        <CloudIcon />
        <span className="min-w-0 flex-1 truncate">{t("shell.navDrive")}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )

  let content: React.ReactNode
  if (preferences.assistantPrimary && drilledDevice) {
    const dev = drilledDevice
    content = (
      <div key={`dev-${dev.id}`} className="flex flex-col animate-in fade-in slide-in-from-right-6 duration-200 motion-reduce:animate-none">
        <SidebarGroup className="pb-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="text-muted-foreground"
                  onClick={() => setDrill({ id: null, route: routeDeviceId, dir: "out" })}
                >
                  <ArrowLeftIcon />
                  <span>{t("shell.backToAssistantList")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === deviceHref(dev.id)}
                  render={<Link href={deviceHref(dev.id)} onClick={closeOnMobile} />}
                  size="lg"
                >
                  <DeviceStatusIcon device={dev} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{dev.name}</span>
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {dev.presence === "online" ? t("devices.online") : t("devices.offline")}
                    </span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="py-0">
          <SidebarGroupContent>
            <SidebarMenu>{newConversationRow(dev.id)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{t("wb.conversations")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {drilledSessions.length === 0 && (
                <SidebarMenuItem>
                  <p className="px-3 py-1.5 text-sm text-muted-foreground">
                    {dev.presence === "online" ? t("wb.deviceNoConversations") : t("sessions.staleCache")}
                  </p>
                </SidebarMenuItem>
              )}
              {drilledSessions.map((s) => renderRow(s, true))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </div>
    )
  } else if (preferences.assistantPrimary) {
    content = (
      <div
        key="assistant"
        className={cn(
          "flex flex-col",
          drill.dir === "out" && "animate-in fade-in slide-in-from-left-6 duration-200 motion-reduce:animate-none"
        )}
      >
        <SidebarGroup className="pt-0 pb-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={async () => {
                    await startNewConversation()
                    go("/")
                  }}
                >
                  <SquarePenIcon />
                  <span className="min-w-0 flex-1 truncate">{t("assistant.newChat")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{t("assistant.title")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {conversations.length === 0 && (
                <SidebarMenuItem>
                  <p className="px-3 py-1.5 text-xs text-muted-foreground">{t("wb.assistantEmpty")}</p>
                </SidebarMenuItem>
              )}
              {conversations.slice(0, 30).map((conv) => (
                <SidebarMenuItem key={conv.id}>
                  <SidebarMenuButton
                    isActive={(pathname === "/" || pathname === "/assistant") && conv.id === activeConversationId}
                    onClick={() => {
                      selectConversation(conv.id)
                      if (pathname !== "/" && pathname !== "/assistant") go("/")
                      else closeOnMobile()
                    }}
                  >
                    {encryptionEnabled && <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{conv.title || t("wb.untitled")}</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge className="group-hover/menu-item:opacity-0">
                    <span className="text-xs font-normal tabular-nums text-muted-foreground">
                      {shortAgo(conv.updatedAt, locale)}
                    </span>
                  </SidebarMenuBadge>
                  <SidebarMenuAction
                    showOnHover
                    aria-label={t("common.delete")}
                    onClick={() => void deleteConversation(conv.id)}
                  >
                    <Trash2Icon />
                  </SidebarMenuAction>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {devicesGroup(true)}
      </div>
    )
  } else {
    content = (
      <>
        <SidebarGroup className="pt-0 pb-0">
          <SidebarGroupContent>
            <SidebarMenu>
              {newConversationRow()}
              {orchesRow}
              {driveRow}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {devicesGroup(false)}

        {pinnedSessions.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>{t("shell.navPinned")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{pinnedSessions.map((s) => renderRow(s))}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {recentSessions.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>{t("shell.navRecent")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{recentSessions.map((s) => renderRow(s))}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </>
    )
  }

  return (
    <Sidebar collapsible="offcanvas">
      {header}
      <SidebarContent className="overflow-x-hidden">
        {content}
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
                  <DropdownMenuItem key={acct.accountId} onClick={() => void switchAccount(acct.accountId)}>
                    <UserAvatar user={acct.user} className="size-7 text-xs" />
                    <div className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-sm">{acct.user.display_name || acct.user.email}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {acct.user.email ?? acct.serverUrl}
                      </span>
                    </div>
                    {acct.accountId === activeAccount.accountId && <CheckIcon className="size-4 shrink-0" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  closeOnMobile()
                  openSettings()
                }}
              >
                <SettingsIcon />
                <span className="flex-1">{t("shell.navSettings")}</span>
                <kbd className="font-sans text-xs text-muted-foreground">{isMacPlatform() ? "⌘," : "Ctrl+,"}</kbd>
              </DropdownMenuItem>
              {activeAccount.user.role === "admin" && (
                <DropdownMenuItem onClick={() => go("/admin")}>
                  <ShieldIcon />
                  <span>{t("shell.navAdmin")}</span>
                </DropdownMenuItem>
              )}
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
                <DropdownMenuItem variant="destructive" onClick={() => void signOutAllAccounts()}>
                  <LogOutIcon />
                  <span>{t("shell.signOutAll")}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
      )}
      <Dialog open={Boolean(renaming)} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("conv.renameTitle")}</DialogTitle>
          </DialogHeader>
          <form
            id="sidebar-rename"
            onSubmit={(e) => {
              e.preventDefault()
              void submitRename()
            }}
          >
            <Input
              autoFocus
              value={renaming?.title ?? ""}
              placeholder={t("conv.renamePlaceholder")}
              aria-label={t("conv.renameTitle")}
              onChange={(e) => setRenaming((r) => (r ? { ...r, title: e.target.value } : r))}
            />
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" form="sidebar-rename">
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Drag the right edge to resize (double-click: the default width); the header button folds it away. */}
      {!isMobile && sidebarState === "expanded" && (
        <ResizeHandle
          edge="right"
          width={resize.width}
          min={resize.min}
          max={resize.max}
          label={t("shell.resizeSidebar")}
          title={t("shell.resizeHint")}
          onPreview={resize.preview}
          onCommit={resize.commit}
          onReset={resize.reset}
          onResizing={resize.onResizing}
        />
      )}
    </Sidebar>
  )
}
