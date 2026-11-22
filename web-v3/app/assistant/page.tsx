"use client"

import { useSearchParams } from "next/navigation"
import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import {
  CloudIcon,
  FilePlus2Icon,
  FileTextIcon,
  KeyRoundIcon,
  LockIcon,
  LockOpenIcon,
  MessageSquareIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SparklesIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react"
import { toast } from "sonner"

import { PasswordInput } from "@/components/auth/password-input"
import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { DetailCard, type DetailItem } from "@/components/console/detail-list"
import { PageContainer, PageHeader } from "@/components/console/page-header"
import { formatBytes } from "@/components/conversation/text"
import { DropdownSelect } from "@/components/dropdown-select"
import { Field } from "@/components/field"
import { useI18n } from "@/components/i18n-provider"
import { FullPageSpinner } from "@/components/spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { AssistantPanel } from "@/components/workbench/assistant-panel"
import { WorkbenchShell } from "@/components/workbench/workbench-shell"
import {
  fetchDriveQuota,
  provisionBuiltInAssistantMcpToken,
} from "@/lib/api/control-http"
import { assessPassphraseStrength } from "@/lib/assistant/crypto"
import { startTokensConnect, type ModelFormat } from "@/lib/assistant/tokens"
import { useAssistant } from "@/lib/state/assistant-context"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { AssistantMcpServerConfig } from "@/lib/storage/idb"
import type { DriveQuotaView, McpScope } from "@/lib/types/v3"

const FORMAT_OPTIONS: readonly { value: ModelFormat; label: string }[] = [
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "openai-completions", label: "OpenAI Chat Completions" },
]

const THINKING_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const

const ALL_MCP_SCOPES: { scope: McpScope; label: string; defaultChecked: boolean }[] = [
  { scope: "devices:read", label: "devices:read", defaultChecked: true },
  { scope: "sessions:read", label: "sessions:read", defaultChecked: true },
  { scope: "sessions:write", label: "sessions:write", defaultChecked: true },
  { scope: "approvals:answer", label: "approvals:answer", defaultChecked: false },
]

function AssistantPageInner() {
  const searchParams = useSearchParams()
  const { t } = useI18n()
  const {
    activeAccount,
    devices,
    preferences,
    getFreshAccessToken,
    updatePreferences,
  } = useWorkbench()
  const {
    conversations,
    activeConversationId,
    selectConversation,
    startNewConversation,
    deleteConversation,
    syncing,
    syncNow,
    encryptionEnabled,
    envelope,
    encryptionUnlocked,
    enableEncryption,
    unlockEncryption,
    lockEncryption,
    changeEncryptionPassword,
    resetEncryption,
    disableEncryption,
    tokensStatus,
    tokensModels,
    disconnectTokens,
    activeModel,
    setActiveModel,
    vfsFiles,
    vfsSyncing,
    refreshVfs,
    writeVfsFile,
    readVfsFile,
    deleteVfsFile,
    syncVfsWithDrive,
  } = useAssistant()

  const queryTab = searchParams.get("tab")
  const [tabOverride, setTabOverride] = useState<{ query: string | null; value: string } | null>(
    null
  )
  const tab =
    tabOverride && tabOverride.query === queryTab
      ? tabOverride.value
      : queryTab && ["chat", "vfs", "config"].includes(queryTab)
        ? queryTab
        : "chat"
  const setTab = useCallback(
    (next: string) => setTabOverride({ query: queryTab, value: next }),
    [queryTab]
  )

  // VFS state
  const [selectedVfsPath, setSelectedVfsPath] = useState<string | null>(null)
  const [vfsContent, setVfsContent] = useState("")
  const [newVfsPath, setNewVfsPath] = useState("")
  const [savingVfs, setSavingVfs] = useState(false)
  const [driveQuota, setDriveQuota] = useState<DriveQuotaView | null>(null)

  const loadQuota = useCallback(async () => {
    if (!activeAccount) return
    try {
      const tok = await getFreshAccessToken()
      setDriveQuota(await fetchDriveQuota(activeAccount.serverUrl, tok))
    } catch {
      setDriveQuota(null)
    }
  }, [activeAccount, getFreshAccessToken])

  useEffect(() => {
    if (tab !== "vfs") return
    let active = true
    ;(async () => {
      await refreshVfs()
      if (!active) return
      await loadQuota()
    })()
    return () => {
      active = false
    }
  }, [loadQuota, refreshVfs, tab])

  const openVfsFile = async (path: string) => {
    try {
      const content = await readVfsFile(path)
      setSelectedVfsPath(path)
      setVfsContent(content)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSaveVfs = async () => {
    const target = selectedVfsPath || newVfsPath.trim()
    if (!target) return
    setSavingVfs(true)
    try {
      const saved = await writeVfsFile(target, vfsContent)
      setSelectedVfsPath(saved.path)
      setNewVfsPath("")
      toast.success(t("common.saved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingVfs(false)
    }
  }

  const handleSyncVfs = async () => {
    try {
      const res = await syncVfsWithDrive()
      if (!res.enabled) {
        toast.info(t("settings.driveDisabled"))
      } else {
        toast.success(`Synced: ↑${res.uploaded} / ↓${res.downloaded}`)
        await loadQuota()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  // BYOK form state
  const [byokFormat, setByokFormat] = useState<ModelFormat>(
    activeModel?.source === "byok" ? activeModel.format : "openai-completions"
  )
  const [byokBaseUrl, setByokBaseUrl] = useState(
    activeModel?.source === "byok" ? activeModel.baseUrl : ""
  )
  const [byokModel, setByokModel] = useState(
    activeModel?.source === "byok" ? activeModel.model : ""
  )
  const [byokApiKey, setByokApiKey] = useState(
    activeModel?.source === "byok" ? activeModel.apiKey ?? "" : ""
  )
  const [disconnectTokensOpen, setDisconnectTokensOpen] = useState(false)

  // MCP Mount Dialog & External MCP form
  const normalDevices = useMemo(
    () => devices.filter((d) => d.mode_hint !== "encrypted"),
    [devices]
  )
  const [mountOpen, setMountOpen] = useState(false)
  const [mountDeviceIds, setMountDeviceIds] = useState<string[]>([])
  const [mountScopes, setMountScopes] = useState<McpScope[]>([
    "devices:read",
    "sessions:read",
    "sessions:write",
  ])
  const [mountingAa, setMountingAa] = useState(false)

  const [extMcpName, setExtMcpName] = useState("")
  const [extMcpUrl, setExtMcpUrl] = useState("")
  const [extMcpToken, setExtMcpToken] = useState("")

  // Any-password E2EE state
  const [e2eePassword, setE2eePassword] = useState("")
  const [newE2eePassword, setNewE2eePassword] = useState("")
  const [resetNewPassword, setResetNewPassword] = useState("")
  const [resetOpen, setResetOpen] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)
  const [e2eeBusy, setE2eeBusy] = useState(false)

  const passphraseStrength = useMemo(
    () => assessPassphraseStrength(e2eePassword || newE2eePassword),
    [e2eePassword, newE2eePassword]
  )

  const handleConnectTokens = async () => {
    if (!tokensStatus?.tokens_url || !tokensStatus?.client_id) {
      toast.error("Tokens Anywhere is not configured on this server.")
      return
    }
    try {
      const url = await startTokensConnect({
        tokensUrl: tokensStatus.tokens_url,
        clientId: tokensStatus.client_id,
        returnTo: "/assistant?tab=config",
      })
      window.location.assign(url)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSaveByok = async () => {
    if (!byokBaseUrl.trim() || !byokModel.trim() || !byokApiKey.trim()) {
      toast.error("Fill in Base URL, model ID, and API key.")
      return
    }
    await setActiveModel({
      source: "byok",
      format: byokFormat,
      baseUrl: byokBaseUrl.trim().replace(/\/+$/, ""),
      model: byokModel.trim(),
      modelName: byokModel.trim(),
      apiKey: byokApiKey.trim(),
      thinking: activeModel?.thinking ?? "medium",
      webSearch: activeModel?.webSearch ?? false,
    })
    toast.success(t("common.saved"))
  }

  const handleMountAaMcp = async () => {
    if (!activeAccount || mountDeviceIds.length === 0 || mountScopes.length === 0) {
      toast.error("Select at least one normal device and scope.")
      return
    }
    setMountingAa(true)
    try {
      const token = await getFreshAccessToken()
      const provisioned = await provisionBuiltInAssistantMcpToken(activeAccount.serverUrl, token, {
        scopes: mountScopes,
        deviceIds: mountDeviceIds,
      })
      const entry: AssistantMcpServerConfig = {
        id: `aa-mcp-${Date.now()}`,
        name: "Agents Anywhere /mcp",
        url: provisioned.mcpUrl,
        token: provisioned.accessToken,
        enabled: true,
        isBuiltInAA: true,
      }
      const rest = preferences.assistantMcpServers.filter((s) => !s.isBuiltInAA)
      await updatePreferences({ assistantMcpServers: [entry, ...rest] })
      setMountOpen(false)
      toast.success(t("common.saved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setMountingAa(false)
    }
  }

  const handleAddExternalMcp = async () => {
    if (!extMcpName.trim() || !extMcpUrl.trim()) return
    const entry: AssistantMcpServerConfig = {
      id: `mcp-${Date.now()}`,
      name: extMcpName.trim(),
      url: extMcpUrl.trim(),
      token: extMcpToken.trim() || undefined,
      enabled: true,
    }
    await updatePreferences({
      assistantMcpServers: [...preferences.assistantMcpServers, entry],
    })
    setExtMcpName("")
    setExtMcpUrl("")
    setExtMcpToken("")
    toast.success(t("common.saved"))
  }

  const toggleMcpServer = async (id: string, enabled: boolean) => {
    await updatePreferences({
      assistantMcpServers: preferences.assistantMcpServers.map((s) =>
        s.id === id ? { ...s, enabled } : s
      ),
    })
  }

  const removeMcpServer = async (id: string) => {
    await updatePreferences({
      assistantMcpServers: preferences.assistantMcpServers.filter((s) => s.id !== id),
    })
  }

  const quotaDetails = useMemo<DetailItem[]>(() => {
    if (!driveQuota || !driveQuota.enabled) return []
    return [
      {
        key: "used",
        label: t("settings.allowanceDriveQuota"),
        value: `${formatBytes(driveQuota.used_bytes)} / ${
          driveQuota.quota_bytes != null
            ? formatBytes(driveQuota.quota_bytes)
            : t("common.unlimited")
        }`,
      },
      {
        key: "files",
        label: t("assistant.tabVfs"),
        value: `${driveQuota.file_count}`,
      },
      {
        key: "max_file",
        label: t("settings.allowanceMaxFile"),
        value:
          driveQuota.max_file_bytes != null
            ? formatBytes(driveQuota.max_file_bytes)
            : t("common.unlimited"),
      },
    ]
  }, [driveQuota, t])

  const tokenModelOptions = useMemo(
    () =>
      tokensModels.map((m) => ({
        value: m.id,
        label: `${m.name} (${m.format})`,
      })),
    [tokensModels]
  )

  return (
    <WorkbenchShell>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0 border-b border-border px-6 py-4">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <SparklesIcon className="size-5 text-foreground" />
              <div>
                <h1 className="font-heading text-lg font-semibold tracking-tight text-foreground">
                  {t("assistant.title")}
                </h1>
                <p className="text-xs text-muted-foreground">{t("assistant.subtitle")}</p>
              </div>
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
              <TabsList variant="pill">
                <TabsTrigger value="chat">{t("assistant.tabChat")}</TabsTrigger>
                <TabsTrigger value="vfs">{t("assistant.tabVfs")}</TabsTrigger>
                <TabsTrigger value="config">{t("assistant.tabConfig")}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        {/* Tab 1: Full-height Chat */}
        {tab === "chat" && (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
              <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                <Button size="sm" onClick={() => void startNewConversation()}>
                  <PlusIcon className="size-3.5" />
                  {t("assistant.newChat")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("assistant.syncNow")}
                  disabled={syncing}
                  onClick={() => void syncNow()}
                >
                  <RefreshCwIcon className={syncing ? "size-3.5 animate-spin" : "size-3.5"} />
                </Button>
              </div>
              <div className="flex-1 space-y-1 overflow-y-auto p-3">
                {conversations.length === 0 ? (
                  <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                    {t("assistant.emptyChats")}
                  </p>
                ) : (
                  conversations.map((conv) => (
                    <div
                      key={conv.id}
                      className={
                        conv.id === activeConversationId
                          ? "group flex items-center justify-between gap-1 rounded-xl bg-surface-raised px-3 py-2 text-xs text-foreground"
                          : "group flex items-center justify-between gap-1 rounded-xl px-3 py-2 text-xs text-muted-foreground hover:bg-surface-raised/60 hover:text-foreground"
                      }
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => selectConversation(conv.id)}
                      >
                        <MessageSquareIcon className="size-3.5 shrink-0" />
                        <span className="truncate">{conv.title}</span>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="opacity-0 group-hover:opacity-100"
                        onClick={() => void deleteConversation(conv.id)}
                      >
                        <Trash2Icon className="size-3" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </aside>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <AssistantPanel />
            </div>
          </div>
        )}

        {/* Tab 2: Cloud VFS Workspace */}
        {tab === "vfs" && (
          <div className="flex-1 overflow-y-auto">
            <PageContainer>
              <PageHeader
                title={t("assistant.tabVfs")}
                description="/workspace"
                actions={
                  <>
                    <Badge variant="secondary">
                      {encryptionEnabled && encryptionUnlocked ? (
                        <>
                          <LockIcon className="mr-1 size-3" />
                          {t("assistant.vfsEncrypted")}
                        </>
                      ) : (
                        t("assistant.vfsPlain")
                      )}
                    </Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={vfsSyncing}
                      onClick={() => void handleSyncVfs()}
                    >
                      <CloudIcon className="size-3.5" />
                      {vfsSyncing ? t("common.loading") : t("assistant.vfsSync")}
                    </Button>
                  </>
                }
              />

              {quotaDetails.length > 0 && <DetailCard items={quotaDetails} />}

              <div className="grid gap-6 lg:grid-cols-3">
                <div className="space-y-4 rounded-card bg-card p-5">
                  <div className="flex gap-2">
                    <Input
                      value={newVfsPath}
                      onChange={(e) => setNewVfsPath(e.target.value)}
                      placeholder="/workspace/notes.md"
                      className="font-mono text-xs"
                    />
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label={t("assistant.vfsNewFile")}
                      onClick={() => {
                        if (!newVfsPath.trim()) return
                        setSelectedVfsPath(newVfsPath.trim())
                        setVfsContent("")
                      }}
                    >
                      <FilePlus2Icon className="size-4" />
                    </Button>
                  </div>

                  {vfsFiles.length === 0 ? (
                    <p className="py-10 text-center text-xs text-muted-foreground">
                      {t("assistant.vfsEmpty")}
                    </p>
                  ) : (
                    <div className="divide-y divide-border">
                      {vfsFiles.map((f) => (
                        <div
                          key={f.path}
                          className="flex items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            onClick={() => void openVfsFile(f.path)}
                          >
                            <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                              <p className="truncate font-mono text-xs font-medium text-foreground">
                                {f.path}
                              </p>
                              <p className="text-[11px] text-muted-foreground">
                                {formatBytes(f.size)}
                              </p>
                            </div>
                          </button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => {
                              void deleteVfsFile(f.path)
                              if (selectedVfsPath === f.path) {
                                setSelectedVfsPath(null)
                                setVfsContent("")
                              }
                            }}
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-4 rounded-card bg-card p-5 lg:col-span-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-foreground">
                      {selectedVfsPath || newVfsPath || "/workspace/..."}
                    </span>
                    <Button
                      size="sm"
                      disabled={savingVfs || (!selectedVfsPath && !newVfsPath.trim())}
                      onClick={() => void handleSaveVfs()}
                    >
                      <SaveIcon className="size-3.5" />
                      {savingVfs ? t("common.saving") : t("common.save")}
                    </Button>
                  </div>
                  <Textarea
                    rows={16}
                    className="font-mono text-xs leading-relaxed"
                    value={vfsContent}
                    onChange={(e) => setVfsContent(e.target.value)}
                    placeholder="Select a file or type a new /workspace path on the left…"
                  />
                </div>
              </div>
            </PageContainer>
          </div>
        )}

        {/* Tab 3: Models, MCP & Any-Password E2EE */}
        {tab === "config" && (
          <div className="flex-1 overflow-y-auto">
            <PageContainer>
              {/* Tokens Anywhere */}
              <section className="space-y-5 rounded-card bg-card p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <h2 className="text-lg font-semibold tracking-tight">Tokens Anywhere</h2>
                    <p className="text-sm text-muted-foreground">
                      {t("assistant.tokensSharedNote")}
                    </p>
                  </div>
                  {tokensStatus?.connected ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDisconnectTokensOpen(true)}
                    >
                      {t("common.disconnect")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={!tokensStatus?.tokens_url || !tokensStatus?.client_id}
                      onClick={() => void handleConnectTokens()}
                    >
                      <KeyRoundIcon className="size-3.5" />
                      {t("assistant.connectTokens")}
                    </Button>
                  )}
                </div>

                {tokensStatus?.connected && (
                  <div className="space-y-4 border-t border-border pt-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="default">{t("assistant.tokensConnected")}</Badge>
                      {tokensStatus.prefix && (
                        <span className="font-mono">{tokensStatus.prefix}…</span>
                      )}
                    </div>

                    {tokenModelOptions.length > 0 && (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Model">
                          <DropdownSelect
                            value={activeModel?.model ?? tokenModelOptions[0].value}
                            options={tokenModelOptions}
                            label="Select Tokens model"
                            onChange={(id) => {
                              const picked = tokensModels.find((m) => m.id === id)
                              if (!picked) return
                              void setActiveModel({
                                source: "tokens",
                                format: picked.format,
                                baseUrl: picked.baseUrl,
                                model: picked.id,
                                modelName: picked.name,
                                thinking: activeModel?.thinking ?? "medium",
                                webSearch: activeModel?.webSearch ?? false,
                              })
                              toast.success(t("common.saved"))
                            }}
                          />
                        </Field>
                        <Field label="Thinking effort">
                          <DropdownSelect
                            value={activeModel?.thinking ?? "medium"}
                            options={THINKING_OPTIONS}
                            label="Thinking effort"
                            onChange={(level) => {
                              if (!activeModel) return
                              void setActiveModel({ ...activeModel, thinking: level })
                            }}
                          />
                        </Field>
                      </div>
                    )}

                    {activeModel && (
                      <div className="flex items-center justify-between gap-4 pt-1">
                        <span className="text-sm text-foreground">{t("assistant.webSearch")}</span>
                        <Switch
                          checked={Boolean(activeModel.webSearch)}
                          onCheckedChange={(checked) =>
                            void setActiveModel({ ...activeModel, webSearch: Boolean(checked) })
                          }
                        />
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Local BYOK Fallback */}
              <section className="space-y-4 rounded-card bg-card p-6">
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold tracking-tight">
                    {t("assistant.byokTitle")}
                  </h2>
                  <p className="text-sm text-muted-foreground">{t("assistant.byokDesc")}</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Protocol">
                    <DropdownSelect
                      value={byokFormat}
                      options={FORMAT_OPTIONS}
                      onChange={setByokFormat}
                      label="Protocol"
                    />
                  </Field>
                  <Field label="Model ID">
                    <Input
                      value={byokModel}
                      onChange={(e) => setByokModel(e.target.value)}
                      placeholder="claude-sonnet-4-5 / gpt-4.1"
                    />
                  </Field>
                  <Field label="Base URL">
                    <Input
                      value={byokBaseUrl}
                      onChange={(e) => setByokBaseUrl(e.target.value)}
                      placeholder="https://api.example.com/v1"
                    />
                  </Field>
                  <Field label="API Key">
                    <PasswordInput
                      value={byokApiKey}
                      onChange={(e) => setByokApiKey(e.target.value)}
                      placeholder="sk-..."
                      showLabel={t("common.showPassword")}
                      hideLabel={t("common.hidePassword")}
                    />
                  </Field>
                </div>
                <Button variant="outline" size="sm" onClick={() => void handleSaveByok()}>
                  {t("common.save")}
                </Button>
              </section>

              {/* MCP Tool Servers (including One-click AA `/mcp` mount) */}
              <section className="space-y-5 rounded-card bg-card p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                      <WrenchIcon className="size-4" />
                      {t("assistant.mcpTitle")}
                    </h2>
                    <p className="text-sm text-muted-foreground">{t("assistant.mcpDesc")}</p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      setMountDeviceIds(normalDevices.map((d) => d.id))
                      setMountScopes(["devices:read", "sessions:read", "sessions:write"])
                      setMountOpen(true)
                    }}
                  >
                    <PlugIcon className="size-3.5" />
                    {t("assistant.mountAaMcp")}
                  </Button>
                </div>

                {preferences.assistantMcpServers.length > 0 && (
                  <div className="divide-y divide-border border-t border-border pt-2">
                    {preferences.assistantMcpServers.map((srv) => (
                      <div
                        key={srv.id}
                        className="flex flex-wrap items-center justify-between gap-3 py-3"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-foreground">{srv.name}</p>
                            {srv.isBuiltInAA && <Badge variant="secondary">AA /mcp</Badge>}
                          </div>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {srv.url}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={srv.enabled}
                            onCheckedChange={(checked) =>
                              void toggleMcpServer(srv.id, Boolean(checked))
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => void removeMcpServer(srv.id)}
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="space-y-3 border-t border-border pt-4">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("assistant.addExternalMcp")}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Input
                      value={extMcpName}
                      onChange={(e) => setExtMcpName(e.target.value)}
                      placeholder="Server name"
                    />
                    <Input
                      value={extMcpUrl}
                      onChange={(e) => setExtMcpUrl(e.target.value)}
                      placeholder="https://mcp.example.com/mcp"
                    />
                    <PasswordInput
                      value={extMcpToken}
                      onChange={(e) => setExtMcpToken(e.target.value)}
                      placeholder="Bearer token (optional)"
                      showLabel={t("common.showPassword")}
                      hideLabel={t("common.hidePassword")}
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!extMcpName.trim() || !extMcpUrl.trim()}
                    onClick={() => void handleAddExternalMcp()}
                  >
                    <PlusIcon className="size-3.5" />
                    {t("assistant.addExternalMcp")}
                  </Button>
                </div>
              </section>

              {/* Any-Password Cloud E2EE */}
              <section className="space-y-5 rounded-card bg-card p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                      {encryptionEnabled && encryptionUnlocked ? (
                        <LockOpenIcon className="size-4" />
                      ) : (
                        <LockIcon className="size-4" />
                      )}
                      {t("assistant.e2eeTitle")}
                    </h2>
                    <p className="text-sm text-muted-foreground">{t("assistant.e2eeDesc")}</p>
                  </div>
                  {encryptionEnabled && envelope && (
                    <Badge variant="secondary">
                      v{envelope.key_version} · epoch {envelope.dek_epoch}
                    </Badge>
                  )}
                </div>

                {!encryptionEnabled ? (
                  <div className="space-y-3 border-t border-border pt-4">
                    <Field label={t("signIn.passwordLabel")}>
                      <PasswordInput
                        value={e2eePassword}
                        onChange={(e) => setE2eePassword(e.target.value)}
                        placeholder={t("signIn.passwordPlaceholder")}
                        showLabel={t("common.showPassword")}
                        hideLabel={t("common.hidePassword")}
                      />
                    </Field>
                    {e2eePassword.length > 0 && passphraseStrength === "short" && (
                      <p className="text-xs text-warning">{t("assistant.e2eeShortWarning")}</p>
                    )}
                    <Button
                      size="sm"
                      disabled={!e2eePassword || e2eeBusy}
                      onClick={async () => {
                        setE2eeBusy(true)
                        try {
                          await enableEncryption(e2eePassword)
                          setE2eePassword("")
                          toast.success(t("common.saved"))
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : String(err))
                        } finally {
                          setE2eeBusy(false)
                        }
                      }}
                    >
                      {t("assistant.e2eeEnable")}
                    </Button>
                  </div>
                ) : !encryptionUnlocked ? (
                  <div className="space-y-3 border-t border-border pt-4">
                    <p className="text-xs text-warning">{t("assistant.e2eeLockedBanner")}</p>
                    <div className="flex flex-wrap gap-2">
                      <div className="min-w-60 flex-1">
                        <PasswordInput
                          value={e2eePassword}
                          onChange={(e) => setE2eePassword(e.target.value)}
                          placeholder={t("signIn.passwordPlaceholder")}
                          showLabel={t("common.showPassword")}
                          hideLabel={t("common.hidePassword")}
                        />
                      </div>
                      <Button
                        size="sm"
                        disabled={!e2eePassword || e2eeBusy}
                        onClick={async () => {
                          setE2eeBusy(true)
                          try {
                            await unlockEncryption(e2eePassword)
                            setE2eePassword("")
                            toast.success(t("common.saved"))
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : String(err))
                          } finally {
                            setE2eeBusy(false)
                          }
                        }}
                      >
                        {t("assistant.e2eeUnlock")}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setResetOpen(true)}
                      >
                        {t("assistant.e2eeReset")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 border-t border-border pt-4">
                    <div className="flex flex-wrap gap-2">
                      <div className="min-w-60 flex-1">
                        <PasswordInput
                          value={newE2eePassword}
                          onChange={(e) => setNewE2eePassword(e.target.value)}
                          placeholder={t("assistant.e2eeChangePassword")}
                          showLabel={t("common.showPassword")}
                          hideLabel={t("common.hidePassword")}
                        />
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!newE2eePassword || e2eeBusy}
                        onClick={async () => {
                          setE2eeBusy(true)
                          try {
                            await changeEncryptionPassword(newE2eePassword)
                            setNewE2eePassword("")
                            toast.success(t("common.saved"))
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : String(err))
                          } finally {
                            setE2eeBusy(false)
                          }
                        }}
                      >
                        {t("assistant.e2eeChangePassword")}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void lockEncryption()}>
                        {t("assistant.e2eeLock")}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setDisableOpen(true)}
                      >
                        {t("common.disable")}
                      </Button>
                    </div>
                    {newE2eePassword.length > 0 && passphraseStrength === "short" && (
                      <p className="text-xs text-warning">{t("assistant.e2eeShortWarning")}</p>
                    )}
                  </div>
                )}
              </section>
            </PageContainer>
          </div>
        )}
      </div>

      {/* One-click mount AA /mcp Dialog */}
      <Dialog open={mountOpen} onOpenChange={setMountOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("assistant.mountAaMcp")}</DialogTitle>
            <DialogDescription>{t("assistant.mountAaMcpDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{t("devices.title")}</p>
              {normalDevices.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("devices.empty")}</p>
              ) : (
                normalDevices.map((dev) => {
                  const checked = mountDeviceIds.includes(dev.id)
                  return (
                    <label
                      key={dev.id}
                      className="flex cursor-pointer items-center gap-2.5 text-sm"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) =>
                          setMountDeviceIds((prev) =>
                            v ? [...new Set([...prev, dev.id])] : prev.filter((id) => id !== dev.id)
                          )
                        }
                      />
                      <span>{dev.name}</span>
                    </label>
                  )
                })
              )}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Scopes</p>
              {ALL_MCP_SCOPES.map(({ scope, label }) => {
                const checked = mountScopes.includes(scope)
                return (
                  <label key={scope} className="flex cursor-pointer items-center gap-2.5 text-xs">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) =>
                        setMountScopes((prev) =>
                          v ? [...new Set([...prev, scope])] : prev.filter((s) => s !== scope)
                        )
                      }
                    />
                    <span className="font-mono">{label}</span>
                  </label>
                )
              })}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMountOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={mountingAa} onClick={() => void handleMountAaMcp()}>
              {mountingAa ? t("common.loading") : t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect Tokens Confirm */}
      <ConfirmDialog
        open={disconnectTokensOpen}
        onOpenChange={setDisconnectTokensOpen}
        title={t("common.disconnect")}
        description={t("assistant.tokensSharedNote")}
        confirmLabel={t("common.disconnect")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={async () => {
          await disconnectTokens()
          setDisconnectTokensOpen(false)
          toast.success(t("common.saved"))
        }}
      />

      {/* Forgot Password & Reset Encryption */}
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t("assistant.e2eeReset")}
        description={t("assistant.e2eeResetConfirm")}
        confirmLabel={t("common.confirm")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={async () => {
          await resetEncryption(resetNewPassword || undefined)
          setResetNewPassword("")
          setResetOpen(false)
          toast.success(t("common.saved"))
        }}
      >
        <div className="py-2">
          <Field label={`${t("signIn.passwordLabel")} (optional new password)`}>
            <PasswordInput
              value={resetNewPassword}
              onChange={(e) => setResetNewPassword(e.target.value)}
              placeholder={t("signIn.passwordPlaceholder")}
              showLabel={t("common.showPassword")}
              hideLabel={t("common.hidePassword")}
            />
          </Field>
        </div>
      </ConfirmDialog>

      {/* Disable Encryption */}
      <ConfirmDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title={t("common.disable")}
        description={t("assistant.e2eeResetConfirm")}
        confirmLabel={t("common.disable")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={async () => {
          await disableEncryption(true)
          setDisableOpen(false)
          toast.success(t("common.saved"))
        }}
      />
    </WorkbenchShell>
  )
}

export default function AssistantPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <AssistantPageInner />
    </Suspense>
  )
}
