"use client"

// A device (client-experience-proposal §2.3), laid out like v2 web-next's device page: the name as the page title
// (click to rename) with its presence and lock beside it, then one column of plain sections under quiet labels —
// Agents (`device-agents.tsx`), Projects (start a conversation in one, or see its conversations), Recent conversations
// and the device's details. Other tabs: Conversations (all of them by agent / project, with a filter), Terminals, Files
// (browse and preview, git status and diff) and Security (pairing and paired clients on encrypted devices; the MCP
// switch on normal ones).
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useMemo, useState } from "react"
import {
  ChevronRightIcon,
  Settings2Icon,
  FolderIcon,
  LaptopIcon,
  LockIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { type DetailItem } from "@/components/console/detail-list"
import { PageContainer } from "@/components/console/page-header"
import { useI18n } from "@/components/i18n-provider"
import { FullPageSpinner } from "@/components/spinner"
import { TerminalsPanel } from "@/components/terminal/terminals-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useHeaderFit } from "@/hooks/use-header-fit"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AgentIcon } from "@/components/workbench/agent-icon"
import { DeviceAgents } from "@/components/workbench/device-agents"
import { E2eeLockBadge } from "@/components/workbench/e2ee-lock-badge"
import { FileBrowser } from "@/components/workbench/file-browser"
import { DeviceSettingsDialog, type DeviceSection } from "@/components/workbench/device-settings-dialog"
import { PairDeviceDialog } from "@/components/workbench/pair-device-dialog"
import { SectionLabel } from "@/components/workbench/section-label"
import { useRouteParams } from "@/lib/platform/route-params"
import { formatKeyFingerprint } from "@/lib/mesh/pairing"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { SessionSummary } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { isInstalled, type ListedAgent } from "@/lib/workbench/agents"
import { deviceInfoCache, useDevice } from "@/lib/workbench/device-info"
import { formatSize, shortAgo } from "@/lib/workbench/time"
import { useDeviceAgents } from "@/lib/workbench/use-device-agents"
import {
  agentLabel,
  buildDeviceTree,
  deviceProjects,
  matchesQuery,
  projectName,
  sessionHref,
  tildePath,
} from "@/lib/workbench/tree"

const TABS = ["overview", "conversations", "terminals", "files"] as const
type Tab = (typeof TABS)[number]

function uptime(seconds: number, zh: boolean): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (zh) return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
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
      {showAgent && <AgentIcon agent={s.agent} name={agentLabel(s.agent)} className="text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{s.title || t("wb.untitled")}</span>
      {(STATE_DOT[s.state] || s.unread) && (
        <span title={state} className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[s.state] ?? "bg-foreground")} />
      )}
      {state && <span className="sr-only">{state}</span>}
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
  // 设备设置 (the gear); an older `?tab=security` link opens its encryption section.
  const [settingsOpen, setSettingsOpen] = useState(initialTab === "security")
  const [settingsSection, setSettingsSection] = useState<DeviceSection | null>(initialTab === "security" ? "encryption" : null)
  const [filter, setFilter] = useState("")
  const [cwdFilter, setCwdFilter] = useState<string | null>(searchParams.get("cwd"))

  // The name as the page title: click to rename in place (Enter saves, Esc or leaving cancels).
  const [editingName, setEditingName] = useState<string | null>(null)
  const {
    containerRef: headerRef,
    titleRef: headerTitleRef,
    nameRef: headerNameRef,
    actionsRef: headerActionsRef,
    mainActionRef: headerMainActionRef,
    compact: headerCompact,
  } = useHeaderFit(
    [device?.name ?? "", device?.presence ?? "", encrypted ? "e2e" : "", trust ? "paired" : "", editingName !== null ? "editing" : "", locale].join("|")
  )
  const [allProjects, setAllProjects] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [fingerprintState, setFingerprintState] = useState<{ pub: string; fp: string } | null>(null)

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
  // The device's agents: their settings (aa.v3.Device/agents) when the Connector manages them, else the ones it reports.
  const [newTerminal, setNewTerminal] = useState(false)
  const deviceAgents = useDeviceAgents({
    tunnelManager,
    device: tunnelDevice,
    deviceId,
    shown: tab === "overview",
    onNews: ({ kind, entry }) =>
      kind === "installed" ? toast.success(t("install.done", { agent: entry.name })) : toast.error(t("install.failedToast", { agent: entry.name })),
  })
  const agents = useMemo((): ListedAgent[] => {
    const listed = (id: string) => tree.find((a) => a.agent === id)?.count ?? 0
    if (deviceAgents.entries && deviceAgents.managed) {
      return deviceAgents.entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        entry,
        installed: isInstalled(entry),
        enabled: entry.enabled,
        running: entry.running > 0,
        count: listed(entry.id),
      }))
    }
    return (status?.runtimes ?? []).map((r) => ({
      id: r.id,
      name: agentLabel(r.id, status?.runtimes),
      entry: null,
      installed: true,
      enabled: true,
      running: false,
      count: listed(r.id),
    }))
  }, [deviceAgents.entries, deviceAgents.managed, status?.runtimes, tree])

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
    void deviceAgents.search()
    void call(async () => {
      if (!controlClient) return
      const res = await controlClient.pingDevice(device.id)
      toast.success(t("devices.pingOk", { time: res.server_time }))
    })
  }
  const shownProjects = allProjects ? projects : projects.slice(0, PROJECTS_SHOWN)

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <PageContainer className="max-w-4xl flex-1 gap-6 py-8">
        {/* Header (v2): the name is the title — click to rename — with its presence and lock beside it. */}
        <div ref={headerRef} className="flex min-w-0 items-center gap-3">
          <div ref={headerTitleRef} className={cn("flex min-w-0 items-center gap-3", editingName !== null && "flex-1")}>
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
            <h1 className="flex min-w-0">
              <button
                ref={headerNameRef as React.RefObject<HTMLButtonElement | null>}
                type="button"
                title={device.name}
                onClick={() => setEditingName(device.name)}
                className="min-w-0 truncate text-left font-heading text-2xl font-semibold tracking-tight underline-offset-4 hover:underline"
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
          </div>
          <div ref={headerActionsRef} className="ml-auto flex shrink-0 items-center gap-1.5">
            <Button
              ref={headerMainActionRef as React.RefObject<HTMLButtonElement | null>}
              size={headerCompact ? "icon-sm" : "sm"}
              disabled={!online}
              aria-label={t("wb.newConversation")}
              title={headerCompact ? t("wb.newConversation") : undefined}
              render={<Link href={newHref({})} />}
              nativeButton={false}
            >
              <PlusIcon className={headerCompact ? "size-4" : "size-3.5"} />
              {!headerCompact && t("wb.newConversation")}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("device.settings")}
              title={t("device.settings")}
              onClick={() => {
                setSettingsSection(null)
                setSettingsOpen(true)
              }}
            >
              <Settings2Icon className="size-4" />
            </Button>
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

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex-1">
          <TabsList variant="pill" scrollable>
            <TabsTrigger value="overview">{t("devices.tabOverview")}</TabsTrigger>
            <TabsTrigger value="conversations">{t("device.tabConversations")}</TabsTrigger>
            <TabsTrigger value="terminals">{t("devices.tabTerminals")}</TabsTrigger>
            <TabsTrigger value="files">{t("devices.tabFiles")}</TabsTrigger>
          </TabsList>

          {/* Overview: one column of plain sections (v2) */}
          <TabsContent value="overview" className="mt-6 space-y-8">
            <DeviceAgents
              tunnelManager={tunnelManager}
              device={tunnelDevice}
              online={online}
              state={deviceAgents}
              agents={agents}
              loading={!status && !deviceAgents.entries && !tunnelError}
              refreshing={info.loading}
              onRefresh={refresh}
              onOpenTerminal={() => {
                setNewTerminal(true)
                setTab("terminals")
              }}
            />

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
            <TerminalsPanel
              tunnelManager={tunnelManager}
              device={tunnelDevice}
              defaultCwd={status?.cwd || undefined}
              openNew={newTerminal}
              onNewOpened={() => setNewTerminal(false)}
            />
          </TabsContent>

          {/* Files */}
          <TabsContent value="files" className="mt-6 flex flex-col">
            <FileBrowser
              tunnelManager={tunnelManager}
              device={tunnelDevice}
              initialPath={searchParams.get("path") ?? undefined}
              layout="split"
              className="lg:min-h-[28rem] lg:flex-1"
            />
          </TabsContent>

        </Tabs>
      </PageContainer>

      <DeviceSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        section={settingsSection}
        onSection={setSettingsSection}
        name={device.name}
        tunnelManager={tunnelManager}
        device={tunnelDevice}
        encrypted={encrypted}
        trust={trust ?? null}
        fingerprint={fingerprint}
        settings={settings ?? null}
        details={details}
        onRename={async (next) => {
          if (!controlClient) return
          await controlClient.renameDevice(device.id, next)
          await refreshDevices()
        }}
        onSettings={(updated) => tunnelManager && deviceInfoCache.patchSettings(tunnelManager, device.id, updated)}
        onPair={() => setPairOpen(true)}
        onUnpin={() => removeLocalDeviceTrust(deviceId)}
        onDelete={() => setDeleteOpen(true)}
      />
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
