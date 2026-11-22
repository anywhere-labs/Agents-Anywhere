"use client"

// A device (client-experience-proposal §2.3): Overview (status, platform and version, mode and lock, its agents with
// a way to start a conversation with each, recent conversations), Conversations (all of them by agent / project, with
// a filter), Terminals, Files (browse and preview, git status and diff) and Security (pairing and paired clients on
// encrypted devices; the MCP switch on normal ones), plus rename / delete. Device management follows v2 web-next's
// device page; runtime availability states are not reported by v3 Connectors yet.
import Link from "next/link"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import {
  ActivityIcon,
  BotIcon,
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
import { DetailCard, type DetailItem } from "@/components/console/detail-list"
import { PageContainer } from "@/components/console/page-header"
import { useI18n } from "@/components/i18n-provider"
import { FullPageSpinner } from "@/components/spinner"
import { TerminalsPanel } from "@/components/terminal/terminals-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { E2eeLockBadge } from "@/components/workbench/e2ee-lock-badge"
import { FileBrowser } from "@/components/workbench/file-browser"
import { PairDeviceDialog } from "@/components/workbench/pair-device-dialog"
import { PLATFORM_ICON } from "@/components/workbench/workbench-sidebar"
import { WorkbenchShell } from "@/components/workbench/workbench-shell"
import { formatKeyFingerprint } from "@/lib/mesh/pairing"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { PairedClientEntry, SessionSummary } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { deviceInfoCache, useDevice } from "@/lib/workbench/device-info"
import { formatSize, shortAgo } from "@/lib/workbench/time"
import {
  agentLabel,
  buildDeviceTree,
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

function SessionRow({ s, deviceId }: { s: SessionSummary; deviceId: string }) {
  const { t, locale } = useI18n()
  return (
    <Link
      href={sessionHref(deviceId, s.id)}
      className="flex items-center justify-between gap-4 rounded-full px-3 py-2.5 transition-colors hover:bg-surface-hover"
    >
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground">{s.title || t("wb.untitled")}</p>
        <p className="truncate text-xs text-muted-foreground">
          {agentLabel(s.agent)} · <span className="font-mono">{tildePath(s.cwd)}</span>
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
        {s.state === "running" && <Badge variant="secondary">{t("sessions.stateRunning")}</Badge>}
        {s.state === "waiting" && <Badge variant="warning">{t("sessions.stateWaiting")}</Badge>}
        {s.state === "error" && <Badge variant="destructive">{t("sessions.stateError")}</Badge>}
        {shortAgo(s.updated_at, locale)}
      </span>
    </Link>
  )
}

function DeviceWorkbenchPageInner() {
  const params = useParams<{ deviceId: string }>()
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

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameText, setRenameText] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [unpinOpen, setUnpinOpen] = useState(false)
  const [fingerprintState, setFingerprintState] = useState<{ pub: string; fp: string } | null>(null)
  const [pairedClients, setPairedClients] = useState<PairedClientEntry[]>([])
  const [generatedPairing, setGeneratedPairing] = useState<{ uri: string; expires_at: string } | null>(null)

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
  // Agents: what the device reports, plus agents it has conversations with (an agent may have been removed since).
  const agents = useMemo(() => {
    const ids = new Set([...(status?.runtimes ?? []).map((r) => r.id), ...tree.map((a) => a.agent)])
    return [...ids].map((id) => ({
      id,
      name: agentLabel(id, status?.runtimes),
      reported: Boolean(status?.runtimes.some((r) => r.id === id)),
      count: tree.find((a) => a.agent === id)?.count ?? 0,
    }))
  }, [status?.runtimes, tree])

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

  const Icon = PLATFORM_ICON[device.platform] ?? LaptopIcon
  const online = device.presence === "online"

  return (
    <div className="flex-1 overflow-y-auto">
      <PageContainer className="gap-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Icon className="size-7 shrink-0 stroke-[1.5] text-muted-foreground" />
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-center gap-2 font-heading text-2xl font-semibold tracking-tight">
                <span className="truncate">{device.name}</span>
                {encrypted && <E2eeLockBadge paired={Boolean(trust)} compact />}
              </h1>
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", online ? "bg-success" : "bg-muted-foreground/40")} />
                {online ? t("devices.online") : t("device.offlineCached")}
                {status?.hostname && <span className="truncate">· {status.hostname}</span>}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!online}
              render={<Link href={`/new?device=${encodeURIComponent(device.id)}`} />}
              nativeButton={false}
            >
              <PlusIcon className="size-3.5" />
              {t("wb.newConversation")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={info.loading || !online}
              onClick={() => {
                void reload()
                void call(async () => {
                  if (!controlClient) return
                  const res = await controlClient.pingDevice(device.id)
                  toast.success(t("devices.pingOk", { time: res.server_time }))
                })
              }}
            >
              {info.loading ? <RefreshCwIcon className="size-3.5 animate-spin" /> : <ActivityIcon className="size-3.5" />}
              {t("common.refresh")}
            </Button>
          </div>
        </div>

        {tunnelError?.code === "e2e_not_paired" && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-card bg-card p-5">
            <div className="flex items-start gap-3">
              <LockIcon className="mt-0.5 size-5 shrink-0 text-warning" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{t("devices.unpaired")}</p>
                <p className="text-xs text-muted-foreground">{t("devices.unpairedHint")}</p>
              </div>
            </div>
            <Button size="sm" onClick={() => setPairOpen(true)}>
              {t("devices.pair")}
            </Button>
          </div>
        )}
        {tunnelError && tunnelError.code !== "e2e_not_paired" && (
          <p className="rounded-2xl bg-card px-4 py-3 text-xs text-destructive">
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

          {/* Overview */}
          <TabsContent value="overview" className="mt-6 space-y-6">
            <section className="space-y-3 rounded-card bg-card p-6">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold tracking-tight">{t("device.agents")}</h2>
                <p className="text-sm text-muted-foreground">{t("device.agentsHint")}</p>
              </div>
              {!online ? (
                <p className="text-sm text-muted-foreground">{t("newConv.offline")}</p>
              ) : !status && !tunnelError ? (
                <p className="text-sm text-muted-foreground">{t("newConv.loadingAgents")}</p>
              ) : agents.length === 0 ? (
                <div className="space-y-1 rounded-2xl bg-background p-4">
                  <p className="text-sm font-medium text-foreground">{t("newConv.noAgents")}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">{t("newConv.noAgentsHint")}</p>
                </div>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {agents.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 rounded-2xl bg-background px-4 py-3">
                      <BotIcon className="size-5 shrink-0 stroke-[1.5] text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{a.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {t("device.agentConversations", { count: a.count })}
                          {!a.reported && ` · ${t("device.agentNotReported")}`}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!a.reported}
                        render={
                          <Link
                            href={`/new?device=${encodeURIComponent(device.id)}&agent=${encodeURIComponent(a.id)}`}
                          />
                        }
                        nativeButton={false}
                      >
                        {t("device.agentStart")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {agents.length > 0 && (
                <p className="text-[11px] text-muted-foreground">{t("device.agentAvailabilityUnknown")}</p>
              )}
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              <DetailCard title={t("devices.tabOverview")} items={details} />
              <section className="space-y-2 rounded-card bg-card p-6">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold tracking-tight">{t("device.recent")}</h2>
                  {deviceSessions.length > 5 && (
                    <Button variant="ghost" size="xs" onClick={() => setTab("conversations")}>
                      {t("wb.showAll", { count: deviceSessions.length })}
                    </Button>
                  )}
                </div>
                {deviceSessions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("wb.deviceNoConversations")}</p>
                ) : (
                  <div className="-mx-3 flex flex-col">
                    {deviceSessions.slice(0, 5).map((s) => (
                      <SessionRow key={s.id} s={s} deviceId={device.id} />
                    ))}
                  </div>
                )}
              </section>
            </div>

            <section className="flex flex-wrap items-center justify-between gap-4 rounded-card bg-card p-6">
              <div className="space-y-1">
                <h2 className="text-base font-semibold">{t("device.manage")}</h2>
                <p className="text-xs text-muted-foreground">{t("devices.deleteConfirmDesc")}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRenameText(device.name)
                    setRenameOpen(true)
                  }}
                >
                  <PencilIcon className="size-3.5" />
                  {t("devices.rename")}
                </Button>
                <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
                  <Trash2Icon className="size-3.5" />
                  {t("common.delete")}
                </Button>
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
              <p className="rounded-card bg-card p-8 text-center text-sm text-muted-foreground">
                {deviceSessions.length ? t("device.noMatches") : t("wb.deviceNoConversations")}
              </p>
            ) : (
              filteredTree.map((a) => (
                <section key={a.agent} className="space-y-3 rounded-card bg-card p-5">
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <BotIcon className="size-4 text-muted-foreground" />
                    {agentLabel(a.agent, status?.runtimes)}
                    <span className="font-normal text-muted-foreground tabular-nums">{a.count}</span>
                  </h2>
                  {a.projects.map((p) => (
                    <div key={p.key} className="space-y-1">
                      <p className="flex items-center gap-1.5 px-3 text-xs text-muted-foreground" title={p.cwd}>
                        <FolderIcon className="size-3.5" />
                        {p.name}
                        <span className="truncate font-mono text-[11px] opacity-70">{tildePath(p.cwd)}</span>
                      </p>
                      <div className="-mx-1 flex flex-col">
                        {p.sessions.map((s) => (
                          <SessionRow key={s.id} s={s} deviceId={device.id} />
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
                  <p className="text-xs leading-relaxed text-muted-foreground">{t("devices.allowMcpDesc")}</p>
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
                  <h3 className="flex items-center gap-2 text-lg font-semibold">
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
                        const res = await tunnelManager.createPairing(tunnelDevice, { platform: "web" })
                        setGeneratedPairing({ uri: res.uri, expires_at: res.expires_at })
                      })
                    }
                  >
                    {t("devices.createPairingLink")}
                  </Button>
                </div>
                {generatedPairing && (
                  <CopyableValue
                    label={t("device.pairingLinkExpires", {
                      time: new Date(generatedPairing.expires_at).toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : "en-US"),
                    })}
                    value={generatedPairing.uri}
                    copyLabel={t("common.copy")}
                    copyFailedLabel={t("common.copyFailed")}
                  />
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

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("devices.rename")}</DialogTitle>
          </DialogHeader>
          <form
            id="rename-device"
            onSubmit={(e) => {
              e.preventDefault()
              const next = renameText.trim()
              if (!next || !controlClient) return
              void call(async () => {
                await controlClient.renameDevice(device.id, next)
                await refreshDevices()
                setRenameOpen(false)
              }, t("common.saved"))
            }}
          >
            <Input autoFocus value={renameText} onChange={(e) => setRenameText(e.target.value)} aria-label={t("devices.deviceName")} />
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" form="rename-device">
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PairDeviceDialog
        open={pairOpen}
        onOpenChange={(open) => {
          setPairOpen(open)
          if (!open) void reload()
        }}
        deviceNameHint={device.name}
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
    <WorkbenchShell>
      <Suspense fallback={<FullPageSpinner />}>
        <DeviceWorkbenchPageInner />
      </Suspense>
    </WorkbenchShell>
  )
}
