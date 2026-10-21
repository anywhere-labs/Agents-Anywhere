"use client"

import * as React from "react"
import { ArrowUp, Check, ChevronDown, Loader2, Square, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  AttachmentButton,
  AttachmentPreviewList,
  DragOverlay,
  useAttachments,
  type AttachedFile,
} from "@/components/attachment-input"
import { cn } from "@/lib/utils"
import type {
  ProtocolCapabilitySet,
  ProtocolModelCatalog,
  ProtocolPermissionCatalog,
  RuntimeCommand,
  RuntimeStatusValue,
  SessionRuntimeState,
  SessionView,
} from "@/features/dashboard/types"
import { useTranslations } from "next-intl"
import {
  catalogItemDisabledReason,
  catalogItemEnabled,
  catalogI18nText,
  isDshAutoReviewPermission,
  modelCatalogDisplayName,
  modelIdsForSelectionId,
  permissionIdForSelectionId,
  permissionCatalogI18nText,
  selectionIdForModelCatalog,
  selectionIdForPermissionCatalog,
} from "@/components/session/catalog-selection"
import { SelectionSettingsDrawer } from "@/components/session/selection-settings-drawer"
import { CAPABILITY, capabilityIsUsable, findCapability, attachmentMimeTypes } from "@/components/session/capabilities"
import { useElementWidth } from "@/hooks/use-element-width"
import { sessionRuntimeId, sessionRuntimeType } from "@/features/dashboard/runtime-instances"

import {
  commandBlock,
  commandLikeToken,
  commandMatchesQuery,
  commandRequest,
  commandUi,
  exactCommand,
  parseSlashIntent,
  slashMode,
  type CommandBlock,
  type CommandOutcome,
} from "@/components/session/runtime-command-model"

export type { AttachedFile }

export function SessionComposer({
  token,
  session,
  runtimeState,
  pendingInteractionCount,
  creatingSession = false,
  sending,
  interrupting,
  takeoverBusy,
  value,
  effectiveCapabilities,
  modelCatalog,
  permissionCatalog,
  runtimeCommands,
  commandsLoading = false,
  commandsError = false,
  onCommandQueryChange,
  onValueChange,
  onSelectionChange,
  onSend,
  onInterrupt,
  onCommand,
  onToggleTakeover,
}: {
  token: string
  session: SessionView
  runtimeState?: SessionRuntimeState | null
  pendingInteractionCount: number
  creatingSession?: boolean
  sending: boolean
  interrupting: boolean
  takeoverBusy: boolean
  value: string
  effectiveCapabilities: ProtocolCapabilitySet | null
  modelCatalog: ProtocolModelCatalog | null
  permissionCatalog: ProtocolPermissionCatalog | null
  runtimeCommands: RuntimeCommand[]
  commandsLoading?: boolean
  commandsError?: boolean
  onCommandQueryChange: (query: string | null) => void
  onValueChange: (value: string) => void
  onSelectionChange: (selections: { model?: string; permission?: string }) => Promise<boolean>
  onSend: (
    content: string,
    attachments: AttachedFile[],
    selections: { model?: string; permission?: string },
  ) => Promise<boolean>
  onInterrupt: () => void
  onCommand: (command: string, options: { args: string[]; raw: string }) => Promise<CommandOutcome>
  onToggleTakeover: () => void
}) {
  const tSession = useTranslations("dashboard.session")
  const tNew = useTranslations("dashboard.new")
  const composerRef = React.useRef<HTMLDivElement | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const valueRef = React.useRef(value)
  valueRef.current = value
  const pendingCommandRef = React.useRef(false)
  const sessionVisitRef = React.useRef({ id: session.id, sequence: 0 })
  if (sessionVisitRef.current.id !== session.id) {
    sessionVisitRef.current = { id: session.id, sequence: sessionVisitRef.current.sequence + 1 }
  }
  const requestSequenceRef = React.useRef(0)
  const activeCommandRequestRef = React.useRef<number | null>(null)
  const [commandPending, setCommandPending] = React.useState(false)
  const [commandFeedback, setCommandFeedback] = React.useState<CommandOutcome | null>(null)
  const [commandInputError, setCommandInputError] = React.useState<string | null>(null)
  const [resultExpanded, setResultExpanded] = React.useState(false)
  const [selectorRequest, setSelectorRequest] = React.useState(0)
  const [activeCommandIndex, setActiveCommandIndex] = React.useState(0)
  const [menuDismissedFor, setMenuDismissedFor] = React.useState<string | null>(null)
  const commandMenuId = React.useId()
  React.useEffect(() => {
    setCommandFeedback(null)
    setCommandInputError(null)
    setMenuDismissedFor(null)
    setCommandPending(false)
    setSelectorRequest(0)
    pendingCommandRef.current = false
    activeCommandRequestRef.current = null
    return () => { activeCommandRequestRef.current = null }
  }, [session.id])
  const composerWidth = useElementWidth(composerRef)
  const runtimeStatus = effectiveRuntimeStatus(runtimeState, session)
  const runtimeSelections = runtimeState?.selections ?? {}
  const dsh = sessionRuntimeType(session) === "dsh"
  const actualModel = runtimeState?.metadata.modelSelection as { provider?: string; model?: string; reasoningEffort?: string } | undefined
  const actualPermission = runtimeState?.metadata.permissionPreset as { id?: string; name?: string } | undefined
  const runtimeScope = {
    runtimeId: sessionRuntimeId(session),
    runtimeType: sessionRuntimeType(session),
  }
  const isRunning = runtimeStatus === "running"
  const isWaitingApproval = runtimeStatus === "waiting_approval"
  const isBlocked = runtimeStatus === "blocked"
  const isStopping = runtimeStatus === "stopping"
  const isWaiting = runtimeStatus === "waiting" || runtimeStatus === "pending"
  const isError = runtimeStatus === "error"
  const isDisconnected = runtimeStatus === "disconnected"
  const sourceUnavailable = session.archived
  const connectorOnline = session.connectorStatus === "online"
  const acceptsUserInput =
    connectorOnline &&
    !sourceUnavailable &&
    !isDisconnected &&
    !isWaiting &&
    !isRunning &&
    !isStopping &&
    !isWaitingApproval &&
    !isBlocked
  const canUseSendMessage = capabilityIsUsable(effectiveCapabilities, CAPABILITY.sendMessage, runtimeScope)
  const canUseCommands = capabilityIsUsable(effectiveCapabilities, CAPABILITY.commands, runtimeScope)
  const canUseInterrupt = capabilityIsUsable(effectiveCapabilities, CAPABILITY.interrupt, runtimeScope)
  const interruptCapability = findCapability(effectiveCapabilities, CAPABILITY.interrupt, runtimeScope)
  const canUseModelCatalog = capabilityIsUsable(effectiveCapabilities, CAPABILITY.modelCatalog, runtimeScope)
  const canUsePermissionCatalog = capabilityIsUsable(
    effectiveCapabilities,
    CAPABILITY.permissionCatalog,
    runtimeScope,
  )
  const canUseEffortCatalog = capabilityIsUsable(effectiveCapabilities, CAPABILITY.effortCatalog, runtimeScope)
  const canUseAttachments = capabilityIsUsable(effectiveCapabilities, CAPABILITY.attachment, runtimeScope)
  const allowedMimeTypes = React.useMemo(() => attachmentMimeTypes(effectiveCapabilities, runtimeScope), [effectiveCapabilities, runtimeScope])
  const {
    attachments,
    attachmentsAllowed,
    attachmentError,
    isDragging,
    uploadsPending,
    uploadFailed,
    allUploaded,
    add,
    remove,
    clear,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
  } = useAttachments({ sessionId: creatingSession ? undefined : session.id, token, enabled: canUseAttachments, allowedMimeTypes })
  const canSend =
    canUseSendMessage &&
    !creatingSession &&
    !sending &&
    !commandPending &&
    !interrupting &&
    acceptsUserInput
  const hasInput = value.trim().length > 0 || attachments.length > 0
  const attachmentsReady = attachmentsAllowed && (attachments.length === 0 || (allUploaded && !uploadsPending && !uploadFailed))
  const activeSessionCanInterrupt = Boolean(
    connectorOnline &&
    interruptCapability?.supported &&
    interruptCapability.allowed &&
    (isWaiting || isRunning || isStopping || isWaitingApproval || isBlocked),
  )
  const showInterrupt = !creatingSession && canUseInterrupt && activeSessionCanInterrupt
  const [selectedPermissionMode, setSelectedPermissionMode] = React.useState("")
  const [selectedModel, setSelectedModel] = React.useState("")
  const [selectedReasoning, setSelectedReasoning] = React.useState("")
  const permissionItems = permissionCatalog?.permissions.map((item) => ({
    id: item.id,
    label: permissionCatalogI18nText(tNew, permissionCatalog, item, "labelKey"),
    description: isDshAutoReviewPermission(permissionCatalog, item.id)
      ? undefined : permissionCatalogI18nText(tNew, permissionCatalog, item, "descriptionKey"),
    default: item.default,
    enabled: catalogItemEnabled(item),
    disabledReason: catalogItemDisabledReason(item),
    selectionId: item.selectionId,
    badge: isDshAutoReviewPermission(permissionCatalog, item.id) ? "EXP" : undefined,
  })) ?? []
  const modelItems = modelCatalog?.models.map((item) => ({
    id: item.id,
    label: modelCatalogDisplayName(
      item,
      modelCatalog.models,
      catalogI18nText(tNew, item.metadata, "labelKey", item.displayName),
      tNew("defaultReasoning"),
    ),
    default: item.default,
    enabled: catalogItemEnabled(item),
    disabledReason: catalogItemDisabledReason(item),
    selectionId: item.selectionId,
    reasoningItems: item.reasoningItems.map((reasoning) => ({
      id: reasoning.id,
      label: catalogI18nText(tNew, reasoning.metadata, "labelKey", reasoning.displayName),
      default: reasoning.default,
      enabled: catalogItemEnabled(reasoning),
      disabledReason: catalogItemDisabledReason(reasoning),
      selectionId: reasoning.selectionId,
    })),
  })) ?? []
  const selectedModelItem = modelItems.find((item) => item.id === selectedModel)
  const effortItems = selectedModelItem?.reasoningItems ?? []
  const modelSelectionValue = modelIdsForSelectionId(modelCatalog, runtimeSelections.model ?? null, dsh)
  const permissionSelectionValue = permissionIdForSelectionId(permissionCatalog, runtimeSelections.permission ?? null, dsh)
  const permissionValue = permissionSelectionValue
  const modelValue = modelSelectionValue?.modelId ?? ""
  const effortValue = modelSelectionValue?.reasoningId ?? ""
  const permissionLabel =
    permissionItems.find((item) => item.id === selectedPermissionMode)?.label ??
    (dsh && actualPermission
      ? catalogI18nText(tNew, { preset: actualPermission.id }, "labelKey", actualPermission.name)
      : null) ?? tNew("permissionMode")
  const modelLabel = selectedModelItem?.label ?? (dsh && actualModel?.model ? `${actualModel.model}（${actualModel.provider}）` : tNew("model"))
  const effortLabel = effortItems.find((item) => item.id === selectedReasoning)?.label ?? (dsh ? actualModel?.reasoningEffort : null) ?? tNew("reasoning")
  const hasSelectors = Boolean(permissionItems.length > 0 || modelItems.length > 0)
  const compactSelectors = hasSelectors && ((composerWidth > 0 && composerWidth < 560) || selectorRequest > 0)
  const permissionSelectorDisabled = creatingSession || sourceUnavailable || !connectorOnline || !canUsePermissionCatalog
  const modelSelectorDisabled = creatingSession || sourceUnavailable || !connectorOnline || !canUseModelCatalog
  const effortSelectorDisabled = creatingSession || sourceUnavailable || !connectorOnline || !canUseEffortCatalog
  const selectorsDisabled = permissionSelectorDisabled && modelSelectorDisabled

  React.useEffect(() => {
    if (dsh) { setSelectedPermissionMode(permissionValue); return }
    const hasRuntimePermission = permissionItems.some((item) => item.id === permissionValue && item.enabled)
    const nextPermission = hasRuntimePermission
      ? permissionValue
      : permissionItems.find((item) => item.default && item.enabled)?.id
        ?? permissionItems.find((item) => item.enabled)?.id
        ?? ""
    setSelectedPermissionMode((current) =>
      hasRuntimePermission || !current || !permissionItems.some((item) => item.id === current && item.enabled)
        ? nextPermission
        : current,
    )
  }, [dsh, permissionItems, permissionValue])

  React.useEffect(() => {
    if (dsh) { setSelectedModel(modelValue); return }
    const hasRuntimeModel = modelItems.some((item) => item.id === modelValue && item.enabled)
    const nextModel = hasRuntimeModel
      ? modelValue
      : modelItems.find((item) => item.default && item.enabled)?.id
        ?? modelItems.find((item) => item.enabled)?.id
        ?? ""
    setSelectedModel((current) =>
      hasRuntimeModel || !current || !modelItems.some((item) => item.id === current && item.enabled) ? nextModel : current,
    )
  }, [dsh, modelItems, modelValue])

  React.useEffect(() => {
    if (dsh) { setSelectedReasoning(effortValue); return }
    const hasRuntimeEffort = effortItems.some((item) => item.id === effortValue && item.enabled)
    const nextEffort = hasRuntimeEffort
      ? effortValue
      : effortItems.find((item) => item.default && item.enabled)?.id
        ?? effortItems.find((item) => item.enabled)?.id
        ?? ""
    setSelectedReasoning((current) =>
      hasRuntimeEffort || !current || !effortItems.some((item) => item.id === current && item.enabled) ? nextEffort : current,
    )
  }, [dsh, effortItems, effortValue])
  const selectedModelSelection = selectionIdForModelCatalog(modelCatalog, selectedModel, selectedReasoning) ?? (dsh ? runtimeSelections.model : null)
  const selectedPermissionSelection = selectionIdForPermissionCatalog(permissionCatalog, selectedPermissionMode) ?? (dsh && actualPermission?.id !== 'custom' ? runtimeSelections.permission : null)
  const choosePermission = (permissionId: string) => {
    if (permissionId === selectedPermissionMode) return
    const previousPermission = selectedPermissionMode
    const nextSelection = selectionIdForPermissionCatalog(permissionCatalog, permissionId)
    if (!nextSelection) return
    setSelectedPermissionMode(permissionId)
    void onSelectionChange({ permission: nextSelection }).then((ok) => {
      if (!ok && !dsh) setSelectedPermissionMode(previousPermission)
    })
  }
  const chooseModel = (modelId: string, reasoningId: string) => {
    if (modelId === selectedModel && reasoningId === selectedReasoning) return
    const previousModel = selectedModel
    const previousReasoning = selectedReasoning
    const nextSelection = selectionIdForModelCatalog(modelCatalog, modelId, reasoningId)
    if (!nextSelection) return
    setSelectedModel(modelId)
    setSelectedReasoning(reasoningId)
    void onSelectionChange({ model: nextSelection }).then((ok) => {
      if (!ok && !dsh) {
        setSelectedModel(previousModel)
        setSelectedReasoning(previousReasoning)
      }
    })
  }
  const placeholder = creatingSession
    ? tSession("creatingPlaceholder")
    : sourceUnavailable
      ? tSession("sourceUnavailablePlaceholder")
    : !session.takeover
    ? tSession("readOnlyPlaceholder")
    : isDisconnected || !connectorOnline
      ? tSession("deviceOfflinePlaceholder")
      : pendingInteractionCount > 0
        ? tSession("waitingApprovalPlaceholder")
        : isWaiting
          ? tSession("pendingPlaceholder")
          : isStopping || isRunning
            ? tSession("busyPlaceholder")
            : isWaitingApproval || isBlocked
              ? tSession("waitingApprovalPlaceholder")
              : isError
                ? tSession("errorPlaceholder")
                : tSession("replyPlaceholder")
  const slashIntent = parseSlashIntent(value)
  // "/Users/me/file.ts" and other non-command slash text never opens the menu.
  const slashCandidate = slashIntent && commandLikeToken(slashIntent) ? slashIntent : null
  const commandQuery = slashCandidate?.command ?? null
  const catalogUsable = canUseCommands && connectorOnline
  const mode = slashMode(slashIntent, runtimeCommands, { usable: catalogUsable, loading: commandsLoading, error: commandsError })
  const commandSuggestions = React.useMemo(
    () => (commandQuery === null ? [] : runtimeCommands.filter((command) => commandMatchesQuery(command, commandQuery))),
    [commandQuery, runtimeCommands],
  )
  // A bare "/" in a session that cannot run commands explains why instead of
  // doing nothing, e.g. a runtime or bridge that predates native commands.
  const commandsCapability = findCapability(effectiveCapabilities, CAPABILITY.commands, runtimeScope)
  const commandsUnavailable =
    commandsCapability !== null && !catalogUsable && slashCandidate?.command === "" && slashCandidate.suffix === ""
      ? !connectorOnline
        ? tSession("commandBlocked_offline")
        : !commandsCapability.supported
          ? tSession("commandUnsupported")
          : commandsCapability.unavailableReason || tSession("commandBlocked_unavailable")
      : null
  const showUnavailableMenu = commandsUnavailable !== null && attachments.length === 0 && menuDismissedFor !== value
  const showCommandMenu =
    slashCandidate !== null &&
    catalogUsable &&
    slashCandidate.suffix === "" &&
    attachments.length === 0 &&
    menuDismissedFor !== value &&
    (commandSuggestions.length > 0 || (!runtimeCommands.length && (commandsLoading || commandsError)))
  const highlightedCommand = commandSuggestions.length
    ? commandSuggestions[Math.min(activeCommandIndex, commandSuggestions.length - 1)]
    : null
  React.useEffect(() => { setActiveCommandIndex(0) }, [commandQuery])
  const showInterruptAction = showInterrupt && mode.kind === "message" && !showCommandMenu
  React.useEffect(() => {
    onCommandQueryChange(commandQuery)
  }, [commandQuery, onCommandQueryChange])
  const commandBusy = sending || interrupting || commandPending
  const blockOf = (command: RuntimeCommand): CommandBlock | null => commandBusy ? "busy" : commandBlock(command, runtimeStatus, {
    capability: canUseCommands,
    writable: session.takeover && !sourceUnavailable && !creatingSession,
    online: connectorOnline,
  })
  const blockMessage = (command: RuntimeCommand, block: CommandBlock): string => {
    if (block !== "disabled") return tSession(`commandBlocked_${block}`)
    return command.disabledReason && tSession.has(`commandReason_${command.disabledReason}`)
      ? tSession(`commandReason_${command.disabledReason}`)
      : command.disabledReason || tSession("commandUnavailable")
  }
  const canSubmitCommand = mode.kind === "command" && !commandPending && connectorOnline
  const canSubmitMessage =
    canSend &&
    session.takeover &&
    hasInput &&
    attachmentsReady &&
    (attachments.length === 0 || canUseAttachments) && mode.kind === "message"
  const concurrentWriter = runtimeState?.error?.code === "DSH_CONCURRENT_WRITER_DETECTED"
  const updateValue = React.useCallback((nextValue: string) => {
    valueRef.current = nextValue
    onValueChange(nextValue)
    setCommandInputError(null)
  }, [onValueChange])

  const chooseCommand = (command: RuntimeCommand) => {
    const block = blockOf(command)
    if (block) { setCommandInputError(blockMessage(command, block)); return }
    const sourceDraft = valueRef.current
    const resolved = slashIntent && exactCommand(slashIntent, [command]) === command
    const raw = resolved ? sourceDraft : `/${command.id}`
    if (command.acceptsArgs) {
      updateValue(raw === `/${command.id}` ? `${raw} ` : raw)
      textareaRef.current?.focus()
      return
    }
    void runCommand(command, raw, sourceDraft)
  }
  const completeCommand = (command: RuntimeCommand) => {
    updateValue(`/${command.id}${command.acceptsArgs ? " " : ""}`)
    textareaRef.current?.focus()
  }

  const runCommand = async (command: RuntimeCommand, raw: string, sourceDraft = raw) => {
    if (pendingCommandRef.current) return
    const intent = parseSlashIntent(raw)
    const block = blockOf(command)
    if (block) { setCommandInputError(blockMessage(command, block)); return }
    if (attachments.length) { setCommandInputError(tSession("commandAttachments")); return }
    const request = commandRequest(intent, command)
    if (!request) { setCommandInputError(tSession(intent?.multiline ? "commandMultiline" : "commandInvalidArgs")); return }
    const ui = commandUi(command)
    if (ui?.kind === "selector") {
      // The existing settings drawer owns model, reasoning and permission selection.
      const available = ui.target === "model" ? modelItems.length > 0 && !modelSelectorDisabled
        : ui.target === "reasoning" ? effortItems.length > 0 && !effortSelectorDisabled
        : ui.target === "permission" ? permissionItems.length > 0 && !permissionSelectorDisabled : false
      if (!available) {
        setCommandInputError(tSession("commandUnavailable"))
        return
      }
      setSelectorRequest((current) => current + 1)
      return
    }
    const submittedVisit = sessionVisitRef.current
    const requestId = ++requestSequenceRef.current
    activeCommandRequestRef.current = requestId
    const isCurrentRequest = () => sessionVisitRef.current === submittedVisit && activeCommandRequestRef.current === requestId
    pendingCommandRef.current = true
    setCommandPending(true)
    setCommandFeedback(null)
    try {
      const outcome = await onCommand(command.id, { args: request.args, raw: request.raw })
      if (!isCurrentRequest()) return
      if (outcome.ok) {
        // Success is transient (and also shows in the timeline); only failures stay inline until dismissed.
        toast.success(tSession(outcome.state === "completed" ? "commandCompleted" : "commandAccepted"), {
          description: outcome.message ? (outcome.message.length > 200 ? `${outcome.message.slice(0, 200)}…` : outcome.message) : undefined,
        })
      } else {
        setCommandFeedback(outcome)
        setResultExpanded(false)
      }
      if (outcome.ok && valueRef.current === sourceDraft) updateValue("")
    } catch (error) {
      if (isCurrentRequest()) {
        setCommandFeedback({ok:false,state:"unknown",code:"command_outcome_unknown",message:error instanceof Error ? error.message : tSession("commandFailed"),result:null})
      }
    } finally {
      if (isCurrentRequest()) {
        activeCommandRequestRef.current = null
        pendingCommandRef.current = false
        setCommandPending(false)
      }
    }
  }

  const submit = async () => {
    if (!hasInput) return
    if (mode.kind === "pending") {
      setCommandInputError(tSession(commandsError ? "commandCatalogError" : "commandLoading"))
      return
    }
    if (mode.kind === "command") {
      if (attachments.length) { setCommandInputError(tSession("commandAttachments")); return }
      await runCommand(mode.command, value)
      return
    }
    if (!canSubmitMessage) return
    const text = value
    const files = attachments
    updateValue("")
    clear({ revokePreviews: false })
    const sent = await onSend(text, files, {
      ...(selectedModelSelection ? { model: selectedModelSelection } : {}),
      ...(selectedPermissionSelection ? { permission: selectedPermissionSelection } : {}),
    })
    if (!sent && valueRef.current === "") {
      updateValue(text)
    }
  }

  const primaryAction = () => {
    if (showInterruptAction) {
      onInterrupt()
      return
    }
    void submit()
  }

  return (
    <div
      className="shrink-0 px-4 pb-4 pt-2"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <DragOverlay isDragging={isDragging} />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {commandFeedback ? (
          <Alert variant="destructive" role="alert" className="pr-10">
            <AlertDescription>
              <span>{tSession(commandFeedback.state === "unknown" ? "commandUnknownOutcome" : "commandFailed")}</span>
              {commandFeedback.message ? <div className="mt-1 whitespace-pre-wrap break-words">{commandFeedback.message.length > 500 && !resultExpanded ? `${commandFeedback.message.slice(0, 500)}…` : commandFeedback.message}</div> : null}
              {commandFeedback.message && commandFeedback.message.length > 500 ? <Button type="button" variant="ghost" size="xs" onClick={() => setResultExpanded(!resultExpanded)}>{tSession(resultExpanded ? "commandLess" : "commandDetails")}</Button> : null}
            </AlertDescription>
            <Button type="button" variant="ghost" size="icon-xs" className="absolute right-2 top-2" aria-label={tSession("commandDismiss")} onClick={() => setCommandFeedback(null)}>
              <X className="size-3.5" />
            </Button>
          </Alert>
        ) : null}
        {concurrentWriter ? (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {tSession("dshConcurrentWriter")}
          </div>
        ) : null}
        <div
          ref={composerRef}
          className={cn(
            "relative rounded-2xl border border-border bg-card/85 shadow-sm backdrop-blur-xl transition-colors supports-backdrop-filter:bg-card/70 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
            isDragging && "border-primary bg-primary/5",
          )}
        >
          {showUnavailableMenu ? (
            <div
              role="status"
              className="absolute inset-x-0 bottom-full z-30 mb-2 rounded-xl border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-lg"
            >
              {commandsUnavailable}
            </div>
          ) : null}
          {showCommandMenu ? (
            <div
              id={commandMenuId}
              role="listbox"
              aria-label={tSession("commandMenu")}
              className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
              onMouseDown={(event) => event.preventDefault()}
            >
              {commandSuggestions.length > 0 ? (
                commandSuggestions.map((command, index) => {
                  const block = blockOf(command)
                  const ui = commandUi(command)
                  const hint = ui?.kind === "execute" ? ui.argumentHint : undefined
                  const highlighted = command === highlightedCommand
                  return (
                    <button
                      key={command.id}
                      id={`${commandMenuId}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={highlighted}
                      aria-disabled={block !== null}
                      className={cn(
                        "flex w-full items-baseline gap-3 rounded-lg px-3 py-2 text-left",
                        highlighted && "bg-accent text-accent-foreground",
                      )}
                      onMouseEnter={() => setActiveCommandIndex(index)}
                      onClick={() => chooseCommand(command)}
                    >
                      <span className={cn("code-mono shrink-0 text-xs", block ? "text-muted-foreground" : "text-primary")}>
                        /{command.id}{hint ? <span className="text-muted-foreground"> {hint}</span> : null}
                      </span>
                      <span className={cn("min-w-0 flex-1 truncate text-xs", block ? "text-muted-foreground/80" : "text-muted-foreground")}>
                        {block ? blockMessage(command, block) : command.description || command.title}
                      </span>
                    </button>
                  )
                })
              ) : commandsError ? (
                <div role="alert" className="px-3 py-2 text-xs text-destructive">{tSession("commandCatalogError")}</div>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {tSession("commandLoading")}
                </div>
              )}
            </div>
          ) : null}
          {isDragging ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-background/75 text-sm font-medium text-foreground backdrop-blur-sm">
              {tSession("dropFiles")}
            </div>
          ) : null}
          <div className="space-y-3 px-4 pt-4">
            <AttachmentPreviewList attachments={attachments} onRemove={remove} />
            {attachmentError ? <p role="alert" className="text-xs text-destructive">{attachmentError}</p> : null}
            {commandInputError ? <p role="alert" className="text-xs text-destructive">{commandInputError}</p> : null}
            <Textarea
              ref={textareaRef}
              value={value}
              onChange={(event) => updateValue(event.currentTarget.value)}
              role={catalogUsable ? "combobox" : undefined}
              aria-expanded={catalogUsable ? showCommandMenu : undefined}
              aria-controls={showCommandMenu ? commandMenuId : undefined}
              aria-autocomplete={catalogUsable ? "list" : undefined}
              aria-activedescendant={showCommandMenu && highlightedCommand ? `${commandMenuId}-${commandSuggestions.indexOf(highlightedCommand)}` : undefined}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if ((showCommandMenu || showUnavailableMenu) && event.key === "Escape") {
                  event.preventDefault()
                  setMenuDismissedFor(value)
                  return
                }
                if (showCommandMenu && highlightedCommand) {
                  const count = commandSuggestions.length
                  const index = commandSuggestions.indexOf(highlightedCommand)
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault()
                    setActiveCommandIndex((index + (event.key === "ArrowDown" ? 1 : count - 1)) % count)
                    return
                  }
                  if (event.key === "Tab" && !event.shiftKey) {
                    event.preventDefault()
                    completeCommand(highlightedCommand)
                    return
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    chooseCommand(highlightedCommand)
                    return
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  if (!showInterruptAction) void submit()
                }
              }}
              placeholder={placeholder}
              disabled={!connectorOnline || creatingSession || sourceUnavailable}
              className="min-h-12 max-h-40 resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
          {/* No wrapping: the option controls shrink instead, so the takeover
              switch and send button always stay on the same row. */}
          <div className="flex items-center gap-1 px-3 pb-3 pt-2">
            <AttachmentButton
              attachments={attachments}
              onAttach={add}
              isDragging={isDragging}
              className="size-8"
              allowedMimeTypes={allowedMimeTypes}
              disabled={!canUseAttachments || sourceUnavailable || creatingSession}
            />
            {hasSelectors ? (
              compactSelectors ? (
                <SelectionSettingsDrawer
                  requestOpenKey={selectorRequest}
                  onOpenChange={(open) => { if (!open) setSelectorRequest(0) }}
                  disabled={selectorsDisabled}
                  permissionDisabled={permissionSelectorDisabled}
                  modelDisabled={modelSelectorDisabled}
                  reasoningDisabled={effortSelectorDisabled}
                  buttonLabel={tNew("selectionSettings")}
                  title={tNew("selectionSettings")}
                  description={tNew("selectionSettingsDescription")}
                  permissionLabel={tNew("permissionMode")}
                  modelLabel={tNew("modelAndReasoning")}
                  reasoningLabel={tNew("reasoning")}
                  permissionItems={permissionItems}
                  selectedPermission={selectedPermissionMode}
                  onPermissionChange={choosePermission}
                  modelItems={modelItems}
                  selectedModel={selectedModel}
                  selectedReasoning={selectedReasoning}
                  onModelChange={chooseModel}
                />
              ) : (
                <>
                {permissionItems.length > 0 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 min-w-0 shrink gap-1.5 rounded-xl px-2.5 text-muted-foreground"
                        disabled={permissionSelectorDisabled}
                      >
                        <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                        <span className="min-w-0 truncate text-foreground">{permissionLabel}</span>
                        {permissionItems.find((item) => item.id === selectedPermissionMode)?.badge ? <Badge variant="secondary">EXP</Badge> : null}
                        <ChevronDown className="size-3.5 opacity-60" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64">
                      {permissionItems.map((item) => (
                        <DropdownMenuItem
                          key={item.id}
                          disabled={!item.enabled}
                          className={cn(
                            "items-start gap-2 py-2.5",
                            selectedPermissionMode === item.id && "text-primary focus:text-primary",
                          )}
                          onSelect={() => choosePermission(item.id)}
                        >
                          <Check className={cn("mt-0.5 size-3.5", selectedPermissionMode === item.id ? "opacity-100" : "opacity-0")} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2 font-medium leading-none">
                              <span>{item.label}</span>
                              {item.badge ? <Badge variant="secondary">{item.badge}</Badge> : null}
                            </span>
                            {(item.enabled ? item.description : item.disabledReason) ? (
                              <span className="mt-1 block whitespace-normal text-xs leading-snug text-muted-foreground">
                                {item.enabled ? item.description : item.disabledReason}
                              </span>
                            ) : null}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                {modelItems.length > 0 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 min-w-0 shrink gap-1.5 rounded-xl px-2.5 text-muted-foreground"
                        disabled={modelSelectorDisabled}
                      >
                        {effortItems.length > 0 ? <span className="text-foreground">{effortLabel}</span> : null}
                        {effortItems.length > 0 ? <span className="text-muted-foreground/50">·</span> : null}
                        <span className="min-w-0 max-w-40 truncate text-foreground">{modelLabel}</span>
                        <ChevronDown className="size-3.5 opacity-60" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      {modelItems.length > 0 ? (
                        modelItems.map((modelItem) => {
                          const modelEfforts = modelItem.reasoningItems
                          if (modelEfforts.length === 0) {
                            return (
                              <DropdownMenuItem
                                key={modelItem.id}
                                disabled={!modelItem.enabled}
                                className="gap-2"
                                onSelect={() => chooseModel(modelItem.id, "")}
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
                              <DropdownMenuSubTrigger
                                className="gap-2"
                                disabled={effortSelectorDisabled || !modelItem.enabled}
                              >
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
                                    onSelect={() => chooseModel(modelItem.id, item.id)}
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
                        })
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                </>
              )
            ) : null}
            <div
              role="switch"
              aria-checked={session.takeover}
              aria-disabled={!connectorOnline || takeoverBusy || creatingSession}
              tabIndex={connectorOnline && !takeoverBusy && !creatingSession ? 0 : -1}
              className={cn(
                "ml-auto flex h-8 shrink-0 items-center gap-2 rounded-xl px-2.5 text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                connectorOnline && !takeoverBusy && !creatingSession && "cursor-pointer hover:bg-accent hover:text-accent-foreground",
                (!connectorOnline || takeoverBusy || creatingSession) && "opacity-50",
                session.takeover && "text-foreground",
              )}
              onClick={() => {
                if (!connectorOnline || takeoverBusy || creatingSession) return
                onToggleTakeover()
              }}
              onKeyDown={(event) => {
                if (!connectorOnline || takeoverBusy || creatingSession) return
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  onToggleTakeover()
                }
              }}
            >
              {takeoverBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Switch
                  size="sm"
                  checked={session.takeover}
                  tabIndex={-1}
                  aria-hidden
                  className="pointer-events-none"
                />
              )}
              {tSession("takeover")}
            </div>
            <span className="mx-1 h-5 w-px shrink-0 bg-border" />
            <Button
              type="button"
              size="icon"
              aria-label={showInterruptAction ? tSession("interrupt") : tSession("send")}
              className={cn("size-8 rounded-full", showInterruptAction && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
              disabled={showInterruptAction ? interrupting : !(canSubmitCommand || canSubmitMessage)}
              onClick={primaryAction}
            >
              {sending || interrupting || commandPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : showInterruptAction ? (
                <Square className="size-4" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function effectiveRuntimeStatus(
  runtimeState: SessionRuntimeState | null | undefined,
  session: SessionView,
): RuntimeStatusValue {
  if (runtimeState) return runtimeState.status
  return session.connectorStatus === "offline" ? "disconnected" : session.status
}
