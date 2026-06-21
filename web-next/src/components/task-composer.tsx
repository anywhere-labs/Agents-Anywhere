"use client"

import * as React from "react"
import { Monitor, ChevronDown, ArrowUp, Hand, Loader2, CircleAlert } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
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
import {
  composerMenuOptions,
  effectiveFieldValue,
  filterClaudeEffortField,
  type ComposerPermissionLabelKey,
  runtimeConfigFields,
} from "@/features/dashboard/runtime-config"
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

type NewSessionPreference = {
  connectorId: string
  agent: string
}

export function TaskComposer() {
  const { session: authSession } = useAuth()
  const { connectors, openSession, upsertSession, refreshData } = useWorkspace()
  const t = useTranslations("dashboard.new")

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
  const [approval, setApproval] = React.useState<(typeof PERMISSION_MODES)[number]["id"]>("full")
  const [workspace, setWorkspace] = React.useState<WorkspaceSelection | null>(null)
  const [prompt, setPrompt] = React.useState("")
  const [runtimeSchema, setRuntimeSchema] = React.useState<RuntimeConfigSchema | null>(null)
  const [runtimeSettings, setRuntimeSettings] = React.useState<Record<string, unknown>>({})
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [preferenceLoaded, setPreferenceLoaded] = React.useState(false)
  const [preference, setPreference] = React.useState<NewSessionPreference | null>(null)
  const devicePreferenceAppliedRef = React.useRef(false)
  const agentPreferenceAppliedForDeviceRef = React.useRef<string | null>(null)

  const { attachments, isDragging, add, remove, clear, onDragEnter, onDragLeave, onDragOver, onDrop } =
    useAttachments()

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
      return
    }
    let cancelled = false
    setRuntimeSchema(null)
    setRuntimeSettings({})
    Promise.all([
      dashboardApi.getRuntimeConfigSchema(authSession.accessToken, selectedAgent),
      dashboardApi.getConnectorAgentSettings(authSession.accessToken, selectedConnector.id, selectedAgent),
    ])
      .then(([schemaResponse, settingsResponse]) => {
        if (cancelled) return
        setRuntimeSchema(schemaResponse.schema)
        setRuntimeSettings(settingsResponse.runtimeSettings ?? settingsResponse.settings ?? {})
      })
      .catch(() => {
        if (cancelled) return
        setRuntimeSchema(null)
        setRuntimeSettings({})
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
  const effortField = filterClaudeEffortField(
    selectedAgent,
    runtimeFields.find((field) => field.key === "effort"),
    selectedModel || runtimeSettings.model,
  )
  const models = composerMenuOptions(modelField)
  const reasoningOptions = composerMenuOptions(effortField)

  React.useEffect(() => {
    const nextModel = effectiveFieldValue(modelField, runtimeSettings.model)
    setSelectedModel((current) => current && models.some((option) => option.id === current) ? current : nextModel)
  }, [modelField, models, runtimeSettings.model])

  React.useEffect(() => {
    const nextEffort = effectiveFieldValue(effortField, runtimeSettings.effort)
    setSelectedReasoning((current) =>
      current && reasoningOptions.some((option) => option.id === current) ? current : nextEffort,
    )
  }, [effortField, reasoningOptions, runtimeSettings.effort])

  const approvalMode = PERMISSION_MODES.find((o) => o.id === approval) ?? PERMISSION_MODES[0]
  const canCreate =
    Boolean(authSession?.accessToken && selectedConnector && selectedAgent) &&
    !creating &&
    (prompt.trim().length > 0 || attachments.length > 0)

  const handleCreate = async () => {
    if (!authSession?.accessToken || !selectedConnector || !selectedAgent || creating) return
    if (!prompt.trim() && attachments.length === 0) return
    setCreating(true)
    setError(null)
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
      if (selectedModel) settings.model = selectedModel
      if (selectedReasoning) settings.effort = selectedReasoning
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
          effort: selectedReasoning || undefined,
        },
      )
      clear()
      setPrompt("")
      upsertSession(takeover.session)
      refreshData()
      openSession(sessionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("createFailed"))
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
        <h1 className="mb-8 text-balance text-center text-5xl font-semibold tracking-tight">
          {t("title")}
        </h1>

        {error ? (
          <Alert variant="destructive" className="mb-3">
            <CircleAlert className="size-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="rounded-2xl border border-border bg-card shadow-sm">
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

          <div className="flex flex-wrap items-center gap-1 px-3 pb-3 pt-2">
            <AttachmentButton
              attachments={attachments}
              onAttach={add}
              isDragging={isDragging}
            />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                  <Hand className="size-4" />
                  <span className="text-foreground">{t(approvalMode.labelKey)}</span>
                  <ChevronDown className="size-3.5 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                {PERMISSION_MODES.map((opt) => (
                  <DropdownMenuItem key={opt.id} onSelect={() => setApproval(opt.id)}>
                    {t(opt.labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

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

            {models.length > 0 || reasoningOptions.length > 0 ? (
              <CascadingSelector
                primaryOptions={models.length > 0 ? models : [{ id: "default", label: t("defaultModel") }]}
                secondaryOptions={reasoningOptions.length > 0 ? reasoningOptions : [{ id: "default", label: t("defaultReasoning") }]}
                selectedPrimary={selectedModel || "default"}
                selectedSecondary={selectedReasoning || "default"}
                onPrimaryChange={(id) => setSelectedModel(id === "default" ? "" : id)}
                onSecondaryChange={(id) => setSelectedReasoning(id === "default" ? "" : id)}
                secondaryLabel={t("reasoning")}
              />
            ) : null}

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
          />
        </div>
      </div>
    </div>
  )
}

function attachedRuntimes(connector: { runtimeCapabilities?: { attached?: Record<string, unknown> } }) {
  return Object.keys(connector.runtimeCapabilities?.attached ?? {}).sort((a, b) => a.localeCompare(b))
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
