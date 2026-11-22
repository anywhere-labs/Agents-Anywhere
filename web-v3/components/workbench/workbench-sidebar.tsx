"use client"

// The workbench sidebar (docs/v3/client-experience-proposal.md §2.1 / §2.2).
//
// Device-first (default): New conversation, Search (⌘K), the assistant, Pinned, Recent (across devices, with device
// and agent), then Devices — each with presence and lock, expanding into Agent → Project → Conversation (a level is
// left out when it has a single child).
//
// Assistant-first: the assistant's conversations are the main list, devices below; picking a device flips the
// sidebar to that device's page (back button, its tree, a new conversation on it).
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CircleAlertIcon,
  CopyIcon,
  EllipsisIcon,
  FolderIcon,
  KeyRoundIcon,
  LaptopIcon,
  LoaderCircleIcon,
  LockIcon,
  LogOutIcon,
  MonitorIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  ShieldAlertIcon,
  SparklesIcon,
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
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useWorkbenchUi } from "@/components/workbench/workbench-ui"
import { useAssistant } from "@/lib/state/assistant-context"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { DevicePlatform, DeviceRecord, SessionSummary } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { toggleIn, useLocalPrefs } from "@/lib/workbench/local-prefs"
import { shortAgo } from "@/lib/workbench/time"
import {
  agentLabel,
  buildDeviceTree,
  deviceHref,
  sessionHref,
  sessionKey,
  type ProjectNode,
} from "@/lib/workbench/tree"

export const PLATFORM_ICON: Record<DevicePlatform, typeof LaptopIcon> = {
  macos: LaptopIcon,
  linux: ServerIcon,
  windows: MonitorIcon,
}

/** Sessions shown per project before "Show all". */
const PROJECT_LIMIT = 5
const RECENT_LIMIT = 8

function SessionStatus({ state, unread }: { state: SessionSummary["state"]; unread: boolean }) {
  if (state === "running") return <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
  if (state === "waiting") return <span className="size-2 rounded-full bg-warning" />
  if (state === "error") return <CircleAlertIcon className="size-3.5 text-destructive" />
  if (unread) return <span className="size-2 rounded-full bg-foreground" />
  return null
}

/** Presence dot + lock, as shown wherever a device appears. */
export function DeviceMarks({
  device,
  paired,
  encrypted,
}: {
  device: Pick<DeviceRecord, "presence">
  paired: boolean
  encrypted: boolean
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {encrypted &&
        (paired ? (
          <LockIcon className="size-3! text-muted-foreground" />
        ) : (
          <ShieldAlertIcon className="size-3! text-warning" />
        ))}
      <span
        className={cn(
          "size-1.5 rounded-full",
          device.presence === "online" ? "bg-success" : "bg-muted-foreground/40"
        )}
      />
    </span>
  )
}

export function WorkbenchSidebar() {
  const { t, locale } = useI18n()
  const pathname = usePathname()
  const router = useRouter()
  const { isMobile, setOpenMobile } = useSidebar()
  const { openPalette, openRegisterDevice, openPairDevice } = useWorkbenchUi()
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

  /** A pinned / recent row: title, then "Agent · Device" in small type. */
  const renderCrossDeviceRow = (s: SessionSummary) => {
    const href = sessionHref(s.device_id, s.id)
    return (
      <SidebarMenuItem key={sessionKey(s)}>
        <SidebarMenuButton
          isActive={pathname === href}
          render={<Link href={href} onClick={closeOnMobile} />}
          className="h-auto min-h-8 flex-col items-start gap-0 py-1.5 pr-8"
        >
          <span className="w-full truncate">{s.title || t("wb.untitled")}</span>
          <span className="flex w-full min-w-0 items-center gap-1 text-[11px] font-normal text-muted-foreground">
            {isEncrypted(s.device_id) && <LockIcon className="size-2.5!" />}
            <span className="truncate">
              {agentLabel(s.agent)} · {deviceName(s.device_id)}
            </span>
          </span>
        </SidebarMenuButton>
        {/* A running / waiting / unread mark gives way to the row's menu on hover, so every row can be pinned or renamed. */}
        {hasIndicator(s) && (
          <SidebarMenuBadge className="top-1/2! -translate-y-1/2 transition-opacity group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0 group-has-data-popup-open/menu-item:opacity-0">
            <SessionStatus state={s.state} unread={s.unread} />
          </SidebarMenuBadge>
        )}
        {rowMenu(s)}
      </SidebarMenuItem>
    )
  }

  /** A conversation inside the device tree: one line, its age on the right. */
  const renderTreeRow = (s: SessionSummary) => {
    const href = sessionHref(s.device_id, s.id)
    const status = <SessionStatus state={s.state} unread={s.unread} />
    return (
      <li key={sessionKey(s)} className="relative">
        <Link
          href={href}
          onClick={closeOnMobile}
          data-active={pathname === href || undefined}
          className="flex h-7 min-w-0 items-center gap-2 rounded-full px-2.5 text-[13px] text-sidebar-foreground/90 outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
        >
          <span className="min-w-0 flex-1 truncate">{s.title || t("wb.untitled")}</span>
          <span className="flex shrink-0 items-center text-[11px] tabular-nums text-muted-foreground">
            {s.state === "idle" && !s.unread ? shortAgo(s.updated_at, locale) : status}
          </span>
        </Link>
      </li>
    )
  }

  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({})
  const renderProject = (p: ProjectNode, deviceId: string, alone: boolean) => {
    const shown = p.sessions.slice(0, PROJECT_LIMIT)
    const more = p.sessions.length - shown.length
    const rows = (
      <ul className="flex flex-col gap-0.5">
        {shown.map(renderTreeRow)}
        {more > 0 && (
          <li>
            <Link
              href={`${deviceHref(deviceId, "conversations")}&cwd=${encodeURIComponent(p.cwd)}`}
              onClick={closeOnMobile}
              className="flex h-7 items-center rounded-full px-2.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              {t("wb.showAll", { count: p.sessions.length })}
            </Link>
          </li>
        )}
      </ul>
    )
    if (alone) return <div key={p.key}>{rows}</div>
    const open = openProjects[p.key] ?? true
    return (
      <div key={p.key} className="flex flex-col gap-0.5">
        <button
          type="button"
          title={p.cwd}
          aria-expanded={open}
          onClick={() => setOpenProjects((o) => ({ ...o, [p.key]: !open }))}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2 text-left text-[13px] text-sidebar-foreground/80 outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          <ChevronRightIcon
            className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
        </button>
        {open && <div className="pl-3">{rows}</div>}
      </div>
    )
  }

  /** Agent → Project → Conversation for one device, levels with one child left out. */
  const renderDeviceTree = (dev: DeviceRecord) => {
    const tree = buildDeviceTree(sessions.filter((s) => s.device_id === dev.id))
    if (!tree.length) {
      return (
        <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
          {dev.presence === "online" ? t("wb.deviceNoConversations") : t("sessions.staleCache")}
        </p>
      )
    }
    const manyAgents = tree.length > 1
    return (
      <div className="flex flex-col gap-1">
        {tree.map((a) => (
          <div key={a.agent} className="flex flex-col gap-0.5">
            {manyAgents && (
              <p className="px-2.5 pt-1 text-[11px] font-medium text-muted-foreground">{agentLabel(a.agent)}</p>
            )}
            {a.projects.map((p) => renderProject(p, dev.id, a.projects.length === 1))}
          </div>
        ))}
      </div>
    )
  }

  const expanded = useMemo(() => {
    const set = new Set(prefs.expandedDevices)
    if (routeDeviceId) set.add(routeDeviceId)
    if (devices.length === 1) set.add(devices[0].id)
    return set
  }, [devices, prefs.expandedDevices, routeDeviceId])

  const header = (
    <SidebarHeader className="px-3 pt-4 pb-1">
      <div className="flex items-center justify-between gap-2">
        <Link
          href="/"
          onClick={() => {
            setDrill({ id: null, route: routeDeviceId, dir: "out" })
            closeOnMobile()
          }}
          className="inline-flex h-9 w-fit items-center rounded-md px-2 text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
        >
          <BrandWordmark size="default" className="pointer-events-none" />
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
          <TooltipContent>{t("wb.search")} · ⌘K</TooltipContent>
        </Tooltip>
      </div>
    </SidebarHeader>
  )

  const deviceRows = (onPick: (dev: DeviceRecord) => void, withTree: boolean) =>
    devices.map((dev) => {
      const Icon = PLATFORM_ICON[dev.platform] ?? LaptopIcon
      const href = deviceHref(dev.id)
      const open = withTree && expanded.has(dev.id)
      return (
        <SidebarMenuItem key={dev.id}>
          <SidebarMenuButton
            isActive={pathname === href}
            onClick={() => onPick(dev)}
            className={cn("pr-8", dev.presence === "offline" && "text-muted-foreground")}
            title={dev.presence === "online" ? t("devices.online") : t("devices.offline")}
          >
            <Icon />
            <span className="min-w-0 flex-1 truncate">{dev.name}</span>
            <DeviceMarks device={dev} paired={Boolean(deviceTrusts[dev.id])} encrypted={isEncrypted(dev.id)} />
          </SidebarMenuButton>
          {withTree ? (
            <SidebarMenuAction
              aria-label={open ? t("wb.collapse") : t("wb.expand")}
              aria-expanded={open}
              onClick={() => setPrefs((p) => ({ expandedDevices: toggleIn(p.expandedDevices, dev.id, !open) }))}
            >
              <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
            </SidebarMenuAction>
          ) : (
            <SidebarMenuBadge>
              <ChevronRightIcon className="size-3.5 text-muted-foreground" />
            </SidebarMenuBadge>
          )}
          {open && <div className="mt-0.5 mb-1.5 ml-3.5 border-l border-sidebar-border pl-2">{renderDeviceTree(dev)}</div>}
        </SidebarMenuItem>
      )
    })

  const devicesGroup = (assistantMode: boolean) => (
    <SidebarGroup>
      <SidebarGroupLabel>{t("shell.navDevices")}</SidebarGroupLabel>
      <SidebarGroupAction title={t("devices.register")} onClick={openRegisterDevice}>
        <PlusIcon />
      </SidebarGroupAction>
      <SidebarGroupContent>
        <SidebarMenu>
          {devices.length === 0 && (
            <SidebarMenuItem>
              <p className="px-3 py-1.5 text-xs leading-relaxed text-muted-foreground">{t("wb.noDevicesHint")}</p>
            </SidebarMenuItem>
          )}
          {assistantMode
            ? deviceRows((dev) => setDrill({ id: dev.id, route: routeDeviceId, dir: "in" }), false)
            : deviceRows((dev) => go(deviceHref(dev.id)), true)}
          <SidebarMenuItem>
            <SidebarMenuButton onClick={openPairDevice} className="text-muted-foreground">
              <KeyRoundIcon />
              <span>{t("devices.pair")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )

  const newConversationButton = (deviceId?: string) => (
    <div className="px-2 pb-1">
      <Button
        variant="outline"
        className="w-full justify-start gap-2 bg-transparent"
        render={<Link href={deviceId ? `/new?device=${encodeURIComponent(deviceId)}` : "/new"} onClick={closeOnMobile} />}
        nativeButton={false}
      >
        <SquarePenIcon className="size-4" />
        <span>{t("wb.newConversation")}</span>
      </Button>
    </div>
  )

  let content: React.ReactNode
  if (preferences.assistantPrimary && drilledDevice) {
    const dev = drilledDevice
    const Icon = PLATFORM_ICON[dev.platform] ?? LaptopIcon
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
                  <Icon />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{dev.name}</span>
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {dev.presence === "online" ? t("devices.online") : t("devices.offline")}
                    </span>
                  </span>
                  <DeviceMarks device={dev} paired={Boolean(deviceTrusts[dev.id])} encrypted={isEncrypted(dev.id)} />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {newConversationButton(dev.id)}
        <SidebarGroup>
          <SidebarGroupLabel>{t("wb.conversations")}</SidebarGroupLabel>
          <SidebarGroupContent className="px-1">{renderDeviceTree(dev)}</SidebarGroupContent>
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
        <div className="px-2 pb-1">
          <Button
            variant="outline"
            className="w-full justify-start gap-2 bg-transparent"
            onClick={async () => {
              await startNewConversation()
              go("/")
            }}
          >
            <SquarePenIcon className="size-4" />
            <span>{t("assistant.newChat")}</span>
          </Button>
        </div>
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
                    <span className="text-[11px] font-normal tabular-nums text-muted-foreground">
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
        {newConversationButton()}
        <SidebarGroup className="pt-1 pb-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === "/assistant"}
                  onClick={() => {
                    closeOnMobile()
                    setDrawerOpen(true)
                  }}
                >
                  <SparklesIcon />
                  <span className="min-w-0 flex-1 truncate">{t("shell.navAssistant")}</span>
                  <kbd className="ml-auto font-sans text-[11px] text-muted-foreground">⌘J</kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {pinnedSessions.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>{t("shell.navPinned")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{pinnedSessions.map(renderCrossDeviceRow)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {recentSessions.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>{t("shell.navRecent")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{recentSessions.map(renderCrossDeviceRow)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {devicesGroup(false)}
      </>
    )
  }

  return (
    <Sidebar collapsible="offcanvas">
      {header}
      <SidebarContent className="overflow-x-hidden">
        {content}
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === "/settings"}
                  render={<Link href="/settings" onClick={closeOnMobile} />}
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
      <SidebarRail />
    </Sidebar>
  )
}
