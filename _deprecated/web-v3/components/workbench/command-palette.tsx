"use client"

// ⌘K search (client-experience-proposal §2.6): devices, agents, projects, conversations, assistant conversations and
// settings, in one list navigated with ↑ ↓ and Enter. Agents and projects come from what the device reported
// (Device/status runtimes) and from its conversations' directories.
import { useRouter } from "next/navigation"
import { useMemo, useState, type ReactNode } from "react"
import {
  BotIcon,
  CloudIcon,
  FolderIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LaptopIcon,
  LockIcon,
  MessageSquareIcon,
  PaletteIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  UserIcon,
  SquarePenIcon,
} from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useAssistant } from "@/lib/state/assistant-context"
import { settingsSectionFrom } from "@/components/workbench/settings-dialog"
import { isMacPlatform } from "@/components/workbench/shortcuts-dialog"
import { useWorkbenchUi } from "@/components/workbench/workbench-ui"
import { OrchesIcon } from "@/components/workbench/orches-icon"
import { useWorkbench } from "@/lib/state/workbench-context"
import { cn } from "@/lib/utils"
import { deviceInfoCache } from "@/lib/workbench/device-info"
import { shortAgo } from "@/lib/workbench/time"
import {
  agentLabel,
  deviceHref,
  matchesQuery,
  projectName,
  sessionHref,
  sessionKey,
  tildePath,
} from "@/lib/workbench/tree"

interface PaletteItem {
  key: string
  group: string
  icon: ReactNode
  label: string
  meta?: string
  hint?: string
  haystack: string
  run: () => void
}

const GROUP_LIMIT = 8

export function CommandPalette({
  open,
  onOpenChange,
  onRegisterDevice,
  onPairDevice,
  onShortcuts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRegisterDevice: () => void
  onPairDevice: () => void
  onShortcuts: () => void
}) {
  const { t, locale } = useI18n()
  const router = useRouter()
  const { devices, deviceTrusts, sessions, tunnelManager, preferences } = useWorkbench()
  const { conversations, selectConversation, setDrawerOpen } = useAssistant()
  const { openSettings } = useWorkbenchUi()
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)

  const close = () => {
    onOpenChange(false)
    setQuery("")
    setIndex(0)
  }

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return []
    const out: PaletteItem[] = []
    const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? id
    const gActions = t("palette.groupActions")
    const gConv = t("palette.groupConversations")
    const gAssistant = t("palette.groupAssistant")
    const gDevices = t("palette.groupDevices")
    const gAgents = t("palette.groupAgents")
    const gProjects = t("palette.groupProjects")
    const gSettings = t("palette.groupSettings")

    out.push(
      {
        key: "act:new",
        group: gActions,
        icon: <SquarePenIcon />,
        label: t("wb.newConversation"),
        hint: isMacPlatform() ? "⌘⇧O" : "Ctrl+Shift+O",
        haystack: `${t("wb.newConversation")} new conversation`,
        run: () => router.push("/new"),
      },
      {
        key: "act:assistant",
        group: gActions,
        icon: <OrchesIcon />,
        label: t("shell.quickAssistant"),
        hint: "⌘J",
        haystack: `${t("shell.quickAssistant")} orches assistant pi`,
        run: () => setDrawerOpen(true),
      },
      {
        key: "act:register",
        group: gActions,
        icon: <PlusIcon />,
        label: t("devices.register"),
        haystack: `${t("devices.register")} register device connector`,
        run: onRegisterDevice,
      },
      {
        key: "act:pair",
        group: gActions,
        icon: <KeyRoundIcon />,
        label: t("devices.pair"),
        haystack: `${t("devices.pair")} pair encrypted`,
        run: onPairDevice,
      },
      {
        key: "act:shortcuts",
        group: gActions,
        icon: <KeyboardIcon />,
        label: t("shortcuts.title"),
        hint: isMacPlatform() ? "⌘/" : "Ctrl+/",
        haystack: `${t("shortcuts.title")} keyboard shortcuts keys hotkeys`,
        run: onShortcuts,
      }
    )

    for (const s of [...sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
      const meta = `${agentLabel(s.agent)} · ${deviceName(s.device_id)} · ${projectName(s.cwd)}`
      out.push({
        key: `conv:${sessionKey(s)}`,
        group: gConv,
        icon: <MessageSquareIcon />,
        label: s.title || t("wb.untitled"),
        meta,
        hint: shortAgo(s.updated_at, locale),
        haystack: `${s.title} ${meta} ${s.cwd}`,
        run: () => router.push(sessionHref(s.device_id, s.id)),
      })
    }

    for (const c of conversations) {
      out.push({
        key: `asst:${c.id}`,
        group: gAssistant,
        icon: <OrchesIcon />,
        label: c.title || t("wb.untitled"),
        hint: shortAgo(c.updatedAt, locale),
        haystack: `${c.title} orches assistant`,
        run: () => {
          selectConversation(c.id)
          if (preferences.assistantPrimary) router.push("/")
          else setDrawerOpen(true)
        },
      })
    }

    for (const d of devices) {
      const encrypted = d.mode_hint === "encrypted" || Boolean(deviceTrusts[d.id])
      out.push({
        key: `dev:${d.id}`,
        group: gDevices,
        icon: encrypted ? <LockIcon /> : <LaptopIcon />,
        label: d.name,
        meta: d.presence === "online" ? t("devices.online") : t("devices.offline"),
        haystack: `${d.name} ${d.platform} device`,
        run: () => router.push(deviceHref(d.id)),
      })
      // Agents: what the device reported, plus any agent it has conversations with.
      const runtimes = tunnelManager ? (deviceInfoCache.get(tunnelManager, d.id).status?.runtimes ?? []) : []
      const agentIds = new Set([...runtimes.map((r) => r.id), ...sessions.filter((s) => s.device_id === d.id).map((s) => s.agent)])
      for (const a of agentIds) {
        const label = agentLabel(a, runtimes)
        out.push({
          key: `agent:${d.id}:${a}`,
          group: gAgents,
          icon: <BotIcon />,
          label,
          meta: d.name,
          hint: t("palette.startHere"),
          haystack: `${label} ${a} ${d.name} agent`,
          run: () => router.push(`/new?device=${encodeURIComponent(d.id)}&agent=${encodeURIComponent(a)}`),
        })
      }
      const cwds = new Set(sessions.filter((s) => s.device_id === d.id && s.cwd).map((s) => s.cwd))
      for (const cwd of cwds) {
        out.push({
          key: `proj:${d.id}:${cwd}`,
          group: gProjects,
          icon: <FolderIcon />,
          label: projectName(cwd),
          meta: `${d.name} · ${tildePath(cwd)}`,
          haystack: `${cwd} ${d.name} project`,
          run: () =>
            router.push(`${deviceHref(d.id, "conversations")}&cwd=${encodeURIComponent(cwd)}`),
        })
      }
    }

    const settings: [string, ReactNode, string, string][] = [
      ["general", <PaletteIcon key="i" />, t("settings.nav.general"), "theme language appearance orches mode"],
      ["account", <UserIcon key="i" />, t("settings.nav.account"), "account role limits quota"],
      ["drive", <CloudIcon key="i" />, t("settings.driveTitle"), "drive storage quota files"],
      ["apps", <ShieldIcon key="i" />, t("settings.mcpGrantsTitle"), "mcp grants oauth apps"],
      ["encryption", <LockIcon key="i" />, t("settings.vaultTitle"), "vault e2ee keys pairing encryption"],
    ]
    for (const [id, icon, label, words] of settings) {
      out.push({
        key: `set:${id}`,
        group: gSettings,
        icon,
        label,
        haystack: `${label} ${words} settings`,
        run: () => openSettings(settingsSectionFrom(id) ?? undefined),
      })
    }
    return out
  }, [
    open,
    conversations,
    deviceTrusts,
    devices,
    locale,
    onPairDevice,
    openSettings,
    onRegisterDevice,
    onShortcuts,
    preferences.assistantPrimary,
    router,
    selectConversation,
    sessions,
    setDrawerOpen,
    t,
    tunnelManager,
  ])

  // Filtered, each group capped; with no query only actions, recent conversations and devices show.
  const shown = useMemo(() => {
    const q = query.trim()
    const groups = new Map<string, PaletteItem[]>()
    for (const item of items) {
      if (!q && (item.key.startsWith("agent:") || item.key.startsWith("proj:") || item.key.startsWith("set:"))) continue
      if (q && !matchesQuery(q, item.label, item.haystack, item.meta)) continue
      const list = groups.get(item.group) ?? []
      if (list.length < (q ? GROUP_LIMIT : 5)) list.push(item)
      groups.set(item.group, list)
    }
    return [...groups.entries()]
  }, [items, query])
  const flat = useMemo(() => shown.flatMap(([, list]) => list), [shown])
  const active = Math.min(index, Math.max(0, flat.length - 1))

  const pick = (item: PaletteItem | undefined) => {
    if (!item) return
    close()
    item.run()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent
        showCloseButton={false}
        className="top-[14%] max-w-[calc(100%-1.5rem)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">{t("wb.search")}</DialogTitle>
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            placeholder={t("palette.placeholder")}
            aria-label={t("wb.search")}
            className="h-12 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                const n = flat.length
                if (n) setIndex((active + (e.key === "ArrowDown" ? 1 : n - 1)) % n)
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault()
                pick(flat[active])
              }
            }}
          />
          <kbd className="hidden rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground sm:inline">Esc</kbd>
        </div>
        <div className="max-h-[min(60vh,28rem)] overflow-y-auto p-1.5" role="listbox" aria-label={t("wb.search")}>
          {flat.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t("palette.noResults")}</p>
          )}
          {shown.map(([group, list]) => (
            <div key={group} className="py-1">
              <p className="px-3 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">{group}</p>
              {list.map((item) => {
                const i = flat.indexOf(item)
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => i !== active && setIndex(i)}
                    onClick={() => pick(item)}
                    className={cn(
                      "flex h-10 w-full min-w-0 items-center gap-2.5 rounded-full px-3 text-left text-sm outline-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                      i === active && "bg-surface-hover"
                    )}
                  >
                    {item.icon}
                    <span className="min-w-0 truncate text-foreground">{item.label}</span>
                    {item.meta && (
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.meta}</span>
                    )}
                    {!item.meta && <span className="flex-1" />}
                    {item.hint && (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{item.hint}</span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
