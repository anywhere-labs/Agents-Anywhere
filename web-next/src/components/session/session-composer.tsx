"use client"

import * as React from "react"
import { ArrowUp, Check, ChevronDown, Loader2, Square } from "lucide-react"

import { Button } from "@/components/ui/button"
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
  SessionView,
} from "@/features/dashboard/types"
import { useTranslations } from "next-intl"
import {
  modelIdsForSelectionId,
  modelSelectionIdForCatalog,
  permissionIdForSelectionId,
  permissionSelectionIdForCatalog,
} from "@/components/session/catalog-selection"
import { SelectionSettingsDrawer } from "@/components/session/selection-settings-drawer"
import { CAPABILITY, capabilityIsUsable, findCapability } from "@/components/session/capabilities"
import { useElementWidth } from "@/hooks/use-element-width"

export type { AttachedFile }

export type SessionCommandId = "help" | "interrupt" | "release" | "takeover"

export function SessionComposer({
  session,
  pendingInteractionCount,
  creatingSession = false,
  sending,
  interrupting,
  takeoverBusy,
  value,
  effectiveCapabilities,
  modelCatalog,
  permissionCatalog,
  onValueChange,
  onSend,
  onInterrupt,
  onCommand,
  onToggleTakeover,
}: {
  session: SessionView
  pendingInteractionCount: number
  creatingSession?: boolean
  sending: boolean
  interrupting: boolean
  takeoverBusy: boolean
  value: string
  effectiveCapabilities: ProtocolCapabilitySet | null
  modelCatalog: ProtocolModelCatalog | null
  permissionCatalog: ProtocolPermissionCatalog | null
  onValueChange: (value: string) => void
  onSend: (
    content: string,
    attachments: AttachedFile[],
    selections: { modelSelectionId?: string; permissionSelectionId?: string },
  ) => Promise<boolean>
  onInterrupt: () => void
  onCommand: (command: SessionCommandId, options: { args: string[]; raw: string }) => void
  onToggleTakeover: () => void
}) {
  const tSession = useTranslations("dashboard.session")
  const tNew = useTranslations("dashboard.new")
  const { attachments, isDragging, add, remove, clear, onDragEnter, onDragLeave, onDragOver, onDrop } =
    useAttachments()
  const composerRef = React.useRef<HTMLDivElement | null>(null)
  const composerWidth = useElementWidth(composerRef)
  const isBusy = session.status === "running" || session.status === "blocked"
  const isStopping = session.status === "stopping"
  const isPending = session.status === "pending"
  const connectorOnline = session.connectorStatus === "online"
  const canUseSendMessage = capabilityIsUsable(effectiveCapabilities, CAPABILITY.sendMessage)
  const canUseInterrupt = capabilityIsUsable(effectiveCapabilities, CAPABILITY.interrupt)
  const interruptCapability = findCapability(effectiveCapabilities, CAPABILITY.interrupt)
  const canUseModelCatalog = capabilityIsUsable(effectiveCapabilities, CAPABILITY.modelCatalog)
  const canUsePermissionCatalog = capabilityIsUsable(effectiveCapabilities, CAPABILITY.permissionCatalog)
  const canUseEffortCatalog = capabilityIsUsable(effectiveCapabilities, CAPABILITY.effortCatalog)
  const canSend =
    canUseSendMessage &&
    !creatingSession &&
    !sending &&
    !interrupting
  const canRunCommand = !creatingSession && !sending && !interrupting && connectorOnline
  const hasInput = value.trim().length > 0 || attachments.length > 0
  const activeSessionCanInterrupt = Boolean(
    connectorOnline &&
    interruptCapability?.supported &&
    interruptCapability.allowed &&
    (isPending || isBusy),
  )
  const showInterrupt = !creatingSession && (canUseInterrupt || activeSessionCanInterrupt)
  const [selectedPermissionMode, setSelectedPermissionMode] = React.useState("")
  const [selectedModel, setSelectedModel] = React.useState("")
  const [selectedReasoning, setSelectedReasoning] = React.useState("")
  const permissionItems = permissionCatalog?.permissions.map((item) => ({
    id: item.id,
    label: item.displayName,
    default: item.default,
    selectionId: item.selectionId,
  })) ?? []
  const modelItems = modelCatalog?.models.map((item) => ({
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
  })) ?? []
  const selectedModelItem = modelItems.find((item) => item.id === selectedModel)
  const effortItems = selectedModelItem?.reasoningItems ?? []
  const modelSelectionValue = modelIdsForSelectionId(modelCatalog, session.modelSelectionId)
  const permissionSelectionValue = permissionIdForSelectionId(permissionCatalog, session.permissionSelectionId)
  const permissionValue = permissionSelectionValue
  const modelValue = modelSelectionValue?.modelId ?? ""
  const effortValue = modelSelectionValue?.reasoningId ?? ""
  const permissionLabel =
    permissionItems.find((item) => item.id === selectedPermissionMode)?.label ?? tNew("permissionMode")
  const modelLabel = selectedModelItem?.label ?? tNew("model")
  const effortLabel = effortItems.find((item) => item.id === selectedReasoning)?.label ?? tNew("reasoning")
  const hasSelectors = Boolean(permissionItems.length > 0 || modelItems.length > 0)
  const compactSelectors = hasSelectors && composerWidth > 0 && composerWidth < 560
  const permissionSelectorDisabled = creatingSession || !canUsePermissionCatalog
  const modelSelectorDisabled = creatingSession || !canUseModelCatalog
  const effortSelectorDisabled = creatingSession || !canUseEffortCatalog
  const selectorsDisabled = permissionSelectorDisabled && modelSelectorDisabled

  React.useEffect(() => {
    const nextPermission = permissionItems.some((item) => item.id === permissionValue)
      ? permissionValue
      : permissionItems.find((item) => item.default)?.id ?? permissionItems[0]?.id ?? ""
    setSelectedPermissionMode((current) =>
      current && permissionItems.some((item) => item.id === current) ? current : nextPermission,
    )
  }, [permissionItems, permissionValue])

  React.useEffect(() => {
    const nextModel = modelItems.some((item) => item.id === modelValue)
      ? modelValue
      : modelItems.find((item) => item.default)?.id ?? modelItems[0]?.id ?? ""
    setSelectedModel((current) => current && modelItems.some((item) => item.id === current) ? current : nextModel)
  }, [modelItems, modelValue])

  React.useEffect(() => {
    const nextEffort = effortItems.some((item) => item.id === effortValue)
      ? effortValue
      : effortItems.find((item) => item.default)?.id ?? effortItems[0]?.id ?? ""
    setSelectedReasoning((current) => current && effortItems.some((item) => item.id === current) ? current : nextEffort)
  }, [effortItems, effortValue])
  const modelSelectionId = modelSelectionIdForCatalog(modelCatalog, selectedModel, selectedReasoning)
  const permissionSelectionId = permissionSelectionIdForCatalog(permissionCatalog, selectedPermissionMode)
  const placeholder = creatingSession
    ? tSession("creatingPlaceholder")
    : !session.takeover
    ? tSession("readOnlyPlaceholder")
    : !connectorOnline
      ? tSession("deviceOfflinePlaceholder")
      : pendingInteractionCount > 0
        ? tSession("waitingApprovalPlaceholder")
        : isPending
          ? tSession("pendingPlaceholder")
          : isStopping || isBusy
            ? tSession("busyPlaceholder")
            : tSession("replyPlaceholder")
  const commandQuery = commandQueryFromValue(value)
  const commandSuggestions = React.useMemo(
    () =>
      sessionCommands({
        canInterrupt: showInterrupt && !interrupting,
        canRelease: session.takeover,
        canTakeover: !session.takeover && connectorOnline && !takeoverBusy && !creatingSession,
        t: tSession,
      }).filter((command) =>
        commandQuery === null
          ? false
          : command.id.includes(commandQuery) ||
            command.label.toLowerCase().includes(commandQuery) ||
            command.aliases.some((alias) => alias.includes(commandQuery)),
      ),
    [
      commandQuery,
      connectorOnline,
      creatingSession,
      interrupting,
      session.takeover,
      showInterrupt,
      tSession,
      takeoverBusy,
    ],
  )
  const showCommandMenu = commandQuery !== null && attachments.length === 0
  const canSubmitCommand = commandQuery !== null && attachments.length === 0 && canRunCommand
  const canSubmitMessage = canSend && session.takeover && hasInput

  const submit = async () => {
    if (!hasInput) return
    const command = commandFromValue(value, commandSuggestions)
    if (commandQuery !== null && attachments.length === 0) {
      if (command && canRunCommand) {
        const parsed = parseCommandValue(value)
        onValueChange("")
        onCommand(command.id, { args: parsed.args, raw: parsed.raw })
      }
      return
    }
    if (!canSubmitMessage) return
    const text = value
    const files = attachments
    onValueChange("")
    clear()
    await onSend(text, files, {
      ...(modelSelectionId ? { modelSelectionId } : {}),
      ...(permissionSelectionId ? { permissionSelectionId } : {}),
    })
  }

  const primaryAction = () => {
    if (showInterrupt) {
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
      <div className="mx-auto w-full max-w-3xl space-y-2">
        <div
          ref={composerRef}
          className={cn(
            "relative rounded-2xl border border-border bg-card/85 shadow-sm backdrop-blur-xl transition-colors supports-backdrop-filter:bg-card/70 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
            isDragging && "border-primary bg-primary/5",
          )}
        >
          {isDragging ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-background/75 text-sm font-medium text-foreground backdrop-blur-sm">
              {tSession("dropFiles")}
            </div>
          ) : null}
          <div className="space-y-3 px-4 pt-4">
            <AttachmentPreviewList attachments={attachments} onRemove={remove} />
            {showCommandMenu ? (
              <div className="rounded-xl border border-border bg-popover p-1 text-sm shadow-sm">
                {commandSuggestions.length > 0 ? (
                  commandSuggestions.map((command) => (
                    <button
                      key={command.id}
                      type="button"
                      className={cn(
                        "flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
                        command.disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-current",
                      )}
                      disabled={command.disabled}
                      onClick={() => {
                        if (command.disabled) return
                        onValueChange("")
                        onCommand(command.id, { args: [], raw: `/${command.id}` })
                      }}
                    >
                      <span className="code-mono shrink-0 text-xs text-primary">/{command.id}</span>
                      <span className="min-w-0">
                        <span className="block font-medium">{command.label}</span>
                        <span className="block text-xs text-muted-foreground">{command.description}</span>
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-2 text-xs text-muted-foreground">{tSession("commandNoMatches")}</div>
                )}
              </div>
            ) : null}
            <Textarea
              value={value}
              onChange={(event) => onValueChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  primaryAction()
                }
              }}
              placeholder={placeholder}
              disabled={!connectorOnline || creatingSession}
              className="min-h-12 max-h-40 resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1 px-3 pb-3 pt-2">
            <AttachmentButton
              attachments={attachments}
              onAttach={add}
              isDragging={isDragging}
              className="size-8"
            />
            {hasSelectors ? (
              compactSelectors ? (
                <SelectionSettingsDrawer
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
                  onPermissionChange={setSelectedPermissionMode}
                  modelItems={modelItems}
                  selectedModel={selectedModel}
                  selectedReasoning={selectedReasoning}
                  onModelChange={(modelId, reasoningId) => {
                    setSelectedModel(modelId)
                    setSelectedReasoning(reasoningId)
                  }}
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
                        className="h-8 gap-1.5 rounded-xl px-2.5 text-muted-foreground"
                        disabled={permissionSelectorDisabled}
                      >
                        <span className="size-1.5 rounded-full bg-primary" />
                        <span className="text-foreground">{permissionLabel}</span>
                        <ChevronDown className="size-3.5 opacity-60" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64">
                      {permissionItems.map((item) => (
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
                  </DropdownMenu>
                ) : null}
                {modelItems.length > 0 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 rounded-xl px-2.5 text-muted-foreground"
                        disabled={modelSelectorDisabled}
                      >
                        {effortItems.length > 0 ? <span className="text-foreground">{effortLabel}</span> : null}
                        {effortItems.length > 0 ? <span className="text-muted-foreground/50">·</span> : null}
                        <span className="max-w-40 truncate text-foreground">{modelLabel}</span>
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
                              <DropdownMenuSubTrigger className="gap-2" disabled={effortSelectorDisabled}>
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
                "ml-auto flex h-8 items-center gap-2 rounded-xl px-2.5 text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
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
            <span className="mx-1 h-5 w-px bg-border" />
            <Button
              type="button"
              size="icon"
              aria-label={showInterrupt ? tSession("interrupt") : tSession("send")}
              className={cn("size-8 rounded-full", showInterrupt && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
              disabled={showInterrupt ? interrupting : !(canSubmitCommand || canSubmitMessage)}
              onClick={primaryAction}
            >
              {sending || interrupting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : showInterrupt ? (
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

type SessionCommand = {
  id: SessionCommandId
  label: string
  description: string
  aliases: string[]
  disabled?: boolean
}

function sessionCommands({
  canInterrupt,
  canRelease,
  canTakeover,
  t,
}: {
  canInterrupt: boolean
  canRelease: boolean
  canTakeover: boolean
  t: ReturnType<typeof useTranslations>
}): SessionCommand[] {
  return [
    {
      id: "help",
      label: t("commandHelp"),
      description: t("commandHelpDescription"),
      aliases: ["commands", "?"],
    },
    {
      id: "interrupt",
      label: t("commandInterrupt"),
      description: t("commandInterruptDescription"),
      aliases: ["stop", "cancel"],
      disabled: !canInterrupt,
    },
    {
      id: "takeover",
      label: t("commandTakeover"),
      description: t("commandTakeoverDescription"),
      aliases: ["control"],
      disabled: !canTakeover,
    },
    {
      id: "release",
      label: t("commandRelease"),
      description: t("commandReleaseDescription"),
      aliases: ["readonly", "read-only"],
      disabled: !canRelease,
    },
  ]
}

function commandQueryFromValue(value: string): string | null {
  const parsed = parseCommandValue(value)
  return parsed.command
}

function commandFromValue(value: string, suggestions: SessionCommand[]): SessionCommand | null {
  const parsed = parseCommandValue(value)
  const query = parsed.command
  if (query === null) return null
  const exact = suggestions.find((command) => command.id === query || command.aliases.includes(query))
  if (exact && !exact.disabled) return exact
  if (parsed.args.length > 0) return null
  const onlyEnabled = suggestions.filter((command) => !command.disabled)
  return onlyEnabled.length === 1 ? onlyEnabled[0] ?? null : null
}

function parseCommandValue(value: string): { command: string | null; args: string[]; raw: string } {
  const raw = value.trim()
  if (!raw.startsWith("/") || raw.includes("\n")) return { command: null, args: [], raw }
  const parts = raw.slice(1).split(/\s+/).filter(Boolean)
  const command = parts[0]?.toLowerCase() ?? ""
  return {
    command: command || null,
    args: parts.slice(1),
    raw,
  }
}
