"use client"

// A device (client-experience-proposal §2.3), laid out like v2 web-next's device page: the name as the page title
// (click to rename) with its presence and lock beside it, then one column of plain sections under quiet labels —
// Agents (each starts a conversation with it), Projects (start one in it, or see its conversations), Recent
// conversations and the device's details. Other tabs: Conversations (all of them by agent / project, with a filter),
// Terminals, Files (browse and preview, git status and diff) and Security (pairing and paired clients on encrypted
// devices; the MCP switch on normal ones). Runtime availability states are not reported by v3 Connectors yet.
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { MeshCallError } from "meshcall/web"
import {
  ChevronRightIcon,
  EllipsisIcon,
  FolderIcon,
  KeyRoundIcon,
  LaptopIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { CopyableValue } from "@/components/console/copyable-value"
import { DetailList, type DetailItem } from "@/components/console/detail-list"
import { PageContainer } from "@/components/console/page-header"
import { useI18n } from "@/components/i18n-provider"
import { FullPageSpinner } from "@/components/spinner"
import { TerminalsPanel } from "@/components/terminal/terminals-panel"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AgentIcon } from "@/components/workbench/agent-icon"
import { AgentSettingsDialog } from "@/components/workbench/agent-settings-dialog"
import { E2eeLockBadge } from "@/components/workbench/e2ee-lock-badge"
import { FileBrowser } from "@/components/workbench/file-browser"
import { PairDeviceDialog } from "@/components/workbench/pair-device-dialog"
import { useRouteParams } from "@/lib/platform/route-params"
import { formatKeyFingerprint } from "@/lib/mesh/pairing"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { AgentEntry, PairedClientEntry, SessionSummary } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { deviceInfoCache, useDevice } from "@/lib/workbench/device-info"
import { formatSize, shortAgo } from "@/lib/workbench/time"
import {
  agentLabel,
  buildDeviceTree,
  deviceProjects,
  matchesQuery,
  projectName,
  sessionHref,
  tildePath,
} from "@/lib/workbench/tree"

const TABS = ["overview", "conversations", "terminals", "files", "security"] as const
type Tab = (typeof TABS)[number]

function uptime(seconds: number, zh: boolean): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (zh) return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

/** A page section's label: quiet, like the sidebar's group labels (v2's section headings). */
function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-1 flex min-h-8 items-center justify-between gap-2 px-2">
      <h2 className="text-xs font-medium text-muted-foreground">{children}</h2>
      {action}
    </div>
  )
}

const STATE_DOT: Partial<Record<SessionSummary["state"], string>> = {
  running: "bg-success",
  waiting: "bg-warning",
  error: "bg-destructive",
}

/** One conversation (v2's session row): its state as a dot, the title, the agent, when it last moved. */
function SessionRow({ s, deviceId, showAgent = true }: { s: SessionSummary; deviceId: string; showAgent?: boolean }) {
  const { t, locale } = useI18n()
  const state =
    s.state === "running"
      ? t("sessions.stateRunning")
      : s.state === "waiting"
        ? t("sessions.stateWaiting")
        : s.state === "error"
          ? t("sessions.stateError")
          : undefined
  return (
    <Link
      href={sessionHref(deviceId, s.id)}
      className="flex min-h-10 items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-hover"
    >
      <span
        title={state}
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          STATE_DOT[s.state] ?? (s.unread ? "bg-foreground" : "bg-muted-foreground/30")
        )}
      />
      {state && <span className="sr-only">{state}</span>}
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{s.title || t("wb.untitled")}</span>
      {showAgent && <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{agentLabel(s.agent)}</span>}
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{shortAgo(s.updated_at, locale)}</span>
    </Link>
  )
}

const PROJECTS_SHOWN = 6
const RECENT_SHOWN = 8

function DeviceWorkbenchPageInner() {
  const params = useRouteParams<{ deviceId: string }>("/devices/[deviceId]")
  const searchParams = useSearchParams()
  const router = useRouter()
  const { t, locale } = useI18n()
  const { sessions, controlClient, refreshDevices, removeLocalDeviceTrust } = useWorkbench()

  const deviceId = decodeURIComponent(params.deviceId ?? "")
  const { device, tunnelDevice, trust, encrypted, info, reload, tunnelManager } = useDevice(deviceId)
  const status = info.status
  const settings = info.settings
  const tunnelError = info.error
  const deviceSessions = useMemo(
    () => sessions.filter((s) => s.device_id === deviceId).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [sessions, deviceId]
  )

  const initialTab = searchParams.get("tab") ?? "overview"
  const [tab, setTab] = useState<Tab>(
    (TABS as readonly string[]).includes(initialTab) ? (initialTab as Tab) : initialTab === "sessions" ? "conversations" : "overview"
  )
  const [filter, setFilter] = useState("")
  const [cwdFilter, setCwdFilter] = useState<string | null>(searchParams.get("cwd"))

  // The name as the page title: click to rename in place (Enter saves, Esc or leaving cancels).
  const [editingName, setEditingName] = useState<string | null>(null)
  const [allProjects, setAllProjects] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [unpinOpen, setUnpinOpen] = useState(false)
  const [fingerprintState, setFingerprintState] = useState<{ pub: string; fp: string } | null>(null)
  const [pairedClients, setPairedClients] = useState<PairedClientEntry[]>([])
  const [generatedPairing, setGeneratedPairing] = useState<{ code: string; fingerprint: string; expires_at: string } | null>(null)

  useEffect(() => {
    if (!trust?.device_pub) return
    let alive = true
    const pub = trust.device_pub
    void formatKeyFingerprint(pub).then((fp) => {
      if (alive) setFingerprintState({ pub, fp })
    })
    return () => {
      alive = false
    }
  }, [trust?.device_pub])
  const fingerprint = trust?.device_pub && fingerprintState?.pub === trust.device_pub ? fingerprintState.fp : null

  const loadPairedClients = useCallback(async () => {
    if (!tunnelManager || !tunnelDevice || tunnelDevice.presence !== "online" || !encrypted || !trust) return
    const paired = await tunnelManager.listPairedClients(tunnelDevice).catch(() => ({ clients: [] }))
    setPairedClients(paired.clients)
  }, [encrypted, trust, tunnelDevice, tunnelManager])

  useEffect(() => {
    if (tab !== "security") return
    let alive = true
    queueMicrotask(() => {
      if (alive) void loadPairedClients()
    })
    return () => {
      alive = false
    }
  }, [loadPairedClients, tab])

  const call = async (task: () => Promise<unknown>, ok?: string) => {
    try {
      await task()
      if (ok) toast.success(ok)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDelete = async () => {
    if (!controlClient || !device) return
    setDeleting(true)
    try {
      await controlClient.deleteDevice(device.id)
      await refreshDevices()
      setDeleteOpen(false)
      router.replace("/")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const tree = useMemo(() => buildDeviceTree(deviceSessions), [deviceSessions])
  const projects = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of deviceSessions) counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1)
    return deviceProjects(deviceSessions).map((p) => ({
      ...p,
      name: tildePath(p.cwd) === "~" ? t("newConv.homeDirectory") : p.name,
      count: counts.get(p.cwd) ?? 0,
    }))
  }, [deviceSessions, t])
  // Agents: what the device reports, plus agents it has conversations with (an agent may have been removed since).
  // The agents' settings (aa.v3.Device/agents), when the Connector manages them; `managed: false` for one that
  // predates it (its agents are then the ones it reports, without switches or settings).
  const [agentList, setAgentList] = useState<{ deviceId: string; managed: boolean; entries: AgentEntry[] } | null>(null)
  const loadAgents = useCallback(async () => {
    if (!tunnelManager || !tunnelDevice || tunnelDevice.presence !== "online") return
    try {
      const res = await tunnelManager.listAgents(tunnelDevice)
      setAgentList({ deviceId: tunnelDevice.id, managed: true, entries: res.agents })
    } catch (err) {
      if (err instanceof MeshCallError && err.code === "method_not_found") {
        setAgentList({ deviceId: tunnelDevice.id, managed: false, entries: [] })
      }
    }
  }, [tunnelDevice, tunnelManager])
  useEffect(() => {
    let alive = true
    queueMicrotask(() => {
      if (alive) void loadAgents()
    })
    return () => {
      alive = false
    }
  }, [loadAgents])
  const agentState = agentList?.deviceId === deviceId ? agentList : null
  const entryOf = (id: string) => agentState?.entries.find((e) => e.id === id) ?? null
  const setEntry = (entry: AgentEntry) =>
    setAgentList((cur) =>
      cur && cur.deviceId === deviceId ? { ...cur, entries: cur.entries.map((e) => (e.id === entry.id ? entry : e)) } : cur
    )
  const [settingsAgent, setSettingsAgent] = useState<{ id: string; name: string } | null>(null)

  // Agents: the device's (with the turned-off ones when it manages them), plus agents it has conversations with
  // (an agent may have been removed since).
  const agents = useMemo(() => {
    const managedEntries = agentState?.managed ? agentState.entries : []
    const ids = new Set([
      ...managedEntries.map((e) => e.id),
      ...(status?.runtimes ?? []).map((r) => r.id),
      ...tree.map((a) => a.agent),
    ])
    return [...ids].map((id) => {
      const entry = managedEntries.find((e) => e.id === id)
      return {
        id,
        name: entry?.name ?? agentLabel(id, status?.runtimes),
        reported: Boolean(entry ?? status?.runtimes.some((r) => r.id === id)),
        enabled: entry?.enabled ?? true,
        running: entry?.running ?? 0,
        count: tree.find((a) => a.agent === id)?.count ?? 0,
      }
    })
  }, [agentState, status?.runtimes, tree])

  const toggleAgent = (id: string, enabled: boolean) => {
    if (!tunnelManager || !tunnelDevice) return
    void call(async () => {
      const entry = await tunnelManager.updateAgent(tunnelDevice, { id, enabled })
      setEntry(entry)
      // New conversations offer only the agents that are on: read the device's list again.
      void deviceInfoCache.load(tunnelManager, tunnelDevice, true)
    })
  }

  const filtered = useMemo(
    () =>
      deviceSessions.filter(
        (s) => (!cwdFilter || s.cwd === cwdFilter) && matchesQuery(filter, s.title, s.agent, agentLabel(s.agent), s.cwd)
      ),
    [cwdFilter, deviceSessions, filter]
  )
  const filteredTree = useMemo(() => buildDeviceTree(filtered), [filtered])

  const details = useMemo<DetailItem[]>(() => {
    if (!device) return []
    return [
      {
        key: "presence",
        label: t("device.status"),
        value: device.presence === "online" ? t("devices.online") : t("devices.offline"),
      },
      { key: "host", label: t("device.hostname"), value: status?.hostname ?? "—" },
      {
        key: "platform",
        label: t("devices.platform"),
        value: status ? `${status.platform} · ${status.arch}` : device.platform,
      },
      { key: "mode", label: t("devices.mode"), value: encrypted ? t("devices.modeEncrypted") : t("devices.modeNormal") },
      { key: "version", label: "Connector", value: status?.connector_version ?? device.connector_version ?? "—" },
      ...(status ? [{ key: "uptime", label: t("device.uptime"), value: uptime(status.uptime_seconds, locale === "zh-CN") }] : []),
      ...(settings
        ? [{ key: "rpc", label: t("device.rpcCap"), value: formatSize(settings.max_rpc_file_bytes) }]
        : []),
    ]
  }, [device, encrypted, locale, settings, status, t])

  if (!device) {
    return (
      <div className="flex-1 overflow-y-auto">
        <PageContainer>
          <div className="rounded-card bg-card p-8 text-center">
            <LaptopIcon className="mx-auto size-8 stroke-[1.5] text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">{t("devices.empty")}</p>
            <Button variant="outline" size="sm" className="mt-4" render={<Link href="/" />} nativeButton={false}>
              {t("common.back")}
            </Button>
          </div>
        </PageContainer>
      </div>
    )
  }

  const online = device.presence === "online"
  const newHref = (query: Record<string, string>) =>
    `/new?${new URLSearchParams({ device: device.id, ...query }).toString()}`
  const commitName = () => {
    const next = editingName?.trim()
    setEditingName(null)
    if (!next || next === device.name || !controlClient) return
    void call(async () => {
      await controlClient.renameDevice(device.id, next)
      await refreshDevices()
    }, t("common.saved"))
  }
  const refresh = () => {
    void reload()
    void call(async () => {
      if (!controlClient) return
      const res = await controlClient.pingDevice(device.id)
      toast.success(t("devices.pingOk", { time: res.server_time }))
    })
  }
  const shownProjects = allProjects ? projects : projects.slice(0, PROJECTS_SHOWN)

  return (
    <div className="flex-1 overflow-y-auto">
      <PageContainer className="max-w-4xl gap-6 py-8">
        {/* Header (v2): the name is the title — click to rename — with its presence and lock beside it. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {editingName !== null ? (
            <input
              autoFocus
              value={editingName}
              aria-label={t("devices.deviceName")}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={() => setEditingName(null)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === "Enter") {
                  e.preventDefault()
                  commitName()
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  setEditingName(null)
                }
              }}
              className="h-10 max-w-sm min-w-0 flex-1 rounded-lg bg-card px-2 font-heading text-2xl font-semibold tracking-tight text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          ) : (
            <h1 className="min-w-0">
              <button
                type="button"
                title={t("devices.rename")}
                onClick={() => setEditingName(device.name)}
                className="max-w-full truncate text-left font-heading text-2xl font-semibold tracking-tight underline-offset-4 hover:underline"
              >
                {device.name}
              </button>
            </h1>
          )}
          <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
            <span className={cn("size-2 rounded-full", online ? "bg-success" : "bg-muted-foreground/40")} />
            {online ? t("devices.online") : t("device.offlineCached")}
          </span>
          {encrypted && <E2eeLockBadge paired={Boolean(trust)} compact className="shrink-0" />}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Button size="sm" disabled={!online} render={<Link href={newHref({})} />} nativeButton={false}>
              <PlusIcon className="size-3.5" />
              {t("wb.newConversation")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("conv.more")} />}>
                <EllipsisIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => setEditingName(device.name)}>
                  <PencilIcon />
                  {t("devices.rename")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                  <Trash2Icon />
                  {t("device.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {tunnelError?.code === "e2e_not_paired" && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-card bg-card p-5">
            <div className="flex items-start gap-3">
              <LockIcon className="mt-0.5 size-5 shrink-0 text-warning" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{t("devices.unpaired")}</p>
                <p className="text-sm text-muted-foreground">{t("devices.unpairedHint")}</p>
              </div>
            </div>
            <Button size="sm" onClick={() => setPairOpen(true)}>
              {t("devices.pair")}
            </Button>
          </div>
        )}
        {tunnelError && tunnelError.code !== "e2e_not_paired" && (
          <p className="rounded-2xl bg-card px-4 py-3 text-sm text-destructive">
            {tunnelError.code === "e2e_required_locally" ? t("devices.locallyLockedError") : tunnelError.message}
          </p>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList variant="pill" scrollable>
            <TabsTrigger value="overview">{t("devices.tabOverview")}</TabsTrigger>
            <TabsTrigger value="conversations">{t("device.tabConversations")}</TabsTrigger>
            <TabsTrigger value="terminals">{t("devices.tabTerminals")}</TabsTrigger>
            <TabsTrigger value="files">{t("devices.tabFiles")}</TabsTrigger>
            <TabsTrigger value="security">{t("devices.tabSecurity")}</TabsTrigger>
          </TabsList>

          {/* Overview: one column of plain sections (v2) */}
          <TabsContent value="overview" className="mt-6 space-y-8">
            <section>
              <SectionLabel
                action={
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={info.loading || !online}
                    onClick={refresh}
                    className="text-muted-foreground"
                  >
                    <RefreshCwIcon className={cn("size-3.5", info.loading && "animate-spin")} />
                    {t("common.refresh")}
                  </Button>
                }
              >
                {t("device.agents")}
              </SectionLabel>
              {!online ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">{t("newConv.offline")}</p>
              ) : !status && !tunnelError ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">{t("newConv.loadingAgents")}</p>
              ) : agents.length === 0 ? (
                <div className="space-y-1 px-2 py-2">
                  <p className="text-sm text-foreground">{t("newConv.noAgents")}</p>
                  <p className="text-sm text-muted-foreground">{t("newConv.noAgentsHint")}</p>
                </div>
              ) : (
                <ul className="flex flex-col">
                  {agents.map((a) => {
                    const entry = entryOf(a.id)
                    const startable = online && a.reported && a.enabled
                    const meta = [
                      t("device.agentConversations", { count: a.count }),
                      ...(a.running > 0 ? [t("device.agentRunning", { count: a.running })] : []),
                      ...(!a.enabled ? [t("device.agentOff")] : []),
                      ...(!a.reported ? [t("device.agentNotReported")] : []),
                    ].join(" · ")
                    return (
                      <li
                        key={a.id}
                        className="group flex min-h-12 items-center gap-1 rounded-lg pr-2 transition-colors hover:bg-surface-hover"
                      >
                        <button
                          type="button"
                          disabled={!a.reported}
                          onClick={() => setSettingsAgent({ id: a.id, name: a.name })}
                          aria-label={t("device.agentSettings", { agent: a.name })}
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-3 rounded-lg py-2 pl-2 text-left",
                            !a.enabled && "opacity-60"
                          )}
                        >
                          <AgentIcon agent={a.id} name={a.name} className="size-5 text-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">{a.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">{meta}</span>
                          </span>
                        </button>
                        {startable && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("device.agentNewConversation", { agent: a.name })}
                            title={t("device.agentNewConversation", { agent: a.name })}
                            className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            render={<Link href={newHref({ agent: a.id })} />}
                            nativeButton={false}
                          >
                            <PlusIcon className="size-4" />
                          </Button>
                        )}
                        {entry && (
                          <Switch
                            checked={entry.enabled}
                            disabled={!online}
                            onCheckedChange={(v) => toggleAgent(a.id, Boolean(v))}
                            aria-label={`${t("agent.enabled")} · ${a.name}`}
                            className="ml-1 shrink-0"
                          />
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            {projects.length > 0 && (
              <section>
                <SectionLabel>{t("device.projects")}</SectionLabel>
                <div className="grid gap-2 sm:grid-cols-2">
                  {shownProjects.map((p) => (
                    <div
                      key={p.cwd}
                      className="flex min-w-0 items-center rounded-xl bg-card transition-colors hover:bg-surface-hover"
                    >
                      <button
                        type="button"
                        title={t("device.projectConversations")}
                        onClick={() => {
                          setCwdFilter(p.cwd)
                          setTab("conversations")
                        }}
                        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 text-left"
                      >
                        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">{p.name}</span>
                          <span className="block truncate text-xs text-muted-foreground" title={p.cwd}>
                            {tildePath(p.cwd)} · {t("device.agentConversations", { count: p.count })}
                          </span>
                        </span>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!online}
                        aria-label={t("device.newInProject", { name: p.name })}
                        title={t("device.newInProject", { name: p.name })}
                        className="mx-1.5 shrink-0"
                        render={<Link href={newHref({ cwd: p.cwd })} />}
                        nativeButton={false}
                      >
                        <PlusIcon className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
                {projects.length > PROJECTS_SHOWN && (
                  <button
                    type="button"
                    aria-expanded={allProjects}
                    onClick={() => setAllProjects((v) => !v)}
                    className="mt-2 flex items-center gap-1 px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {allProjects ? t("device.showLess") : t("wb.showAll", { count: projects.length })}
                    <ChevronRightIcon className={cn("size-3.5 transition-transform", allProjects && "-rotate-90")} />
                  </button>
                )}
              </section>
            )}

            <section>
              <SectionLabel
                action={
                  deviceSessions.length > RECENT_SHOWN && (
                    <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setTab("conversations")}>
                      {t("wb.showAll", { count: deviceSessions.length })}
                      <ChevronRightIcon className="size-3.5" />
                    </Button>
                  )
                }
              >
                {t("device.recent")}
              </SectionLabel>
              {deviceSessions.length === 0 ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">{t("wb.deviceNoConversations")}</p>
              ) : (
                <div className="flex flex-col">
                  {deviceSessions.slice(0, RECENT_SHOWN).map((s) => (
                    <SessionRow key={s.id} s={s} deviceId={device.id} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <SectionLabel>{t("device.info")}</SectionLabel>
              <div className="rounded-2xl bg-card p-4">
                <DetailList items={details} />
              </div>
            </section>
          </TabsContent>

          {/* Conversations */}
          <TabsContent value="conversations" className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-56 flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t("device.filter")}
                  aria-label={t("device.filter")}
                  className="pl-10"
                />
              </div>
              {cwdFilter && (
                <Button variant="outline" size="sm" onClick={() => setCwdFilter(null)}>
                  <FolderIcon className="size-3.5" />
                  {t("device.filterProject", { name: projectName(cwdFilter) })}
                  <XIcon className="size-3.5" />
                </Button>
              )}
            </div>
            {filteredTree.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                {deviceSessions.length ? t("device.noMatches") : t("wb.deviceNoConversations")}
              </p>
            ) : (
              filteredTree.map((a) => (
                <section key={a.agent} className="pt-2">
                  <SectionLabel>
                    {agentLabel(a.agent, status?.runtimes)} · {a.count}
                  </SectionLabel>
                  {a.projects.map((p) => (
                    <div key={p.key} className="pb-2">
                      <p className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-xs text-muted-foreground" title={p.cwd}>
                        <FolderIcon className="size-3.5 shrink-0" />
                        <span className="shrink-0">{p.name}</span>
                        <span className="truncate opacity-70">{tildePath(p.cwd)}</span>
                      </p>
                      <div className="flex flex-col">
                        {p.sessions.map((s) => (
                          <SessionRow key={s.id} s={s} deviceId={device.id} showAgent={false} />
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              ))
            )}
          </TabsContent>

          {/* Terminals */}
          <TabsContent value="terminals" className="mt-6">
            <TerminalsPanel tunnelManager={tunnelManager} device={tunnelDevice} defaultCwd={status?.cwd || undefined} />
          </TabsContent>

          {/* Files */}
          <TabsContent value="files" className="mt-6">
            <FileBrowser
              tunnelManager={tunnelManager}
              device={tunnelDevice}
              initialPath={searchParams.get("path") ?? undefined}
              layout="split"
            />
          </TabsContent>

          {/* Security */}
          <TabsContent value="security" className="mt-6 space-y-6">
            {!encrypted && settings && (
              <div className="flex items-center justify-between gap-4 rounded-card bg-card p-6">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">{t("devices.allowMcp")}</p>
                  <p className="text-sm leading-relaxed text-muted-foreground">{t("devices.allowMcpDesc")}</p>
                </div>
                <Switch
                  checked={settings.allow_mcp}
                  onCheckedChange={(checked) =>
                    void call(async () => {
                      if (!tunnelManager || !tunnelDevice) return
                      const updated = await tunnelManager.updateDeviceSettings(tunnelDevice, { allow_mcp: Boolean(checked) })
                      deviceInfoCache.patchSettings(tunnelManager, device.id, updated)
                    }, t("common.saved"))
                  }
                />
              </div>
            )}

            <div className="space-y-4 rounded-card bg-card p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1">
                  <h3 className="flex items-center gap-2 text-base font-semibold">
                    <LockIcon className="size-4 text-muted-foreground" />
                    {t("devices.greyLockTitle")}
                  </h3>
                  <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{t("devices.greyLockDesc")}</p>
                </div>
                <Button size="sm" onClick={() => setPairOpen(true)}>
                  <KeyRoundIcon className="size-3.5" />
                  {t("devices.pair")}
                </Button>
              </div>
              {trust && (
                <div className="space-y-3 border-t border-border pt-4">
                  <CopyableValue
                    label={t("devices.pairFingerprint")}
                    value={fingerprint ?? trust.device_pub}
                    copyLabel={t("common.copy")}
                    copyFailedLabel={t("common.copyFailed")}
                  />
                  <div className="flex justify-end">
                    <Button variant="outline" size="sm" onClick={() => setUnpinOpen(true)}>
                      {t("device.removePin")}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {encrypted && trust && (
              <div className="space-y-4 rounded-card bg-card p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-base font-semibold">{t("devices.pairedClients")}</h3>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!online}
                    onClick={() =>
                      void call(async () => {
                        if (!tunnelManager || !tunnelDevice) return
                        const res = await tunnelManager.createPairing(tunnelDevice, { kind: "code" })
                        setGeneratedPairing({ code: res.code ?? "", fingerprint: res.fingerprint ?? "", expires_at: res.expires_at })
                      })
                    }
                  >
                    {t("devices.createPairingLink")}
                  </Button>
                </div>
                {generatedPairing && (
                  <div className="space-y-2">
                    <CopyableValue
                      label={t("devices.generatedCodeLabel", {
                        time: new Date(generatedPairing.expires_at).toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : "en-US"),
                      })}
                      value={generatedPairing.code}
                      copyLabel={t("common.copy")}
                      copyFailedLabel={t("common.copyFailed")}
                    />
                    {generatedPairing.fingerprint && (
                      <p className="text-xs text-muted-foreground">
                        {t("devices.pairFingerprint")}: <span className="font-mono">{generatedPairing.fingerprint}</span>
                      </p>
                    )}
                  </div>
                )}
                {pairedClients.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("devices.noPairedClients")}</p>
                ) : (
                  <div className="divide-y divide-border">
                    {pairedClients.map((client) => (
                      <div key={client.client_pub} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{client.label || client.platform}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">{client.client_pub}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("common.delete")}
                          onClick={() =>
                            void call(async () => {
                              if (!tunnelManager || !tunnelDevice) return
                              await tunnelManager.revokePairedClient(tunnelDevice, client.client_pub)
                              setPairedClients((prev) => prev.filter((c) => c.client_pub !== client.client_pub))
                            }, t("common.saved"))
                          }
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </PageContainer>

      {settingsAgent && (
        <AgentSettingsDialog
          open={Boolean(settingsAgent)}
          onOpenChange={(open) => {
            if (!open) setSettingsAgent(null)
          }}
          tunnelManager={tunnelManager}
          device={tunnelDevice}
          agent={settingsAgent}
          entry={entryOf(settingsAgent.id)}
          managed={agentState?.managed ?? true}
          onEntry={(entry) => {
            setEntry(entry)
            if (tunnelManager && tunnelDevice) void deviceInfoCache.load(tunnelManager, tunnelDevice, true)
          }}
          onStopped={() => void loadAgents()}
        />
      )}

      <PairDeviceDialog
        open={pairOpen}
        onOpenChange={(open) => {
          setPairOpen(open)
          if (!open) void reload()
        }}
        deviceNameHint={device.name}
        deviceId={device.id}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("devices.deleteConfirmTitle", { name: device.name })}
        description={t("devices.deleteConfirmDesc")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={deleting}
        onConfirm={() => void handleDelete()}
      />

      <ConfirmDialog
        open={unpinOpen}
        onOpenChange={setUnpinOpen}
        title={t("device.removePin")}
        description={t("devices.unpairedHint")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={async () => {
          await removeLocalDeviceTrust(deviceId)
          setUnpinOpen(false)
          toast.success(t("common.saved"))
        }}
      />
    </div>
  )
}

export default function DeviceWorkbenchPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <DeviceWorkbenchPageInner />
    </Suspense>
  )
}
