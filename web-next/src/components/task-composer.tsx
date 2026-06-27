"use client"

import * as React from "react"
import { Monitor, ChevronDown, ArrowUp, Loader2, Check } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { CascadingSelector } from "@/components/cascading-selector"
import {
  AttachmentButton,
  AttachmentPreviewList,
  DragOverlay,
  useAttachments,
} from "@/components/attachment-input"
import { WorkspacePicker, type WorkspaceSelection } from "@/components/workspace-picker"
import { useWorkspace } from "@/components/workspace-context"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import { cn } from "@/lib/utils"
import {
  composerMenuOptions,
  effortFieldForModel,
  effectiveFieldValue,
  optionLabel,
  permissionLabelKey,
  type ComposerPermissionLabelKey,
  runtimeConfigFields,
  validEffortValue,
} from "@/features/dashboard/runtime-config"
import { readNewSessionPermissionMode } from "@/features/dashboard/new-session-preferences"
import type { RuntimeConfigSchema } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"

type ComposerPermissionMode = {
  id: "ask" | "full" | "readonly"
  labelKey: ComposerPermissionLabelKey
  approvalPolicy?: string
  sandbox?: string
}

const PERMISSION_MODES: [ComposerPermissionMode, ...ComposerPermissionMode[]] = [
  {
    id: "ask",
    labelKey: "askApproval",
    approvalPolicy: undefined,
    sandbox: undefined,
  },
  {
    id: "full",
    labelKey: "fullAccess",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
  {
    id: "readonly",
    labelKey: "readOnly",
    approvalPolicy: "on-request",
    sandbox: "read-only",
  },
]

const NEW_SESSION_PREFERENCE_KEY = "aa-new-session-preference-v1"
const TITLE_WRITE_MS = 58
const TITLE_ERASE_MS = 22
const CJK_TITLE_WRITE_MS = 96
const CJK_TITLE_ERASE_MS = 38
const TITLE_HOLD_MS = 15_000
const NEW_SESSION_TITLE_KEYS = [
  "typewriter.buildNext",
  "typewriter.startWhere",
  "typewriter.workOn",
  "typewriter.giveTask",
  "typewriter.startWorkspace",
  "typewriter.needsAttention",
  "typewriter.happenHere",
  "typewriter.rightDevice",
  "typewriter.pickWorkspace",
  "typewriter.nextChange",
  "typewriter.investigate",
  "typewriter.focusedSession",
  "typewriter.inspect",
  "typewriter.ideaToSession",
  "typewriter.chooseTarget",
  "typewriter.changingToday",
] as const

type NewSessionPreference = {
  connectorId: string
  agent: string
}

type NewSessionTitleKey = (typeof NEW_SESSION_TITLE_KEYS)[number]

export function TaskComposer() {
  const { session: authSession } = useAuth()
  const { connectors, openSession, upsertSession, refreshData } = useWorkspace()
  const t = useTranslations("dashboard.new")
  const typewriterTitles = React.useMemo(
    () => NEW_SESSION_TITLE_KEYS.map((key) => t(key as NewSessionTitleKey)),
    [t],
  )

  // Derive online connectors for the device picker
  const onlineConnectors = React.useMemo(
    () => connectors.filter((connector) => connector.status === "online" && attachedRuntimes(connector).length > 0),
    [connectors],
  )

  const deviceOptions = React.useMemo(
    () =>
      onlineConnectors.map((c) => ({
        id: c.id,
        label: c.name,
      })),
    [onlineConnectors],
  )
  const hasOnlineDevice = deviceOptions.length > 0

  const [selectedDevice, setSelectedDevice] = React.useState(deviceOptions[0]?.id ?? "")
  const selectedConnector =
    onlineConnectors.find((connector) => connector.id === selectedDevice) ??
    onlineConnectors[0] ??
    null
  const agentOptions = React.useMemo(
    () => selectedConnector ? attachedRuntimes(selectedConnector).map((runtime) => ({ id: runtime, label: runtimeLabel(runtime) })) : [],
    [selectedConnector],
  )

  const [selectedAgent, setSelectedAgent] = React.useState(agentOptions[0]?.id ?? "")
  const [selectedModel, setSelectedModel] = React.useState("")
  const [selectedReasoning, setSelectedReasoning] = React.useState("")
  const [approval, setApproval] = React.useState<(typeof PERMISSION_MODES)[number]["id"]>("ask")
  const [selectedPermissionMode, setSelectedPermissionMode] = React.useState("")
  const [workspace, setWorkspace] = React.useState<WorkspaceSelection | null>(null)
  const [prompt, setPrompt] = React.useState("")
  const [runtimeSchema, setRuntimeSchema] = React.useState<RuntimeConfigSchema | null>(null)
  const [runtimeSettings, setRuntimeSettings] = React.useState<Record<string, unknown>>({})
  const [runtimeConfigLoading, setRuntimeConfigLoading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [createTick, setCreateTick] = React.useState(0)
  const [preferenceLoaded, setPreferenceLoaded] = React.useState(false)
  const [preference, setPreference] = React.useState<NewSessionPreference | null>(null)
  const devicePreferenceAppliedRef = React.useRef(false)
  const agentPreferenceAppliedForDeviceRef = React.useRef<string | null>(null)

  const { attachments, isDragging, add, remove, clear, onDragEnter, onDragLeave, onDragOver, onDrop } =
    useAttachments()
  const typedTitle = useTypewriterTitle(typewriterTitles, creating)

  React.useEffect(() => {
    if (!creating) {
      setCreateTick(0)
      return
    }

    const tickTimer = window.setInterval(() => setCreateTick((tick) => tick + 1), 450)
    return () => window.clearInterval(tickTimer)
  }, [creating])

  React.useEffect(() => {
    setPreference(readNewSessionPreference())
    setPreferenceLoaded(true)
  }, [])

  React.useEffect(() => {
    if (deviceOptions.length === 0) {
      if (selectedDevice) setSelectedDevice("")
      return
    }

    if (preferenceLoaded && !devicePreferenceAppliedRef.current) {
      const preferredDevice = preference?.connectorId
      const fallbackDevice = deviceOptions[0]?.id ?? ""
      const nextDevice = preferredDevice && deviceOptions.some((option) => option.id === preferredDevice)
        ? preferredDevice
        : fallbackDevice
      devicePreferenceAppliedRef.current = true
      if (nextDevice !== selectedDevice) {
        setSelectedDevice(nextDevice)
      }
      return
    }

    if (!deviceOptions.some((option) => option.id === selectedDevice)) {
      setSelectedDevice(deviceOptions[0]?.id ?? "")
    }
  }, [deviceOptions, preference?.connectorId, preferenceLoaded, selectedDevice])

  React.useEffect(() => {
    setWorkspace(null)
  }, [selectedConnector?.id])

  React.useEffect(() => {
    const connectorId = selectedConnector?.id

    if (!connectorId || agentOptions.length === 0) {
      if (selectedAgent) setSelectedAgent("")
      return
    }

    if (
      preferenceLoaded &&
      preference?.connectorId === connectorId &&
      agentPreferenceAppliedForDeviceRef.current !== connectorId
    ) {
      const preferredAgent = preference.agent
      if (agentOptions.some((option) => option.id === preferredAgent)) {
        agentPreferenceAppliedForDeviceRef.current = connectorId
        if (preferredAgent !== selectedAgent) {
          setSelectedAgent(preferredAgent)
        }
        return
      }
      agentPreferenceAppliedForDeviceRef.current = connectorId
    }

    if (!agentOptions.some((option) => option.id === selectedAgent)) {
      setSelectedAgent(agentOptions[0]?.id ?? "")
    }
  }, [agentOptions, preference, preferenceLoaded, selectedAgent, selectedConnector?.id])

  React.useEffect(() => {
    if (!authSession?.accessToken || !selectedConnector || !selectedAgent) {
      setRuntimeSchema(null)
      setRuntimeSettings({})
      setRuntimeConfigLoading(false)
      return
    }
    let cancelled = false
    setRuntimeConfigLoading(true)
    setRuntimeSchema(null)
    setRuntimeSettings({})
    Promise.all([
      dashboardApi.getRuntimeConfigSchema(authSession.accessToken, selectedAgent),
      dashboardApi.getConnectorAgentSettings(authSession.accessToken, selectedConnector.id, selectedAgent),
      dashboardApi.getAgentDefaults(authSession.accessToken),
    ])
      .then(([schemaResponse, settingsResponse, defaultsResponse]) => {
        if (cancelled) return
        const userDefaultSettings = defaultsResponse.runtimes[selectedAgent]?.settings ?? {}
        const localPermissionMode = readNewSessionPermissionMode()
        setRuntimeSchema(schemaResponse.schema)
        setRuntimeSettings({
          ...(settingsResponse.runtimeSettings ?? settingsResponse.settings ?? {}),
          ...(localPermissionMode
            ? { permissionMode: localPermissionMode }
            : typeof userDefaultSettings.permissionMode === "string"
              ? { permissionMode: userDefaultSettings.permissionMode }
            : {}),
        })
      })
      .catch(() => {
        if (cancelled) return
        setRuntimeSchema(null)
        setRuntimeSettings({})
      })
      .finally(() => {
        if (!cancelled) setRuntimeConfigLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [authSession?.accessToken, selectedAgent, selectedConnector])

  const runtimeFields = React.useMemo(
    () => runtimeConfigFields(runtimeSchema, runtimeSettings, "session"),
    [runtimeSchema, runtimeSettings],
  )
  const modelField = runtimeFields.find((field) => field.key === "model")
  const permissionField = runtimeFields.find((field) => field.key === "permissionMode")
  const rawEffortField = runtimeFields.find((field) => field.key === "effort")
  const effortField = effortFieldForModel(
    modelField,
    rawEffortField,
    selectedModel || runtimeSettings.model,
  )
  const effortFieldFor = (model: string) => effortFieldForModel(
    modelField,
    rawEffortField,
    model,
  )
  const models = composerMenuOptions(modelField)
  const permissionOptions = composerMenuOptions(permissionField)
  const reasoningOptions = composerMenuOptions(effortField)

  React.useEffect(() => {
    const nextModel = effectiveFieldValue(modelField, runtimeSettings.model)
    setSelectedModel((current) => current && models.some((option) => option.id === current) ? current : nextModel)
  }, [modelField, models, runtimeSettings.model])

  React.useEffect(() => {
    const nextPermissionMode = effectiveFieldValue(permissionField, runtimeSettings.permissionMode)
    setSelectedPermissionMode((current) =>
      current && permissionOptions.some((option) => option.id === current) ? current : nextPermissionMode,
    )
  }, [permissionField, permissionOptions, runtimeSettings.permissionMode])

  React.useEffect(() => {
    const nextEffort = effectiveFieldValue(effortField, runtimeSettings.effort)
    setSelectedReasoning((current) =>
      current && reasoningOptions.some((option) => option.id === current) ? current : nextEffort,
    )
  }, [effortField, reasoningOptions, runtimeSettings.effort])

  React.useEffect(() => {
    setSelectedReasoning((current) => {
      if (!current) return current
      return reasoningOptions.some((option) => option.id === current) ? current : ""
    })
  }, [reasoningOptions])

  const approvalMode = PERMISSION_MODES.find((o) => o.id === approval) ?? PERMISSION_MODES[0]
  const selectedPermissionOption = permissionOptions.find((option) => option.id === selectedPermissionMode)
  const modelLabel = optionLabel(modelField, selectedModel || runtimeSettings.model, t("defaultModel"))
  const effortLabel = optionLabel(effortField, selectedReasoning || runtimeSettings.effort, t("defaultReasoning"))
  const selectedPermissionLabelKey = permissionLabelKey(selectedPermissionMode)
  const permissionLabel = selectedPermissionLabelKey
    ? t(selectedPermissionLabelKey)
    : selectedPermissionOption?.label ?? t(approvalMode.labelKey)
  const canCreate =
    Boolean(authSession?.accessToken && selectedConnector && selectedAgent) &&
    !creating &&
    !runtimeConfigLoading &&
    (prompt.trim().length > 0 || attachments.length > 0)
  const selectorsLoading =
    Boolean(authSession?.accessToken && hasOnlineDevice && selectedConnector && selectedAgent) &&
    (runtimeConfigLoading || !runtimeSchema)

  const handleCreate = async () => {
    if (!authSession?.accessToken || !selectedConnector || !selectedAgent || creating) return
    if (!prompt.trim() && attachments.length === 0) return
    setCreating(true)
    try {
      const created = await dashboardApi.createSession(authSession.accessToken, {
        connectorId: selectedConnector.id,
        runtime: selectedAgent,
        title: prompt.trim() || undefined,
        cwd: workspace?.path || undefined,
        approvalPolicy: approvalMode.approvalPolicy,
        sandbox: approvalMode.sandbox,
      })
      const nextPreference = { connectorId: selectedConnector.id, agent: selectedAgent }
      writeNewSessionPreference(nextPreference)
      setPreference(nextPreference)
      const takeover = await dashboardApi.enableTakeover(authSession.accessToken, created.session.id)
      const sessionId = takeover.session.id
      const settings: Record<string, unknown> = {}
      const validSelectedReasoning = validEffortValue(effortField, selectedReasoning)
      if (selectedPermissionMode) settings.permissionMode = selectedPermissionMode
      if (selectedModel) settings.model = selectedModel
      if (validSelectedReasoning) settings.effort = validSelectedReasoning
      if (Object.keys(settings).length > 0) {
        await dashboardApi.patchSessionRuntimeSettings(authSession.accessToken, sessionId, settings)
      }
      const files = attachments.map((attachment) => attachment.file)
      const upload = files.length > 0
        ? await dashboardApi.uploadSessionAttachments(authSession.accessToken, sessionId, files)
        : null
      const attachmentRefs = upload?.attachments.map((attachment) => ({ fileId: attachment.fileId })) ?? []
      await dashboardApi.sendSessionMessage(
        authSession.accessToken,
        sessionId,
        prompt.trim() || t("attachmentOnlyPrompt"),
        {
          attachments: attachmentRefs,
          clientMessageId: crypto.randomUUID(),
          model: selectedModel || undefined,
          effort: validSelectedReasoning || undefined,
        },
      )
      clear()
      setPrompt("")
      upsertSession(takeover.session)
      refreshData()
      openSession(sessionId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("createFailed"))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className="flex flex-1 flex-col items-center justify-center px-6"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <DragOverlay isDragging={isDragging} />

      <div className="w-full max-w-3xl">
        <h1 className="mb-8 min-h-[3.5rem] text-balance text-center text-5xl font-semibold leading-tight tracking-tight" aria-live="polite">
          <span>{creating ? `${t("creatingBase")}${".".repeat((createTick % 3) + 1)}` : typedTitle}</span>
          <span className="ml-1 inline-block h-[0.9em] w-0.5 translate-y-[0.1em] rounded-full bg-muted-foreground motion-safe:animate-[composer-caret_1s_steps(1,end)_infinite]" aria-hidden="true" />
        </h1>

        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
          <div className="space-y-3 px-6 pt-6">
            <AttachmentPreviewList attachments={attachments} onRemove={remove} />
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  handleCreate()
                }
              }}
              placeholder={t("placeholder")}
              disabled={creating || !authSession?.accessToken || !selectedConnector}
              className="min-h-24 max-h-64 resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 text-base leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>

          <div className="px-6 pt-3">
            <Separator />
          </div>

          <div className="flex flex-wrap items-center gap-1 px-3 pb-3 pt-2">
            <AttachmentButton
              attachments={attachments}
              onAttach={add}
              isDragging={isDragging}
            />

            {selectorsLoading ? (
              <>
                <ComposerSelectorLoading className="w-36" />
                <ComposerSelectorLoading className="w-44" />
                <ComposerSelectorLoading className="w-36" />
              </>
            ) : (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                      {permissionField ? <span className="size-1.5 rounded-full bg-primary" /> : null}
                      <span className="text-foreground">{permissionLabel}</span>
                      <ChevronDown className="size-3.5 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64">
                    {permissionField ? (
                      permissionOptions.map((item) => (
                        <DropdownMenuItem
                          key={item.id}
                          className="gap-2"
                          onSelect={() => setSelectedPermissionMode(item.id)}
                        >
                          <Check className={cn("size-3.5", selectedPermissionMode === item.id ? "opacity-100" : "opacity-0")} />
                          <span>{permissionLabelKey(item.id) ? t(permissionLabelKey(item.id)!) : item.label}</span>
                        </DropdownMenuItem>
                      ))
                    ) : (
                      PERMISSION_MODES.map((opt) => (
                        <DropdownMenuItem key={opt.id} onSelect={() => setApproval(opt.id)}>
                          {t(opt.labelKey)}
                        </DropdownMenuItem>
                      ))
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>

                {hasOnlineDevice ? (
                  <CascadingSelector
                    icon={<Monitor className="size-4" />}
                    primaryOptions={deviceOptions}
                    secondaryOptions={agentOptions}
                    selectedPrimary={selectedDevice}
                    selectedSecondary={selectedAgent}
                    onPrimaryChange={setSelectedDevice}
                    onSecondaryChange={setSelectedAgent}
                    secondaryLabel={t("agent")}
                  />
                ) : null}

                {hasOnlineDevice && (models.length > 0 || reasoningOptions.length > 0) ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="max-w-72 gap-1.5 text-muted-foreground">
                        {effortField ? <span className="text-foreground">{effortLabel}</span> : null}
                        {effortField && modelField ? <span className="text-muted-foreground/50">·</span> : null}
                        {modelField ? <span className="truncate text-foreground">{modelLabel}</span> : null}
                        <ChevronDown className="size-3.5 shrink-0 opacity-50" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      {!modelField && reasoningOptions.length > 0 ? (
                        reasoningOptions.map((item) => (
                          <DropdownMenuItem
                            key={item.id}
                            className="gap-2"
                            onSelect={() => setSelectedReasoning(item.id)}
                          >
                            <Check className={cn("size-3.5", selectedReasoning === item.id ? "opacity-100" : "opacity-0")} />
                            <span className="truncate">{item.label}</span>
                          </DropdownMenuItem>
                        ))
                      ) : null}
                      {models.map((modelItem) => {
                        const modelEffortField = effortFieldFor(modelItem.id)
                        const modelEfforts = composerMenuOptions(modelEffortField)
                        if (modelEfforts.length === 0) {
                          return (
                            <DropdownMenuItem
                              key={modelItem.id}
                              className="gap-2"
                              onSelect={() => {
                                setSelectedModel(modelItem.id)
                                setSelectedReasoning("")
                              }}
                            >
                              <Check className={cn("size-3.5", selectedModel === modelItem.id ? "opacity-100" : "opacity-0")} />
                              <span className="truncate">{modelItem.label}</span>
                            </DropdownMenuItem>
                          )
                        }
                        return (
                          <DropdownMenuSub key={modelItem.id}>
                            <DropdownMenuSubTrigger className="gap-2">
                              <Check className={cn("size-3.5", selectedModel === modelItem.id ? "opacity-100" : "opacity-0")} />
                              <span className="max-w-40 truncate">{modelItem.label}</span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="w-56">
                              {modelEfforts.map((item) => (
                                <DropdownMenuItem
                                  key={item.id}
                                  className="gap-2"
                                  onSelect={() => {
                                    setSelectedModel(modelItem.id)
                                    setSelectedReasoning(item.id)
                                  }}
                                >
                                  <Check className={cn(
                                    "size-3.5",
                                    selectedModel === modelItem.id && selectedReasoning === item.id ? "opacity-100" : "opacity-0",
                                  )} />
                                  <span className="truncate">{item.label}</span>
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        )
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </>
            )}

            <Button
              size="icon"
              aria-label={t("sendTask")}
              className="ml-auto rounded-full"
              disabled={!canCreate}
              onClick={handleCreate}
            >
              {creating ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>

        <div className="mt-3">
          <WorkspacePicker
            connectorId={selectedConnector?.id}
            value={workspace}
            onChange={setWorkspace}
            loading={selectorsLoading}
          />
        </div>
      </div>
    </div>
  )
}

function attachedRuntimes(connector: { runtimeCapabilities?: { attached?: Record<string, unknown> } }) {
  return Object.keys(connector.runtimeCapabilities?.attached ?? {}).sort((a, b) => a.localeCompare(b))
}

function ComposerSelectorLoading({ className }: { className?: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled
      className={cn("justify-start gap-2 text-muted-foreground opacity-100", className)}
    >
      <Spinner className="size-3.5" />
      <span className="h-3 w-16 rounded-full bg-muted-foreground/20" />
    </Button>
  )
}

function useTypewriterTitle(titles: string[], paused: boolean) {
  const [titleIndex, setTitleIndex] = React.useState(0)
  const [typedTitle, setTypedTitle] = React.useState("")

  React.useEffect(() => {
    if (paused || titles.length === 0) return

    const title = titles[titleIndex % titles.length] ?? titles[0] ?? ""
    const hasCjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(title)
    const writeDelay = hasCjk ? CJK_TITLE_WRITE_MS : TITLE_WRITE_MS
    const eraseDelay = hasCjk ? CJK_TITLE_ERASE_MS : TITLE_ERASE_MS
    let cancelled = false
    let timeout: number | undefined

    const schedule = (fn: () => void, delay: number) => {
      timeout = window.setTimeout(fn, delay)
    }

    const write = (count: number) => {
      if (cancelled) return
      setTypedTitle(title.slice(0, count))
      if (count < title.length) {
        schedule(() => write(count + 1), writeDelay)
        return
      }
      schedule(() => erase(title.length), TITLE_HOLD_MS)
    }

    const erase = (count: number) => {
      if (cancelled) return
      setTypedTitle(title.slice(0, count))
      if (count > 0) {
        schedule(() => erase(count - 1), eraseDelay)
        return
      }
      setTitleIndex((index) => (index + 1) % titles.length)
    }

    write(0)

    return () => {
      cancelled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [paused, titleIndex, titles])

  return typedTitle
}

function runtimeLabel(runtime: string): string {
  if (runtime === "codex") return "Codex"
  if (runtime === "claude") return "Claude Code"
  if (runtime === "opencode") return "OpenCode"
  return runtime.slice(0, 1).toUpperCase() + runtime.slice(1)
}

function readNewSessionPreference(): NewSessionPreference | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(NEW_SESSION_PREFERENCE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<NewSessionPreference>
    if (typeof parsed.connectorId !== "string" || typeof parsed.agent !== "string") {
      return null
    }
    if (!parsed.connectorId || !parsed.agent) return null
    return {
      connectorId: parsed.connectorId,
      agent: parsed.agent,
    }
  } catch {
    return null
  }
}

function writeNewSessionPreference(preference: NewSessionPreference) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(NEW_SESSION_PREFERENCE_KEY, JSON.stringify(preference))
  } catch {
    // localStorage may be unavailable in private contexts. The composer can still fall back.
  }
}
