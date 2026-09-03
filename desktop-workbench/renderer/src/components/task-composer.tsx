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
import { DashboardSidebarToggle } from "@/components/dashboard-sidebar-toggle"
import { AgentSelectionDrawer } from "@/components/session/agent-selection-drawer"
import { SelectionSettingsDrawer } from "@/components/session/selection-settings-drawer"
import {
  AttachmentButton,
  AttachmentPreviewList,
  DragOverlay,
  type AttachedFile,
  useAttachments,
} from "@/components/attachment-input"
import { buildOptimisticUserMessage } from "@/components/session/optimistic-timeline"
import {
  ProjectEditorDialog,
  type ProjectEditorState,
} from "@/components/sidebar/project-editor-dialog"
import { WorkspacePicker, type WorkspaceSelection } from "@/components/workspace-picker"
import { useWorkspace } from "@/components/workspace-context"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import { createClientId } from "@/lib/id"
import { cn } from "@/lib/utils"
import { useElementWidth } from "@/hooks/use-element-width"
import { useIsMobile } from "@/hooks/use-mobile"
import type {
  DeviceRuntimeView,
  InlineAttachmentRef,
  ProjectCreateRequest,
  ProtocolCapabilitySet,
  ProtocolModelCatalog,
  ProtocolPermissionCatalog,
  SessionView as RealSessionView,
} from "@/features/dashboard/types"
import { useTranslations } from "next-intl"
import {
  catalogItemDisabledReason,
  catalogItemEnabled,
  catalogI18nText,
  modelCatalogDisplayName,
  modelIdsForSelectionId,
  permissionIdForSelectionId,
  selectionIdForModelCatalog,
  selectionIdForPermissionCatalog,
} from "@/components/session/catalog-selection"
import { CAPABILITY, capabilityIsUsable } from "@/components/session/capabilities"
import {
  runtimeInstanceName,
  runtimeTypeName,
  sessionRuntimeRequestIdentity,
} from "@/features/dashboard/runtime-instances"

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
const MOBILE_NEW_SESSION_TITLE_KEYS = [
  "typewriter.workOn",
  "typewriter.giveTask",
  "typewriter.needsAttention",
  "typewriter.nextChange",
  "typewriter.inspect",
  "typewriter.changingToday",
] as const

async function inlineAttachmentsFromFiles(files: AttachedFile[]): Promise<InlineAttachmentRef[]> {
  const inlineAttachments: InlineAttachmentRef[] = []
  for (const attachment of files) {
    const content = await attachment.file.arrayBuffer()
    const contentBase64 = arrayBufferToBase64(content)
    const sha256 = await sha256Hex(content)
    inlineAttachments.push({
      fileId: attachment.id.slice(0, 64),
      name: attachment.name,
      mediaType: attachment.file.type || "application/octet-stream",
      size: attachment.size,
      sha256,
      contentBase64,
    })
  }
  return inlineAttachments
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  const chunkSize = 0x8000
  let binary = ""
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

type NewSessionPreference = {
  connectorId: string
  agent: string
  selections?: Record<string, NewSessionSelectionPreference>
}

type NewSessionSelectionPreference = {
  model?: string | null
  permission?: string | null
}

type NewSessionTitleKey = (typeof NEW_SESSION_TITLE_KEYS)[number]
type MobileNewSessionTitleKey = (typeof MOBILE_NEW_SESSION_TITLE_KEYS)[number]

export function TaskComposer() {
  const { session: authSession } = useAuth()
  const {
    addOptimisticMessage,
    bindOptimisticSession,
    connectors,
    createProject,
    markOptimisticMessageFailed,
    newSessionProject,
    openSession,
    projects,
    updateProject,
  } = useWorkspace()
  const isMobile = useIsMobile()
  const t = useTranslations("dashboard.new")
  const typewriterTitles = React.useMemo(
    () => {
      const keys = isMobile ? MOBILE_NEW_SESSION_TITLE_KEYS : NEW_SESSION_TITLE_KEYS
      return keys.map((key) => t(key as NewSessionTitleKey | MobileNewSessionTitleKey))
    },
    [isMobile, t],
  )

  const [runtimeInventory, setRuntimeInventory] = React.useState<Record<string, DeviceRuntimeView[]>>({})
  const [runtimeInventoryLoading, setRuntimeInventoryLoading] = React.useState(true)
  const onlineConnectorKey = React.useMemo(
    () => connectors
      .filter((connector) => connector.status === "online")
      .map((connector) => `${connector.id}:${connector.status}`)
      .sort()
      .join("|"),
    [connectors],
  )

  React.useEffect(() => {
    if (!authSession?.accessToken) {
      setRuntimeInventory((current) => sameRuntimeInventory(current, {}) ? current : {})
      setRuntimeInventoryLoading(false)
      return
    }
    const online = connectors.filter((connector) => connector.status === "online")
    if (online.length === 0) {
      setRuntimeInventory((current) => sameRuntimeInventory(current, {}) ? current : {})
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
      setRuntimeInventory((current) => sameRuntimeInventory(current, next) ? current : next)
      setRuntimeInventoryLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [authSession?.accessToken, onlineConnectorKey])

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
          label: runtimeOptionLabel(runtime),
        }))
      : [],
    [runtimeInventory, selectedConnector],
  )

  const [selectedAgent, setSelectedAgent] = React.useState(agentOptions[0]?.id ?? "")
  const selectedRuntime = activeRuntimes(runtimeInventory[selectedConnectorId])
    .find((runtime) => runtime.runtimeId === selectedAgent) ?? null
  const selectedRuntimeScope = selectedRuntime
    ? { runtimeId: selectedRuntime.runtimeId, runtimeType: selectedRuntime.runtimeType }
    : undefined
  const [selectedModel, setSelectedModel] = React.useState("")
  const [selectedReasoning, setSelectedReasoning] = React.useState("")
  const [selectedPermissionMode, setSelectedPermissionMode] = React.useState("")
  const [workspace, setWorkspace] = React.useState<WorkspaceSelection | null>(null)
  const [projectEditor, setProjectEditor] = React.useState<ProjectEditorState>(null)
  const [prompt, setPrompt] = React.useState("")
  const [modelCatalog, setModelCatalog] = React.useState<ProtocolModelCatalog | null>(null)
  const [permissionCatalog, setPermissionCatalog] = React.useState<ProtocolPermissionCatalog | null>(null)
  const [runtimeCapabilities, setRuntimeCapabilities] = React.useState<ProtocolCapabilitySet | null>(null)
  const [catalogsLoading, setCatalogsLoading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [createTick, setCreateTick] = React.useState(0)
  const [preferenceLoaded, setPreferenceLoaded] = React.useState(false)
  const [preference, setPreference] = React.useState<NewSessionPreference | null>(null)
  const composerRef = React.useRef<HTMLDivElement | null>(null)
  const devicePreferenceAppliedRef = React.useRef(false)
  const projectPrefillAppliedRef = React.useRef<string | null>(null)
  const agentPreferenceAppliedForDeviceRef = React.useRef<string | null>(null)
  const selectionPreferenceAppliedForScopeRef = React.useRef<string | null>(null)
  const composerWidth = useElementWidth(composerRef)

  const { attachments, isDragging, add, remove, clear, onDragEnter, onDragLeave, onDragOver, onDrop } =
    useAttachments()
  const typedTitle = useTypewriterTitle(typewriterTitles, creating)

  const createAndSelectProject = React.useCallback(async (payload: ProjectCreateRequest) => {
    const project = await createProject(payload)
    if (!project) return null
    setSelectedDevice(project.connectorId)
    setWorkspace({
      label: project.name,
      path: project.workspacePath,
      connectorId: project.connectorId,
      projectId: project.id,
    })
    return project
  }, [createProject])

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
    if (!newSessionProject) {
      if (projectPrefillAppliedRef.current !== null) {
        projectPrefillAppliedRef.current = null
        devicePreferenceAppliedRef.current = false
        setWorkspace(null)
      }
      return
    }

    if (projectPrefillAppliedRef.current === newSessionProject.id) return
    if (!deviceOptions.some((option) => option.id === newSessionProject.connectorId)) return

    projectPrefillAppliedRef.current = newSessionProject.id
    setSelectedDevice(newSessionProject.connectorId)
    setWorkspace({
      label: newSessionProject.name,
      path: newSessionProject.workspacePath,
      connectorId: newSessionProject.connectorId,
      projectId: newSessionProject.id,
    })
  }, [deviceOptions, newSessionProject])

  React.useEffect(() => {
    if (newSessionProject) {
      if (deviceOptions.length === 0) {
        if (selectedDevice) setSelectedDevice("")
      } else if (!deviceOptions.some((option) => option.id === selectedDevice)) {
        setSelectedDevice(deviceOptions[0]?.id ?? "")
      }
      return
    }

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
  }, [deviceOptions, newSessionProject, preference?.connectorId, preferenceLoaded, selectedDevice])

  React.useEffect(() => {
    setWorkspace((current) => {
      if (!current) return current
      if (current.connectorId && current.connectorId !== selectedConnectorId) return null
      if (current.projectId && !projects.some((project) => (
        project.id === current.projectId && project.connectorId === selectedConnectorId
      ))) return null
      return current
    })
  }, [projects, selectedConnectorId])

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
      setRuntimeCapabilities(null)
      setCatalogsLoading(false)
      return
    }
    let cancelled = false
    setCatalogsLoading(true)
    setModelCatalog(null)
    setPermissionCatalog(null)
    setRuntimeCapabilities(null)
    dashboardApi.getConnectorRuntimeCapabilities(
      authSession.accessToken,
      selectedConnectorId,
      selectedAgent,
    )
      .then(async (capabilitiesResponse) => {
        const capabilitySet = capabilitiesResponse.capabilitySet
        const canUseModelCatalog = capabilityIsUsable(
          capabilitySet,
          CAPABILITY.modelCatalog,
          selectedRuntimeScope,
        )
        const canUsePermissionCatalog = capabilityIsUsable(
          capabilitySet,
          CAPABILITY.permissionCatalog,
          selectedRuntimeScope,
        )
        const [modelCatalogResponse, permissionCatalogResponse] = await Promise.all([
          canUseModelCatalog
            ? dashboardApi.getConnectorRuntimeModelCatalog(
                authSession.accessToken,
                selectedConnectorId,
                selectedAgent,
              )
            : Promise.resolve(null),
          canUsePermissionCatalog
            ? dashboardApi.getConnectorRuntimePermissionCatalog(
                authSession.accessToken,
                selectedConnectorId,
                selectedAgent,
              )
            : Promise.resolve(null),
        ])
        return { capabilitySet, modelCatalogResponse, permissionCatalogResponse }
      })
      .then(({ capabilitySet, modelCatalogResponse, permissionCatalogResponse }) => {
        if (cancelled) return
        setRuntimeCapabilities(capabilitySet)
        setModelCatalog(modelCatalogResponse?.catalog ?? null)
        setPermissionCatalog(permissionCatalogResponse?.catalog ?? null)
      })
      .catch(() => {
        if (cancelled) return
        setRuntimeCapabilities(null)
        setModelCatalog(null)
        setPermissionCatalog(null)
      })
      .finally(() => {
        if (!cancelled) setCatalogsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [authSession?.accessToken, selectedAgent, selectedConnectorId, selectedRuntime?.runtimeType])

  const canUseModelCatalog = capabilityIsUsable(
    runtimeCapabilities,
    CAPABILITY.modelCatalog,
    selectedRuntimeScope,
  )
  const canUsePermissionCatalog = capabilityIsUsable(
    runtimeCapabilities,
    CAPABILITY.permissionCatalog,
    selectedRuntimeScope,
  )
  const canUseAttachments = capabilityIsUsable(
    runtimeCapabilities,
    CAPABILITY.attachment,
    selectedRuntimeScope,
  )

  const models = React.useMemo(
    () => modelCatalog?.models.map((item) => ({
      id: item.id,
      label: modelCatalogDisplayName(
        item,
        modelCatalog.models,
        catalogI18nText(t, item.metadata, "labelKey", item.displayName),
        t("defaultReasoning"),
      ),
      default: item.default,
      enabled: catalogItemEnabled(item),
      disabledReason: catalogItemDisabledReason(item),
      selectionId: item.selectionId,
      reasoningItems: item.reasoningItems.map((reasoning) => ({
        id: reasoning.id,
        label: catalogI18nText(t, reasoning.metadata, "labelKey", reasoning.displayName),
        default: reasoning.default,
        enabled: catalogItemEnabled(reasoning),
        disabledReason: catalogItemDisabledReason(reasoning),
        selectionId: reasoning.selectionId,
      })),
    })) ?? [],
    [modelCatalog, t],
  )
  const selectedModelItem = models.find((item) => item.id === selectedModel)
  const reasoningOptions = selectedModelItem?.reasoningItems ?? []
  const permissionOptions = React.useMemo(
    () => permissionCatalog?.permissions.map((item) => ({
      id: item.id,
      label: catalogI18nText(t, item.metadata, "labelKey", item.displayName),
      description: catalogI18nText(t, item.metadata, "descriptionKey", item.description),
      default: item.default,
      enabled: catalogItemEnabled(item),
      disabledReason: catalogItemDisabledReason(item),
      selectionId: item.selectionId,
    })) ?? [],
    [permissionCatalog, t],
  )

  React.useEffect(() => {
    const nextModel = models.find((option) => option.default && option.enabled)?.id
      ?? models.find((option) => option.enabled)?.id
      ?? ""
    setSelectedModel((current) => current && models.some((option) => option.id === current && option.enabled) ? current : nextModel)
  }, [models])

  React.useEffect(() => {
    const nextPermissionMode = permissionOptions.find((option) => option.default && option.enabled)?.id
      ?? permissionOptions.find((option) => option.enabled)?.id
      ?? ""
    setSelectedPermissionMode((current) =>
      current && permissionOptions.some((option) => option.id === current && option.enabled) ? current : nextPermissionMode,
    )
  }, [permissionOptions])

  React.useEffect(() => {
    const nextEffort = reasoningOptions.find((option) => option.default && option.enabled)?.id
      ?? reasoningOptions.find((option) => option.enabled)?.id
      ?? ""
    setSelectedReasoning((current) =>
      current && reasoningOptions.some((option) => option.id === current && option.enabled) ? current : nextEffort,
    )
  }, [reasoningOptions])

  React.useEffect(() => {
    setSelectedReasoning((current) => {
      if (!current) return current
      return reasoningOptions.some((option) => option.id === current && option.enabled) ? current : ""
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

    const modelSelection = modelIdsForSelectionId(modelCatalog, selectionPreference.model)
    if (modelSelection && models.some((option) => option.id === modelSelection.modelId && option.enabled)) {
      setSelectedModel(modelSelection.modelId)
      setSelectedReasoning(modelSelection.reasoningId)
    }

    const permissionSelection = permissionIdForSelectionId(
      permissionCatalog,
      selectionPreference.permission,
    )
    if (permissionSelection && permissionOptions.some((option) => option.id === permissionSelection && option.enabled)) {
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
  const selectedModelSelection = selectionIdForModelCatalog(modelCatalog, selectedModel, selectedReasoning)
  const selectedPermissionSelection = selectionIdForPermissionCatalog(permissionCatalog, selectedPermissionMode)
  const requiresModelSelection = canUseModelCatalog && models.length > 0
  const requiresPermissionSelection = canUsePermissionCatalog && permissionOptions.length > 0
  const hasSelectionSettings = models.length > 0 || permissionOptions.length > 0
  const canCreate =
    Boolean(authSession?.accessToken && selectedConnector && selectedRuntime && workspace?.projectId) &&
    !creating &&
    !catalogsLoading &&
    (!requiresModelSelection || Boolean(selectedModelSelection)) &&
    (!requiresPermissionSelection || Boolean(selectedPermissionSelection)) &&
    (attachments.length === 0 || canUseAttachments) &&
    (prompt.trim().length > 0 || attachments.length > 0)
  const selectorsLoading =
    runtimeInventoryLoading || (
      Boolean(authSession?.accessToken && hasOnlineDevice && selectedConnector && selectedAgent) && catalogsLoading
    )
  const compactSelectors = composerWidth > 0 && composerWidth < 640

  const handleCreate = async () => {
    if (!authSession?.accessToken || !selectedConnector || !selectedRuntime || !workspace?.projectId || !workspace.path || creating) return
    if (!prompt.trim() && attachments.length === 0) return
    if (catalogsLoading) return
    if (requiresModelSelection && !selectedModelSelection) return
    if (requiresPermissionSelection && !selectedPermissionSelection) return
    if (attachments.length > 0 && !canUseAttachments) return
    const localSessionId = createClientId("session")
    const clientMessageId = createClientId("msg")
    const messageText = prompt.trim() || t("attachmentOnlyPrompt")
    const selectedAttachments = attachments
    const now = new Date().toISOString()
    const optimisticSession: RealSessionView = {
      id: localSessionId,
      connectorId: selectedConnector.id,
      projectId: workspace.projectId,
      connectorStatus: selectedConnector.status,
      runtime: selectedRuntime?.runtimeType ?? selectedAgent,
      runtimeId: selectedRuntime?.runtimeId ?? selectedAgent,
      runtimeType: selectedRuntime?.runtimeType ?? selectedAgent,
      runtimeName: selectedRuntime ? runtimeInstanceName(selectedRuntime) : null,
      runtimeTypeDisplayName: selectedRuntime ? runtimeTypeName(selectedRuntime) : null,
      externalSessionId: null,
      title: prompt.trim() || null,
      cwd: workspace.path,
      status: "waiting",
      takeover: true,
      pinned: false,
      pinnedAt: null,
      archived: false,
      archivedAt: null,
      unread: false,
      lastReadSeq: 0,
      latestTurnEndSeq: 0,
      lastSyncedAt: null,
      sourceObservedAt: null,
      lastActivityAt: now,
      lastItemAt: now,
      lastItemOrderSeq: 1,
      sortAt: now,
      updatedSeq: 1,
      effectiveRunMode: "chat",
    }
    const optimisticState = {
      sessionId: localSessionId,
      runtime: selectedRuntime?.runtimeType ?? selectedAgent,
      runtimeId: selectedRuntime?.runtimeId ?? selectedAgent,
      runtimeType: selectedRuntime?.runtimeType ?? selectedAgent,
      externalSessionId: null,
      status: "waiting" as const,
      selections: {
        ...(selectedModelSelection ? { model: selectedModelSelection } : {}),
        ...(selectedPermissionSelection ? { permission: selectedPermissionSelection } : {}),
      },
      statusReason: null,
      error: null,
      metadata: {},
      updatedSeq: 1,
      createdAt: now,
      updatedAt: now,
    }
    addOptimisticMessage({
      clientMessageId,
      sessionId: localSessionId,
      localSessionId,
      session: optimisticSession,
      state: optimisticState,
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
      const selections = {
        ...(selectedModelSelection ? { model: selectedModelSelection } : {}),
        ...(selectedPermissionSelection ? { permission: selectedPermissionSelection } : {}),
      }
      const createBody = {
        connectorId: selectedConnector.id,
        projectId: workspace.projectId,
        ...sessionRuntimeRequestIdentity(
          selectedRuntime?.runtimeType ?? selectedAgent,
          selectedRuntime?.runtimeId ?? selectedAgent,
        ),
        title: prompt.trim() || undefined,
        cwd: workspace.path,
      }
      const nextPreference = withNewSessionSelectionPreference(
        preference,
        selectedConnector.id,
        selectedAgent,
        {
          model: selectedModelSelection,
          permission: selectedPermissionSelection,
        },
      )
      writeNewSessionPreference(nextPreference)
      setPreference(nextPreference)
      const created = await dashboardApi.createAndStartSession(authSession.accessToken, {
        ...createBody,
        content: messageText,
        selections,
        attachments: selectedAttachments.length > 0
          ? await inlineAttachmentsFromFiles(selectedAttachments)
          : undefined,
        clientMessageId,
      })
      bindOptimisticSession(localSessionId, created.session, created.attachments)
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
      </div>

      <div className="w-full max-w-3xl">
        <h1 className="mb-6 flex h-10 items-center justify-center overflow-hidden text-center text-3xl font-semibold leading-tight tracking-tight sm:h-auto sm:min-h-[3rem] sm:text-4xl" aria-live="polite">
          <span className="min-w-0 truncate">{creating ? `${t("creatingBase")}${".".repeat((createTick % 3) + 1)}` : typedTitle}</span>
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
              disabled={!canUseAttachments}
            />
            {attachments.length > 0 && !canUseAttachments ? (
              <span className="px-2 text-xs text-amber-600 dark:text-amber-400">
                {t("attachmentsUnsupported")}
              </span>
            ) : null}

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
                    modelLabel={t("model")}
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
                            disabled={!item.enabled}
                            className={cn(
                              "items-start gap-2 py-2.5",
                              selectedPermissionMode === item.id && "text-primary focus:text-primary",
                            )}
                            onSelect={() => setSelectedPermissionMode(item.id)}
                          >
                            <Check className={cn("mt-0.5 size-3.5", selectedPermissionMode === item.id ? "opacity-100" : "opacity-0")} />
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium leading-none">{item.label}</span>
                              {(item.enabled ? item.description : item.disabledReason) ? (
                                <span className="mt-1 block whitespace-normal text-xs leading-snug text-muted-foreground">
                                  {item.enabled ? item.description : item.disabledReason}
                                </span>
                              ) : null}
                            </span>
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
                                  disabled={!modelItem.enabled}
                                  className="gap-2"
                                  onSelect={() => {
                                    setSelectedModel(modelItem.id)
                                    setSelectedReasoning("")
                                  }}
                                >
                                  <Check className={cn("size-3.5", selectedModel === modelItem.id ? "opacity-100" : "opacity-0")} />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate">{modelItem.label}</span>
                                    {!modelItem.enabled && modelItem.disabledReason ? (
                                      <span className="block truncate text-xs text-muted-foreground">
                                        {modelItem.disabledReason}
                                      </span>
                                    ) : null}
                                  </span>
                                </DropdownMenuItem>
                              )
                            }
                            return (
                              <DropdownMenuSub key={modelItem.id}>
                                <DropdownMenuSubTrigger className="gap-2" disabled={!modelItem.enabled}>
                                  <Check className={cn("size-3.5", selectedModel === modelItem.id ? "opacity-100" : "opacity-0")} />
                                  <span className="max-w-40 truncate" title={modelItem.disabledReason ?? undefined}>
                                    {modelItem.label}
                                  </span>
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="w-56">
                                  {modelEfforts.map((item) => (
                                    <DropdownMenuItem
                                      key={item.id}
                                      disabled={!item.enabled}
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
                                      <span className="min-w-0 flex-1">
                                        <span className="block truncate">{item.label}</span>
                                        {!item.enabled && item.disabledReason ? (
                                          <span className="block truncate text-xs text-muted-foreground">
                                            {item.disabledReason}
                                          </span>
                                        ) : null}
                                      </span>
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
            includeProjects
            onCreateProject={() => setProjectEditor({ mode: "create" })}
          />
        </div>
      </div>

      <ProjectEditorDialog
        editor={projectEditor}
        connectors={connectors}
        onOpenChange={(open) => {
          if (!open) setProjectEditor(null)
        }}
        onCreate={createAndSelectProject}
        onUpdate={updateProject}
      />
    </div>
  )
}

function activeRuntimes(runtimes: DeviceRuntimeView[] | undefined) {
  return (runtimes ?? [])
    .filter((runtime) => runtime.configured && runtime.active && runtime.status === "running")
    .sort((a, b) => runtimeInstanceName(a).localeCompare(runtimeInstanceName(b)))
}

function runtimeOptionLabel(runtime: DeviceRuntimeView): string {
  const instanceName = runtimeInstanceName(runtime)
  const typeName = runtimeTypeName(runtime)
  return instanceName === typeName ? instanceName : `${instanceName} · ${typeName}`
}

function sameRuntimeInventory(
  left: Record<string, DeviceRuntimeView[]>,
  right: Record<string, DeviceRuntimeView[]>,
): boolean {
  return stableRuntimeInventoryKey(left) === stableRuntimeInventoryKey(right)
}

function stableRuntimeInventoryKey(value: Record<string, DeviceRuntimeView[]>): string {
  return Object.keys(value)
    .sort()
    .map((connectorId) => {
      const runtimes = [...(value[connectorId] ?? [])]
        .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId))
        .map((runtime) => [
          runtime.runtimeId,
          runtime.runtimeType,
          runtime.displayName,
          runtime.present,
          runtime.configured,
          runtime.active,
          runtime.status,
          runtime.updatedAt,
        ].join(":"))
        .join(",")
      return `${connectorId}=${runtimes}`
    })
    .join("|")
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
    const model = typeof selection.model === "string" && selection.model
      ? selection.model
      : null
    const permission = typeof selection.permission === "string" && selection.permission
      ? selection.permission
      : null
    if (!model && !permission) continue
    result[scope] = {
      model,
      permission,
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
        model: selection.model ?? null,
        permission: selection.permission ?? null,
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
