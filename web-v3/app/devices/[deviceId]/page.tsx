"use client"

import Link from "next/link"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIcon,
  ArrowUpIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  KeyRoundIcon,
  LaptopIcon,
  LoaderCircleIcon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react"
import type { RpcDuplex } from "meshcall/web"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { CopyableValue } from "@/components/console/copyable-value"
import { DetailCard, type DetailItem } from "@/components/console/detail-list"
import { PageContainer, PageHeader } from "@/components/console/page-header"
import { DropdownSelect } from "@/components/dropdown-select"
import { Field } from "@/components/field"
import { useI18n } from "@/components/i18n-provider"
import { FullPageSpinner } from "@/components/spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { E2eeLockBadge } from "@/components/workbench/e2ee-lock-badge"
import { PairDeviceDialog } from "@/components/workbench/pair-device-dialog"
import { WorkbenchShell } from "@/components/workbench/workbench-shell"
import type { TerminalInputFrame, TerminalOutputFrame } from "@/lib/mesh/device-tunnel"
import { formatKeyFingerprint, PairingError } from "@/lib/mesh/pairing"
import { useWorkbench } from "@/lib/state/workbench-context"
import type {
  DeviceSettings,
  DeviceStatus,
  ListDirsResult,
  PairedClientEntry,
  ReadFileResult,
  TerminalInfo,
} from "@/lib/types/v3"

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToUtf8(b64: string): string {
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return b64
  }
}

function DeviceWorkbenchPageInner() {
  const params = useParams<{ deviceId: string }>()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { t } = useI18n()
  const {
    devices,
    deviceTrusts,
    sessions,
    controlClient,
    tunnelManager,
    refreshDevices,
    removeLocalDeviceTrust,
  } = useWorkbench()

  const deviceId = decodeURIComponent(params.deviceId ?? "")
  const device = useMemo(
    () => devices.find((d) => d.id === deviceId) ?? null,
    [devices, deviceId]
  )
  const trust = deviceTrusts[deviceId]
  const isEncrypted = device?.mode_hint === "encrypted" || Boolean(trust)
  const deviceSessions = useMemo(
    () => sessions.filter((s) => s.device_id === deviceId),
    [sessions, deviceId]
  )

  const initialTab = searchParams.get("tab") ?? "overview"
  const [tab, setTab] = useState(
    ["overview", "files", "terminals", "security"].includes(initialTab) ? initialTab : "overview"
  )

  // Overview state
  const [status, setStatus] = useState<DeviceStatus | null>(null)
  const [settings, setSettings] = useState<DeviceSettings | null>(null)
  const [tunnelError, setTunnelError] = useState<{ code: string; message: string } | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [renameDraft, setRenameDraft] = useState<string | null>(null)
  const renameText = renameDraft ?? device?.name ?? ""
  const setRenameText = setRenameDraft
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // New session form
  const [agentName, setAgentName] = useState("")
  const [sessionCwd, setSessionCwd] = useState("")
  const [sessionTitle, setSessionTitle] = useState("")
  const [creatingSession, setCreatingSession] = useState(false)

  // Files & Git state
  const [dirPath, setDirPath] = useState(searchParams.get("path") ?? "")
  const [dirListing, setDirListing] = useState<ListDirsResult | null>(null)
  const [fileView, setFileView] = useState<ReadFileResult | null>(null)
  const [gitDiff, setGitDiff] = useState<string | null>(null)
  const [gitInfo, setGitInfo] = useState<Record<string, unknown> | null>(null)
  const [loadingFiles, setLoadingFiles] = useState(false)

  // Terminals state
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [terminalOutput, setTerminalOutput] = useState("")
  const [terminalCommand, setTerminalCommand] = useState("")
  const duplexRef = useRef<RpcDuplex<TerminalInputFrame, TerminalOutputFrame> | null>(null)

  // Security & Pairing state
  const [pairOpen, setPairOpen] = useState(false)
  const [unpinOpen, setUnpinOpen] = useState(false)
  const [fingerprintState, setFingerprintState] = useState<{ pub: string; fp: string } | null>(null)
  const [pairedClients, setPairedClients] = useState<PairedClientEntry[]>([])
  const [generatedPairing, setGeneratedPairing] = useState<{
    uri: string
    expires_at: string
  } | null>(null)

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

  const fingerprint =
    trust?.device_pub && fingerprintState?.pub === trust.device_pub ? fingerprintState.fp : null

  const loadDeviceRuntime = useCallback(async () => {
    if (!device || !tunnelManager || device.presence === "offline") return
    setLoadingStatus(true)
    setTunnelError(null)
    try {
      const [st, cfg] = await Promise.all([
        tunnelManager.getDeviceStatus(device),
        tunnelManager.getDeviceSettings(device).catch(() => null),
      ])
      setStatus(st)
      setSettings(cfg)
      if (!agentName && st.runtimes.length > 0) {
        setAgentName(st.runtimes[0].id || st.runtimes[0].name)
      }
      if (!sessionCwd && st.cwd) {
        setSessionCwd(st.cwd)
      }
      if (st.mode === "encrypted" || isEncrypted) {
        const paired = await tunnelManager.listPairedClients(device).catch(() => ({ clients: [] }))
        setPairedClients(paired.clients)
      }
    } catch (err) {
      if (err instanceof PairingError) {
        setTunnelError({ code: err.code, message: err.message })
      } else {
        setTunnelError({
          code: "device_error",
          message: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      setLoadingStatus(false)
    }
  }, [agentName, device, isEncrypted, sessionCwd, tunnelManager])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void loadDeviceRuntime()
    })
    return () => {
      active = false
    }
  }, [loadDeviceRuntime])

  const loadDirectory = useCallback(
    async (targetPath?: string) => {
      if (!device || !tunnelManager || device.presence === "offline") return
      setLoadingFiles(true)
      try {
        const listing = await tunnelManager.listDirs(device, targetPath || undefined)
        setDirListing(listing)
        setDirPath(listing.path)
        setFileView(null)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setLoadingFiles(false)
      }
    },
    [device, tunnelManager]
  )

  const openFile = useCallback(
    async (path: string) => {
      if (!device || !tunnelManager) return
      setLoadingFiles(true)
      try {
        const res = await tunnelManager.readFile(device, path, { maxBytes: 128 * 1024 })
        setFileView(res)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setLoadingFiles(false)
      }
    },
    [device, tunnelManager]
  )

  const inspectGit = useCallback(async () => {
    if (!device || !tunnelManager || !dirPath) return
    setLoadingFiles(true)
    try {
      const [st, diff] = await Promise.all([
        tunnelManager.gitStatus(device, dirPath),
        tunnelManager.gitDiff(device, dirPath),
      ])
      setGitInfo(st)
      setGitDiff(diff.diff ?? "")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingFiles(false)
    }
  }, [device, dirPath, tunnelManager])

  const loadTerminals = useCallback(async () => {
    if (!device || !tunnelManager || device.presence === "offline") return
    try {
      const res = await tunnelManager.listTerminals(device)
      setTerminals(res.terminals)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [device, tunnelManager])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      if (tab === "files" && !dirListing && device?.presence === "online") {
        void loadDirectory(dirPath || undefined)
      } else if (tab === "terminals" && device?.presence === "online") {
        void loadTerminals()
      }
    })
    return () => {
      active = false
    }
  }, [device?.presence, dirListing, dirPath, loadDirectory, loadTerminals, tab])

  // Duplex terminal attachment
  useEffect(() => {
    if (!device || !tunnelManager || !activeTerminalId) return
    const abort = new AbortController()
    ;(async () => {
      setTerminalOutput("")
      try {
        const duplex = await tunnelManager.attachTerminal(device, activeTerminalId, abort.signal)
        duplexRef.current = duplex
        for await (const frame of duplex) {
          if (abort.signal.aborted) break
          if (frame.type === "output" && frame.data) {
            setTerminalOutput((prev) => (prev + base64ToUtf8(frame.data!)).slice(-48_000))
          } else if (frame.type === "exit") {
            setTerminalOutput((prev) => `${prev}\n[process exited: ${frame.exit_code ?? 0}]\n`)
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          toast.error(err instanceof Error ? err.message : String(err))
        }
      } finally {
        duplexRef.current = null
      }
    })()

    return () => {
      abort.abort()
      void duplexRef.current?.closeSend().catch(() => undefined)
      duplexRef.current = null
    }
  }, [activeTerminalId, device, tunnelManager])

  const sendTerminalLine = async () => {
    const duplex = duplexRef.current
    if (!duplex) return
    const line = `${terminalCommand}\n`
    setTerminalCommand("")
    try {
      await duplex.send({ type: "input", data: utf8ToBase64(line) })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handlePing = async () => {
    if (!controlClient || !device) return
    try {
      const res = await controlClient.pingDevice(device.id)
      toast.success(t("devices.pingOk", { time: res.server_time }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRename = async () => {
    if (!controlClient || !device || !renameText.trim()) return
    try {
      await controlClient.renameDevice(device.id, renameText.trim())
      await refreshDevices()
      toast.success(t("common.saved"))
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

  const handleCreateSession = async () => {
    if (!tunnelManager || !device || !agentName) return
    setCreatingSession(true)
    try {
      const created = await tunnelManager.createSession(device, {
        agent: agentName,
        cwd: sessionCwd.trim() || undefined,
        title: sessionTitle.trim() || undefined,
      })
      router.push(`/sessions/${encodeURIComponent(device.id)}/${encodeURIComponent(created.id)}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCreatingSession(false)
    }
  }

  const handleToggleMcp = async (checked: boolean) => {
    if (!tunnelManager || !device) return
    try {
      const updated = await tunnelManager.updateDeviceSettings(device, { allow_mcp: checked })
      setSettings(updated)
      toast.success(t("common.saved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCreateTerminal = async () => {
    if (!tunnelManager || !device) return
    try {
      const created = await tunnelManager.createTerminal(device, {
        cwd: dirPath || status?.cwd || undefined,
      })
      await loadTerminals()
      setActiveTerminalId(created.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCloseTerminal = async (termId: string) => {
    if (!tunnelManager || !device) return
    try {
      await tunnelManager.closeTerminal(device, termId)
      if (activeTerminalId === termId) setActiveTerminalId(null)
      await loadTerminals()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleGeneratePairing = async () => {
    if (!tunnelManager || !device) return
    try {
      const res = await tunnelManager.createPairing(device, { platform: "web" })
      setGeneratedPairing({ uri: res.uri, expires_at: res.expires_at })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const runtimeOptions = useMemo(
    () =>
      (status?.runtimes ?? []).map((r) => ({
        value: r.id || r.name,
        label: r.name,
      })),
    [status?.runtimes]
  )

  const deviceDetails = useMemo<DetailItem[]>(() => {
    if (!device) return []
    return [
      {
        key: "presence",
        label: t("devices.online"),
        value: device.presence === "online" ? t("devices.online") : t("devices.offline"),
      },
      {
        key: "platform",
        label: t("devices.platform"),
        value: status ? `${status.platform} / ${status.arch}` : device.platform,
      },
      {
        key: "mode",
        label: t("devices.mode"),
        value: isEncrypted ? t("devices.modeEncrypted") : t("devices.modeNormal"),
      },
      {
        key: "version",
        label: "Connector",
        value: status?.connector_version ?? device.connector_version ?? "—",
      },
    ]
  }, [device, isEncrypted, status, t])

  return (
    <WorkbenchShell>
      <div className="flex-1 overflow-y-auto">
        <PageContainer>
          {!device ? (
            <div className="rounded-card bg-card p-8 text-center">
              <LaptopIcon className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">{t("devices.empty")}</p>
              <Button variant="outline" size="sm" className="mt-4" render={<Link href="/" />}>
                {t("common.back")}
              </Button>
            </div>
          ) : (
            <>
              <PageHeader
                title={
                  <span className="inline-flex flex-wrap items-center gap-2.5">
                    <span>{device.name}</span>
                    <Badge variant={device.presence === "online" ? "default" : "secondary"}>
                      {device.presence === "online" ? t("devices.online") : t("devices.offline")}
                    </Badge>
                    {isEncrypted && <E2eeLockBadge paired={Boolean(trust)} />}
                  </span>
                }
                description={status?.hostname ?? device.id}
                actions={
                  <>
                    <Button variant="outline" size="sm" onClick={() => void handlePing()}>
                      <ActivityIcon className="size-3.5" />
                      Ping
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={loadingStatus}
                      onClick={() => void loadDeviceRuntime()}
                    >
                      <RefreshCwIcon
                        className={loadingStatus ? "size-3.5 animate-spin" : "size-3.5"}
                      />
                      {t("common.refresh")}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2Icon className="size-3.5" />
                      {t("common.delete")}
                    </Button>
                  </>
                }
              />

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

              <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
                <TabsList variant="pill">
                  <TabsTrigger value="overview">{t("devices.tabOverview")}</TabsTrigger>
                  <TabsTrigger value="files">{t("devices.tabFiles")}</TabsTrigger>
                  <TabsTrigger value="terminals">{t("devices.tabTerminals")}</TabsTrigger>
                  <TabsTrigger value="security">{t("devices.tabSecurity")}</TabsTrigger>
                </TabsList>

                {/* Overview Tab */}
                <TabsContent value="overview" className="mt-6 space-y-6">
                  <div className="grid gap-6 lg:grid-cols-2">
                    <DetailCard title={t("devices.tabOverview")} items={deviceDetails} />

                    {/* Launch New Session */}
                    <div className="space-y-4 rounded-card bg-card p-6">
                      <h3 className="text-lg font-semibold tracking-tight">
                        {t("devices.newSession")}
                      </h3>
                      {runtimeOptions.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          {device.presence === "offline"
                            ? t("sessions.staleCache")
                            : tunnelError?.message || t("common.loading")}
                        </p>
                      ) : (
                        <div className="space-y-4">
                          <Field label={t("sessions.agentLabel")}>
                            <DropdownSelect
                              value={agentName}
                              options={runtimeOptions}
                              onChange={setAgentName}
                              label={t("sessions.agentLabel")}
                            />
                          </Field>
                          <Field label={t("sessions.cwdLabel")}>
                            <Input
                              value={sessionCwd}
                              onChange={(e) => setSessionCwd(e.target.value)}
                              className="font-mono text-xs"
                              placeholder="/path/to/workspace"
                            />
                          </Field>
                          <Field label={t("sessions.titleLabel")}>
                            <Input
                              value={sessionTitle}
                              onChange={(e) => setSessionTitle(e.target.value)}
                              placeholder="Optional title"
                            />
                          </Field>
                          <Button
                            disabled={!agentName || creatingSession}
                            onClick={() => void handleCreateSession()}
                          >
                            {creatingSession && (
                              <LoaderCircleIcon className="size-4 animate-spin" />
                            )}
                            <PlusIcon className="size-4" />
                            {t("devices.newSession")}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Active Sessions on this Device */}
                  <div className="space-y-3 rounded-card bg-card p-6">
                    <h3 className="text-lg font-semibold tracking-tight">
                      {t("shell.navSessions")}
                    </h3>
                    {deviceSessions.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("sessions.empty")}</p>
                    ) : (
                      <div className="divide-y divide-border">
                        {deviceSessions.map((s) => (
                          <Link
                            key={s.id}
                            href={`/sessions/${encodeURIComponent(device.id)}/${encodeURIComponent(s.id)}`}
                            className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0 hover:opacity-80 transition-opacity"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-foreground">
                                {s.title || s.id}
                              </p>
                              <p className="truncate font-mono text-xs text-muted-foreground">
                                {s.agent} · {s.cwd}
                              </p>
                            </div>
                            <Badge variant={s.state === "running" ? "default" : "secondary"}>
                              {s.state}
                            </Badge>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Rename & MCP Switch */}
                  <div className="grid gap-6 lg:grid-cols-2">
                    <div className="space-y-4 rounded-card bg-card p-6">
                      <h3 className="text-base font-semibold">{t("devices.rename")}</h3>
                      <div className="flex gap-2">
                        <Input
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                        />
                        <Button variant="outline" onClick={() => void handleRename()}>
                          {t("common.save")}
                        </Button>
                      </div>
                    </div>

                    {settings && !isEncrypted && (
                      <div className="flex items-center justify-between gap-4 rounded-card bg-card p-6">
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-foreground">
                            {t("devices.allowMcp")}
                          </p>
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {t("devices.allowMcpDesc")}
                          </p>
                        </div>
                        <Switch
                          checked={settings.allow_mcp}
                          onCheckedChange={(checked) => void handleToggleMcp(Boolean(checked))}
                        />
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* Files & Git Tab */}
                <TabsContent value="files" className="mt-6 space-y-5">
                  <div className="flex flex-wrap items-center gap-2 rounded-card bg-card p-4">
                    <Input
                      value={dirPath}
                      onChange={(e) => setDirPath(e.target.value)}
                      className="flex-1 font-mono text-xs"
                      placeholder="/path/to/directory"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={loadingFiles}
                      onClick={() => void loadDirectory(dirPath)}
                    >
                      {t("common.refresh")}
                    </Button>
                    {dirListing?.parent && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void loadDirectory(dirListing.parent!)}
                      >
                        <ArrowUpIcon className="size-3.5" />
                        ..
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={loadingFiles || !dirPath}
                      onClick={() => void inspectGit()}
                    >
                      <GitBranchIcon className="size-3.5" />
                      Git Diff
                    </Button>
                  </div>

                  <div className="grid gap-6 lg:grid-cols-2">
                    <div className="space-y-2 rounded-card bg-card p-5">
                      <p className="font-mono text-xs text-muted-foreground">
                        {dirListing?.path ?? dirPath}
                      </p>
                      <div className="max-h-[460px] divide-y divide-border overflow-y-auto">
                        {(dirListing?.entries ?? []).map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            className="flex w-full items-center justify-between gap-2 py-2 text-left text-sm hover:opacity-80"
                            onClick={() =>
                              entry.is_dir
                                ? void loadDirectory(entry.path)
                                : void openFile(entry.path)
                            }
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              {entry.is_dir ? (
                                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                              ) : (
                                <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                              )}
                              <span className="truncate font-mono text-xs">{entry.name}</span>
                            </span>
                            {entry.size != null && !entry.is_dir && (
                              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                {entry.size} B
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3 rounded-card bg-card p-5">
                      {fileView ? (
                        <>
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-mono text-xs text-foreground">
                              {fileView.path}
                            </span>
                            <Badge variant="secondary">{fileView.size} B</Badge>
                          </div>
                          {fileView.encoding === "base64" ? (
                            <p className="text-xs text-muted-foreground">Binary file preview unavailable.</p>
                          ) : (
                            <pre className="max-h-[420px] overflow-auto rounded-xl bg-background p-4 font-mono text-xs leading-relaxed text-foreground">
                              {fileView.content ?? ""}
                            </pre>
                          )}
                        </>
                      ) : gitDiff !== null ? (
                        <>
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-foreground">Git Status & Diff</span>
                            {gitInfo && (
                              <Badge variant="secondary">
                                {gitInfo.is_repo ? "Git repo" : "Not a git repo"}
                              </Badge>
                            )}
                          </div>
                          <pre className="max-h-[420px] overflow-auto rounded-xl bg-background p-4 font-mono text-xs leading-relaxed text-foreground">
                            {gitDiff || "Working tree clean."}
                          </pre>
                        </>
                      ) : (
                        <p className="py-16 text-center text-sm text-muted-foreground">
                          Select a file to inspect its contents, or click Git Diff.
                        </p>
                      )}
                    </div>
                  </div>
                </TabsContent>

                {/* Terminals Tab */}
                <TabsContent value="terminals" className="mt-6 space-y-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">{t("devices.tabTerminals")}</p>
                    <Button size="sm" onClick={() => void handleCreateTerminal()}>
                      <PlusIcon className="size-3.5" />
                      {t("devices.createTerminal")}
                    </Button>
                  </div>

                  {terminals.length === 0 ? (
                    <div className="rounded-card bg-card p-10 text-center">
                      <TerminalIcon className="mx-auto size-7 text-muted-foreground" />
                      <p className="mt-3 text-sm text-muted-foreground">
                        {t("devices.noTerminals")}
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-5 lg:grid-cols-3">
                      <div className="space-y-2 rounded-card bg-card p-4">
                        {terminals.map((term) => (
                          <div
                            key={term.id}
                            className="flex items-center justify-between gap-2 rounded-xl bg-background px-3 py-2"
                          >
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() => setActiveTerminalId(term.id)}
                            >
                              <p className="truncate font-mono text-xs font-medium text-foreground">
                                {term.shell} · {term.id.slice(0, 8)}
                              </p>
                              <p className="truncate font-mono text-[11px] text-muted-foreground">
                                {term.cwd}
                              </p>
                            </button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => void handleCloseTerminal(term.id)}
                            >
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>

                      <div className="flex flex-col gap-3 rounded-card bg-card p-4 lg:col-span-2">
                        <pre className="min-h-[300px] max-h-[420px] flex-1 overflow-auto rounded-xl bg-background p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
                          {activeTerminalId
                            ? terminalOutput || "Connected. Type a command below…"
                            : "Select a terminal on the left to attach."}
                        </pre>
                        {activeTerminalId && (
                          <form
                            className="flex gap-2"
                            onSubmit={(e) => {
                              e.preventDefault()
                              void sendTerminalLine()
                            }}
                          >
                            <Input
                              value={terminalCommand}
                              onChange={(e) => setTerminalCommand(e.target.value)}
                              className="font-mono text-xs"
                              placeholder="$ ls -la"
                            />
                            <Button type="submit" size="sm">
                              Run
                            </Button>
                          </form>
                        )}
                      </div>
                    </div>
                  )}
                </TabsContent>

                {/* E2EE & Pairing Tab */}
                <TabsContent value="security" className="mt-6 space-y-6">
                  <div className="space-y-4 rounded-card bg-card p-6">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="space-y-1">
                        <h3 className="flex items-center gap-2 text-lg font-semibold">
                          <LockIcon className="size-4 text-muted-foreground" />
                          {t("devices.greyLockTitle")}
                        </h3>
                        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                          {t("devices.greyLockDesc")}
                        </p>
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
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setUnpinOpen(true)}
                          >
                            {t("common.delete")} Local Pin
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  {isEncrypted && trust && (
                    <div className="space-y-4 rounded-card bg-card p-6">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h3 className="text-base font-semibold">{t("devices.pairedClients")}</h3>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleGeneratePairing()}
                        >
                          {t("devices.createPairingLink")}
                        </Button>
                      </div>

                      {generatedPairing && (
                        <CopyableValue
                          label={`aa-pair://v1/... (expires ${generatedPairing.expires_at})`}
                          value={generatedPairing.uri}
                          copyLabel={t("common.copy")}
                          copyFailedLabel={t("common.copyFailed")}
                        />
                      )}

                      {pairedClients.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          {t("devices.noPairedClients")}
                        </p>
                      ) : (
                        <div className="divide-y divide-border">
                          {pairedClients.map((client) => (
                            <div
                              key={client.client_pub}
                              className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-foreground">
                                  {client.label || client.platform}
                                </p>
                                <p className="truncate font-mono text-xs text-muted-foreground">
                                  {client.client_pub}
                                </p>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={async () => {
                                  if (!tunnelManager) return
                                  await tunnelManager.revokePairedClient(device, client.client_pub)
                                  setPairedClients((prev) =>
                                    prev.filter((c) => c.client_pub !== client.client_pub)
                                  )
                                  toast.success(t("common.saved"))
                                }}
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
            </>
          )}
        </PageContainer>
      </div>

      <PairDeviceDialog
        open={pairOpen}
        onOpenChange={(open) => {
          setPairOpen(open)
          if (!open) void loadDeviceRuntime()
        }}
        deviceNameHint={device?.name}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("devices.deleteConfirmTitle", { name: device?.name ?? "" })}
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
        title={t("devices.unpaired")}
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
    </WorkbenchShell>
  )
}

export default function DeviceWorkbenchPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <DeviceWorkbenchPageInner />
    </Suspense>
  )
}
