"use client"

import * as React from "react"
import { Monitor, ChevronDown, ArrowUp, Loader2, Check } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useSidebar } from "@/components/ui/sidebar"
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
import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { AgentSelectionDrawer } from "@/components/session/agent-selection-drawer"
import { SelectionSettingsDrawer } from "@/components/session/selection-settings-drawer"
import {
  AttachmentButton,
  AttachmentPreviewList,
  DragOverlay,
  useAttachments,
} from "@/components/attachment-input"
import { buildOptimisticUserMessage } from "@/components/session/optimistic-timeline"
import { WorkspacePicker, type WorkspaceSelection } from "@/components/workspace-picker"
import { useWorkspace } from "@/components/workspace-context"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import { createClientId } from "@/lib/id"
import { cn } from "@/lib/utils"
import { useElementWidth } from "@/hooks/use-element-width"
import type {
  DeviceRuntimeView,
  ProtocolModelCatalog,
  ProtocolPermissionCatalog,
  SessionView as RealSessionView,
} from "@/features/dashboard/types"
import { useTranslations } from "next-intl"
import {
  modelIdsForSelectionId,
  modelSelectionIdForCatalog,
  permissionIdForSelectionId,
  permissionSelectionIdForCatalog,
} from "@/components/session/catalog-selection"

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
  selections?: Record<string, NewSessionSelectionPreference>
}

type NewSessionSelectionPreference = {
  modelSelectionId?: string | null
  permissionSelectionId?: string | null
}

type NewSessionTitleKey = (typeof NEW_SESSION_TITLE_KEYS)[number]

export function TaskComposer() {
  const { session: authSession } = useAuth()
  const { isMobile, state: sidebarState } = useSidebar()
  const {
    addOptimisticMessage,
    bindOptimisticSession,
    connectors,
    goHome,
    markOptimisticMessageFailed,
    openSession,
    requestSessionRefresh,
    upsertSession,
    refreshData,
  } = useWorkspace()
  const t = useTranslations("dashboard.new")
  const typewriterTitles = React.useMemo(
    () => NEW_SESSION_TITLE_KEYS.map((key) => t(key as NewSessionTitleKey)),
    [t],
  )

  const [runtimeInventory, setRuntimeInventory] = React.useState<Record<string, DeviceRuntimeView[]>>({})
  const [runtimeInventoryLoading, setRuntimeInventoryLoading] = React.useState(true)

  React.useEffect(() => {
    if (!authSession?.accessToken) {
      setRuntimeInventory({})
      setRuntimeInventoryLoading(false)
      return
    }
    const online = connectors.filter((connector) => connector.status === "online")
    if (online.length === 0) {
      setRuntimeInventory({})
      setRuntimeInventoryLoading(false)
      return
    }
    let cancelled = false
    setRuntimeInventoryLoading(true)
    Promise.allSettled(
      online.map(async (connector) => ({
        connectorId: connector.id,
        response: await dashboardApi.getConnectorRuntimes(authSession.accessToken, connector.id),
      })),
    ).then((results) => {
      if (cancelled) return
      const next: Record<string, DeviceRuntimeView[]> = {}
      for (const result of results) {
        if (result.status === "fulfilled") next[result.value.connectorId] = result.value.response.runtimes
      }
      setRuntimeInventory(next)
      setRuntimeInventoryLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [authSession?.accessToken, connectors])

  // New sessions can only target runtimes that the Server has activated and the Connector reports as running.
  const onlineConnectors = React.useMemo(
    () => connectors.filter((connector) =>
      connector.status === "online" && activeRuntimes(runtimeInventory[connector.id]).length > 0,
    ),
    [connectors, runtimeInventory],
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
  const selectedConnectorId = selectedConnector?.id ?? ""
  const agentOptions = React.useMemo(
    () => selectedConnector
      ? activeRuntimes(runtimeInventory[selectedConnector.id]).map((runtime) => ({
          id: runtime.runtimeId,
          label: runtime.displayName,
        }))
      : [],
    [runtimeInventory, selectedConnector],
  )

  const [selectedAgent, setSelectedAgent] = React.useState(agentOptions[0]?.id ?? "")
  const [selectedModel, setSelectedModel] = React.useState("")
  const [selectedReasoning, setSelectedReasoning] = React.useState("")
  const [selectedPermissionMode, setSelectedPermissionMode] = React.useState("")
  const [workspace, setWorkspace] = React.useState<WorkspaceSelection | null>(null)
  const [prompt, setPrompt] = React.useState("")
  const [modelCatalog, setModelCatalog] = React.useState<ProtocolModelCatalog | null>(null)
  const [permissionCatalog, setPermissionCatalog] = React.useState<ProtocolPermissionCatalog | null>(null)
  const [catalogsLoading, setCatalogsLoading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [createTick, setCreateTick] = React.useState(0)
  const [preferenceLoaded, setPreferenceLoaded] = React.useState(false)
  const [preference, setPreference] = React.useState<NewSessionPreference | null>(null)
  const composerRef = React.useRef<HTMLDivElement | null>(null)
  const devicePreferenceAppliedRef = React.useRef(false)
  const agentPreferenceAppliedForDeviceRef = React.useRef<string | null>(null)
  const selectionPreferenceAppliedForScopeRef = React.useRef<string | null>(null)
  const composerWidth = useElementWidth(composerRef)

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
    const connectorId = selectedConnectorId

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
  }, [agentOptions, preference, preferenceLoaded, selectedAgent, selectedConnectorId])

  React.useEffect(() => {
    if (!authSession?.accessToken || !selectedConnectorId || !selectedAgent) {
      setModelCatalog(null)
      setPermissionCatalog(null)
      setCatalogsLoading(false)
      return
    }
    let cancelled = false
    setCatalogsLoading(true)
    setModelCatalog(null)
    setPermissionCatalog(null)
    Promise.all([
      dashboardApi.getAgentModelCatalog(authSession.accessToken, selectedAgent, selectedConnectorId),
      dashboardApi.getAgentPermissionCatalog(authSession.accessToken, selectedAgent, selectedConnectorId),
    ])
      .then(([modelCatalogResponse, permissionCatalogResponse]) => {
        if (cancelled) return
        setModelCatalog(modelCatalogResponse.catalog)
        setPermissionCatalog(permissionCatalogResponse.catalog)
      })
      .catch(() => {
        if (cancelled) return
        setModelCatalog(null)
        setPermissionCatalog(null)
      })
      .finally(() => {
        if (!cancelled) setCatalogsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [authSession?.accessToken, selectedAgent, selectedConnectorId])

  const models = React.useMemo(
    () => modelCatalog?.models.map((item) => ({
      id: item.id,
      label: item.displayName,
      default: item.default,
      selectionId: item.selectionId,
      reasoningItems: item.reasoningItems.map((reasoning) => ({
        id: reasoning.id,
        label: reasoning.displayName,
        default: reasoning.default,
        selectionId: reasoning.selectionId,
      })),
    })) ?? [],
    [modelCatalog],
  )
  const selectedModelItem = models.find((item) => item.id === selectedModel)
  const reasoningOptions = selectedModelItem?.reasoningItems ?? []
  const permissionOptions = React.useMemo(
    () => permissionCatalog?.permissions.map((item) => ({
      id: item.id,
      label: item.displayName,
      default: item.default,
      selectionId: item.selectionId,
    })) ?? [],
    [permissionCatalog],
  )

  React.useEffect(() => {
    const nextModel = models.find((option) => option.default)?.id ?? models[0]?.id ?? ""
    setSelectedModel((current) => current && models.some((option) => option.id === current) ? current : nextModel)
  }, [models])

  React.useEffect(() => {
    const nextPermissionMode = permissionOptions.find((option) => option.default)?.id ?? permissionOptions[0]?.id ?? ""
    setSelectedPermissionMode((current) =>
      current && permissionOptions.some((option) => option.id === current) ? current : nextPermissionMode,
    )
  }, [permissionOptions])

  React.useEffect(() => {
    const nextEffort = reasoningOptions.find((option) => option.default)?.id ?? reasoningOptions[0]?.id ?? ""
    setSelectedReasoning((current) =>
      current && reasoningOptions.some((option) => option.id === current) ? current : nextEffort,
    )
  }, [reasoningOptions])

  React.useEffect(() => {
    setSelectedReasoning((current) => {
      if (!current) return current
      return reasoningOptions.some((option) => option.id === current) ? current : ""
    })
  }, [reasoningOptions])

  React.useEffect(() => {
    if (!preferenceLoaded || !selectedConnectorId || !selectedAgent) return
    if (catalogsLoading || (!modelCatalog && !permissionCatalog)) return
    const scope = newSessionSelectionScope(selectedConnectorId, selectedAgent)
    if (selectionPreferenceAppliedForScopeRef.current === scope) return
    const selectionPreference = preference?.selections?.[scope]
    selectionPreferenceAppliedForScopeRef.current = scope
    if (!selectionPreference) return

    const modelSelection = modelIdsForSelectionId(modelCatalog, selectionPreference.modelSelectionId)
    if (modelSelection && models.some((option) => option.id === modelSelection.modelId)) {
      setSelectedModel(modelSelection.modelId)
      setSelectedReasoning(modelSelection.reasoningId)
    }

    const permissionSelection = permissionIdForSelectionId(
      permissionCatalog,
      selectionPreference.permissionSelectionId,
    )
    if (permissionSelection && permissionOptions.some((option) => option.id === permissionSelection)) {
      setSelectedPermissionMode(permissionSelection)
    }
  }, [
    modelCatalog,
    models,
    permissionCatalog,
    permissionOptions,
    preference,
    preferenceLoaded,
    catalogsLoading,
    selectedAgent,
    selectedConnectorId,
  ])

  const selectedPermissionOption = permissionOptions.find((option) => option.id === selectedPermissionMode)
  const modelLabel = selectedModelItem?.label ?? t("defaultModel")
  const selectedReasoningOption = reasoningOptions.find((option) => option.id === selectedReasoning)
  const effortLabel = selectedReasoningOption?.label ?? t("defaultReasoning")
  const permissionLabel = selectedPermissionOption?.label ?? t("permissionMode")
  const permissionDrawerItems = permissionOptions
  const modelSelectionId = modelSelectionIdForCatalog(modelCatalog, selectedModel, selectedReasoning)
  const permissionSelectionId = permissionSelectionIdForCatalog(permissionCatalog, selectedPermissionMode)
  const requiresModelSelection = Boolean(modelCatalog && models.length > 0)
  const requiresPermissionSelection = Boolean(permissionCatalog && permissionOptions.length > 0)
  const hasSelectionSettings = models.length > 0 || permissionOptions.length > 0
  const canCreate =
    Boolean(authSession?.accessToken && selectedConnector && selectedAgent) &&
    !creating &&
    !catalogsLoading &&
    (!requiresModelSelection || Boolean(modelSelectionId)) &&
    (!requiresPermissionSelection || Boolean(permissionSelectionId)) &&
    (prompt.trim().length > 0 || attachments.length > 0)
  const selectorsLoading =
    runtimeInventoryLoading || (
      Boolean(authSession?.accessToken && hasOnlineDevice && selectedConnector && selectedAgent) && catalogsLoading
    )
  const compactSelectors = composerWidth > 0 && composerWidth < 640
  const showCollapsedBrand = isMobile || sidebarState === "collapsed"

  const handleCreate = async () => {
    if (!authSession?.accessToken || !selectedConnector || !selectedAgent || creating) return
    if (!prompt.trim() && attachments.length === 0) return
    if (catalogsLoading) return
    if (requiresModelSelection && !modelSelectionId) return
    if (requiresPermissionSelection && !permissionSelectionId) return
    const localSessionId = createClientId("session")
    const clientMessageId = createClientId("msg")
    const messageText = prompt.trim() || t("attachmentOnlyPrompt")
    const selectedAttachments = attachments
    const now = new Date().toISOString()
    const optimisticSession: RealSessionView = {
      id: localSessionId,
      connectorId: selectedConnector.id,
      connectorStatus: selectedConnector.status,
      runtime: selectedAgent,
      externalSessionId: null,
      title: prompt.trim() || null,
      cwd: workspace?.path || null,
      status: "pending",
      takeover: true,
      pinned: false,
      pinnedAt: null,
      archived: false,
      archivedAt: null,
      unread: false,
      lastReadSeq: 0,
      lastSyncedAt: null,
      sourceObservedAt: null,
      lastActivityAt: now,
      lastItemAt: now,
      lastItemOrderSeq: 1,
      sortAt: now,
      updatedSeq: 1,
      effectiveRunMode: "chat",
      modelSelectionId,
      permissionSelectionId,
    }
    addOptimisticMessage({
      clientMessageId,
      sessionId: localSessionId,
      localSessionId,
      session: optimisticSession,
      item: buildOptimisticUserMessage({
        sessionId: localSessionId,
        clientMessageId,
        text: messageText,
        attachments: selectedAttachments,
        items: [],
        nextSeq: 0,
      }),
    })
    clear()
    setPrompt("")
    openSession(localSessionId)
    setCreating(true)
    try {
      const created = await dashboardApi.createSession(authSession.accessToken, {
        connectorId: selectedConnector.id,
        runtime: selectedAgent,
        title: prompt.trim() || undefined,
        cwd: workspace?.path || undefined,
        modelSelectionId,
        permissionSelectionId,
      })
      const nextPreference = withNewSessionSelectionPreference(
        preference,
        selectedConnector.id,
        selectedAgent,
        {
          modelSelectionId,
          permissionSelectionId,
        },
      )
      writeNewSessionPreference(nextPreference)
      setPreference(nextPreference)
      bindOptimisticSession(localSessionId, created.session)
      const takeover = await dashboardApi.enableTakeover(authSession.accessToken, created.session.id)
      const sessionId = takeover.session.id
      bindOptimisticSession(localSessionId, takeover.session)
      const files = selectedAttachments.map((attachment) => attachment.file)
      const upload = files.length > 0
        ? await dashboardApi.uploadSessionAttachments(authSession.accessToken, sessionId, files)
        : null
      const attachmentRefs = upload?.attachments.map((attachment) => ({ fileId: attachment.fileId })) ?? []
      await dashboardApi.sendSessionMessage(
        authSession.accessToken,
        sessionId,
        messageText,
        {
          attachments: attachmentRefs,
          clientMessageId,
          modelSelectionId,
          permissionSelectionId,
        },
      )
      upsertSession(takeover.session)
      requestSessionRefresh(sessionId, clientMessageId)
      refreshData()
    } catch (err) {
      const message = err instanceof Error ? err.message : t("createFailed")
      markOptimisticMessageFailed(clientMessageId, message)
      toast.error(message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className="relative flex flex-1 flex-col items-center justify-center px-6"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <DragOverlay isDragging={isDragging} />
      <div className="absolute left-3 top-3 flex items-center gap-2">
        <DashboardSidebarToggle />
        {showCollapsedBrand ? (
          <button
            type="button"
            onClick={goHome}
            className="aa-wordmark text-xl leading-none text-foreground transition-colors hover:text-primary"
          >
            Agents Anywhere
          </button>
        ) : null}
      </div>

      <div className="w-full max-w-3xl">
        <h1 className="mb-6 min-h-[3rem] text-balance text-center text-4xl font-semibold leading-tight tracking-tight" aria-live="polite">
          <span>{creating ? `${t("creatingBase")}${".".repeat((createTick % 3) + 1)}` : typedTitle}</span>
          <span className="ml-1 inline-block h-[0.9em] w-0.5 translate-y-[0.1em] rounded-full bg-muted-foreground motion-safe:animate-[composer-caret_1s_steps(1,end)_infinite]" aria-hidden="true" />
        </h1>

        <div
          ref={composerRef}
          className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20"
        >
          <div className="flex flex-col gap-3 px-5 pt-4">
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
              className="min-h-20 max-h-64 resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 text-base leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>

          <div className="px-5 pt-2">
            <Separator />
          </div>

          <div className="flex flex-wrap items-center gap-1 px-3 pb-2 pt-1.5">
            <AttachmentButton
              attachments={attachments}
              onAttach={add}
              isDragging={isDragging}
            />

            {selectorsLoading ? (
              <>
                <ComposerSelectorLoading className="w-44" />
                <ComposerSelectorLoading className="w-36" />
                <ComposerSelectorLoading className="w-44" />
              </>
            ) : (
              <>
                {hasOnlineDevice && compactSelectors ? (
                  <AgentSelectionDrawer
                    buttonLabel={t("agent")}
                    title={t("deviceAndAgent")}
                    deviceLabel={t("device")}
                    agentLabel={t("agent")}
                    deviceItems={deviceOptions}
                    selectedDevice={selectedDevice}
                    onDeviceChange={setSelectedDevice}
                    agentItems={agentOptions}
                    selectedAgent={selectedAgent}
                    onAgentChange={setSelectedAgent}
                  />
                ) : hasOnlineDevice ? (
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

                {compactSelectors && hasSelectionSettings ? (
                  <SelectionSettingsDrawer
                    disabled={selectorsLoading}
                    buttonLabel={t("selectionSettings")}
                    title={t("selectionSettings")}
                    description={t("selectionSettingsDescription")}
                    permissionLabel={t("permissionMode")}
                    modelLabel={t("modelAndReasoning")}
                    reasoningLabel={t("reasoning")}
                    permissionItems={permissionDrawerItems}
                    selectedPermission={selectedPermissionMode}
                    onPermissionChange={setSelectedPermissionMode}
                    modelItems={hasOnlineDevice ? models : []}
                    selectedModel={selectedModel}
                    selectedReasoning={selectedReasoning}
                    onModelChange={(modelId, reasoningId) => {
                      setSelectedModel(modelId)
                      setSelectedReasoning(reasoningId)
                    }}
                  />
                ) : !compactSelectors ? (
                  <>
                    {permissionOptions.length > 0 ? <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                          {permissionOptions.length > 0 ? <span className="size-1.5 rounded-full bg-primary" /> : null}
                          <span className="text-foreground">{permissionLabel}</span>
                          <ChevronDown className="size-3.5 opacity-50" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-64">
                        {permissionOptions.map((item) => (
                          <DropdownMenuItem
                            key={item.id}
                            className="gap-2"
                            onSelect={() => setSelectedPermissionMode(item.id)}
                          >
                            <Check className={cn("size-3.5", selectedPermissionMode === item.id ? "opacity-100" : "opacity-0")} />
                            <span>{item.label}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu> : null}

                    {hasOnlineDevice && models.length > 0 ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="max-w-72 gap-1.5 text-muted-foreground">
                            {reasoningOptions.length > 0 ? <span className="text-foreground">{effortLabel}</span> : null}
                            {reasoningOptions.length > 0 ? <span className="text-muted-foreground/50">·</span> : null}
                            <span className="truncate text-foreground">{modelLabel}</span>
                            <ChevronDown className="size-3.5 shrink-0 opacity-50" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-56">
                          {models.map((modelItem) => {
                            const modelEfforts = modelItem.reasoningItems
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
            connectorId={selectedConnectorId}
            value={workspace}
            onChange={setWorkspace}
          />
        </div>
      </div>
    </div>
  )
}

function activeRuntimes(runtimes: DeviceRuntimeView[] | undefined) {
  return (runtimes ?? [])
    .filter((runtime) => runtime.configured && runtime.active && runtime.status === "running")
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
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
      selections: readNewSessionSelectionPreferences(parsed.selections),
    }
  } catch {
    return null
  }
}

function readNewSessionSelectionPreferences(value: unknown): Record<string, NewSessionSelectionPreference> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const result: Record<string, NewSessionSelectionPreference> = {}
  for (const [scope, rawSelection] of Object.entries(value)) {
    if (!scope || !rawSelection || typeof rawSelection !== "object" || Array.isArray(rawSelection)) continue
    const selection = rawSelection as Partial<NewSessionSelectionPreference>
    const modelSelectionId = typeof selection.modelSelectionId === "string" && selection.modelSelectionId
      ? selection.modelSelectionId
      : null
    const permissionSelectionId = typeof selection.permissionSelectionId === "string" && selection.permissionSelectionId
      ? selection.permissionSelectionId
      : null
    if (!modelSelectionId && !permissionSelectionId) continue
    result[scope] = {
      modelSelectionId,
      permissionSelectionId,
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function withNewSessionSelectionPreference(
  current: NewSessionPreference | null,
  connectorId: string,
  agent: string,
  selection: NewSessionSelectionPreference,
): NewSessionPreference {
  const scope = newSessionSelectionScope(connectorId, agent)
  return {
    connectorId,
    agent,
    selections: {
      ...(current?.selections ?? {}),
      [scope]: {
        modelSelectionId: selection.modelSelectionId ?? null,
        permissionSelectionId: selection.permissionSelectionId ?? null,
      },
    },
  }
}

function newSessionSelectionScope(connectorId: string, agent: string): string {
  return `${connectorId}:${agent}`
}

function writeNewSessionPreference(preference: NewSessionPreference) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(NEW_SESSION_PREFERENCE_KEY, JSON.stringify(preference))
  } catch {
    // localStorage may be unavailable in private contexts. The composer can still fall back.
  }
}
