"use client"

import * as React from "react"
import { ArrowUp, Check, ChevronDown, Loader2, Square } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import {
  composerMenuOptions,
  effortFieldForModel,
  effectiveFieldValue,
  optionLabel,
  permissionLabelKey,
  runtimeConfigFields,
  validEffortValue,
} from "@/features/dashboard/runtime-config"
import { cn } from "@/lib/utils"
import type { RuntimeConfigSchema, SessionView } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"
import { stringSetting } from "@/components/session/session-utils"

export type { AttachedFile }

export function SessionComposer({
  session,
  pendingApprovalCount,
  error,
  sending,
  takeoverBusy,
  runtimeSchema,
  runtimeSettings,
  runtimeSettingsError,
  runtimeSettingsBusy,
  onDismissError,
  onPatchRuntimeSettings,
  onSend,
  onInterrupt,
  onToggleTakeover,
}: {
  session: SessionView
  pendingApprovalCount: number
  error: string | null
  sending: boolean
  takeoverBusy: boolean
  runtimeSchema: RuntimeConfigSchema | null
  runtimeSettings: Record<string, unknown> | null
  runtimeSettingsError: string | null
  runtimeSettingsBusy: boolean
  onDismissError: () => void
  onPatchRuntimeSettings: (settings: Record<string, unknown>) => void
  onSend: (content: string, attachments: AttachedFile[]) => void
  onInterrupt: () => void
  onToggleTakeover: () => void
}) {
  const tSession = useTranslations("dashboard.session")
  const tNew = useTranslations("dashboard.new")
  const [value, setValue] = React.useState("")
  const { attachments, isDragging, add, remove, clear, onDragEnter, onDragLeave, onDragOver, onDrop } =
    useAttachments()
  const isBusy = session.status === "running" || session.status === "waiting_approval"
  const connectorOnline = session.connectorStatus === "online"
  const canSend =
    connectorOnline &&
    session.takeover &&
    !sending &&
    (session.status === "idle" || session.status === "error")
  const hasInput = value.trim().length > 0 || attachments.length > 0
  const showInterrupt = isBusy && !hasInput
  const settingsFields = runtimeConfigFields(runtimeSchema, runtimeSettings, "session")
  const permissionField = settingsFields.find((field) => field.key === "permissionMode")
  const modelField = settingsFields.find((field) => field.key === "model")
  const rawEffortField = settingsFields.find((field) => field.key === "effort")
  const effortField = effortFieldForModel(
    modelField,
    rawEffortField,
    runtimeSettings?.model,
  )
  const effortFieldFor = (model: string) => effortFieldForModel(
    modelField,
    rawEffortField,
    model,
  )
  const patchModel = (model: string) => {
    const nextEffort = validEffortValue(effortFieldFor(model), runtimeSettings?.effort)
    onPatchRuntimeSettings(nextEffort ? { model, effort: nextEffort } : { model, effort: null })
  }
  const patchModelEffort = (model: string, effort: string) => {
    onPatchRuntimeSettings({ model, effort })
  }
  const permissionItems = composerMenuOptions(permissionField)
  const modelItems = composerMenuOptions(modelField)
  const effortItems = composerMenuOptions(effortField)
  const permissionValue = stringSetting(runtimeSettings?.permissionMode)
  const modelValue = effectiveFieldValue(modelField, runtimeSettings?.model)
  const effortValue = effectiveFieldValue(effortField, runtimeSettings?.effort)
  const selectedPermissionLabelKey = permissionLabelKey(permissionValue)
  const permissionLabel = selectedPermissionLabelKey
    ? tNew(selectedPermissionLabelKey)
    : optionLabel(permissionField, runtimeSettings?.permissionMode, tNew("permissionMode"))
  const modelLabel = optionLabel(modelField, runtimeSettings?.model, tNew("model"))
  const effortLabel = optionLabel(effortField, runtimeSettings?.effort, tNew("reasoning"))
  const hasSelectors = Boolean(permissionField || modelField || effortField)
  const placeholder = !session.takeover
    ? tSession("readOnlyPlaceholder")
    : !connectorOnline
      ? tSession("deviceOfflinePlaceholder")
      : pendingApprovalCount > 0
        ? tSession("waitingApprovalPlaceholder")
        : isBusy
          ? tSession("busyPlaceholder")
          : session.status === "error"
            ? tSession("errorPlaceholder")
            : tSession("replyPlaceholder")

  const submit = () => {
    if (!canSend || !hasInput) return
    const text = value
    setValue("")
    const files = attachments
    clear()
    onSend(text, files)
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
        {error ? (
          <button type="button" className="block text-left text-sm text-destructive" onClick={onDismissError}>
            {error}
          </button>
        ) : null}
        <div
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
            <Textarea
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  submit()
                }
              }}
              placeholder={placeholder}
              disabled={!session.takeover || !connectorOnline}
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
              <>
                {permissionField ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 rounded-xl px-2.5 text-muted-foreground"
                        disabled={!runtimeSettings || runtimeSettingsBusy}
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
                          onSelect={() => onPatchRuntimeSettings({ permissionMode: item.id })}
                        >
                          <Check className={cn("size-3.5", permissionValue === item.id ? "opacity-100" : "opacity-0")} />
                          <span>
                            {permissionLabelKey(item.id) ? tNew(permissionLabelKey(item.id)!) : item.label}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                {modelField || effortField ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 rounded-xl px-2.5 text-muted-foreground"
                        disabled={!runtimeSettings || runtimeSettingsBusy}
                      >
                        {effortField ? <span className="text-foreground">{effortLabel}</span> : null}
                        {effortField && modelField ? <span className="text-muted-foreground/50">·</span> : null}
                        {modelField ? <span className="max-w-40 truncate text-foreground">{modelLabel}</span> : null}
                        <ChevronDown className="size-3.5 opacity-60" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      {!modelField && effortItems.length > 0 ? (
                        effortItems.map((item) => (
                          <DropdownMenuItem
                            key={item.id}
                            className="gap-2"
                            onSelect={() => onPatchRuntimeSettings({ effort: item.id })}
                          >
                            <Check className={cn("size-3.5", effortValue === item.id ? "opacity-100" : "opacity-0")} />
                            <span>{item.label}</span>
                          </DropdownMenuItem>
                        ))
                      ) : null}
                      {!modelField && effortItems.length > 0 && modelItems.length > 0 ? <DropdownMenuSeparator /> : null}
                      {modelItems.length > 0 ? (
                        modelItems.map((modelItem) => {
                          const modelEffortField = effortFieldFor(modelItem.id)
                          const modelEfforts = composerMenuOptions(modelEffortField)
                          if (modelEfforts.length === 0) {
                            return (
                              <DropdownMenuItem
                                key={modelItem.id}
                                className="gap-2"
                                onSelect={() => patchModel(modelItem.id)}
                              >
                                <Check className={cn("size-3.5", modelValue === modelItem.id ? "opacity-100" : "opacity-0")} />
                                <span className="truncate">{modelItem.label}</span>
                              </DropdownMenuItem>
                            )
                          }
                          return (
                            <DropdownMenuSub key={modelItem.id}>
                              <DropdownMenuSubTrigger className="gap-2">
                                <Check className={cn("size-3.5", modelValue === modelItem.id ? "opacity-100" : "opacity-0")} />
                                <span className="max-w-40 truncate">{modelItem.label}</span>
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="w-56">
                                {modelEfforts.map((item) => (
                                  <DropdownMenuItem
                                    key={item.id}
                                    className="gap-2"
                                    onSelect={() => patchModelEffort(modelItem.id, item.id)}
                                  >
                                    <Check className={cn(
                                      "size-3.5",
                                      modelValue === modelItem.id && effortValue === item.id ? "opacity-100" : "opacity-0",
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
            ) : null}
            <div
              role="switch"
              aria-checked={session.takeover}
              aria-disabled={!connectorOnline || takeoverBusy}
              tabIndex={connectorOnline && !takeoverBusy ? 0 : -1}
              className={cn(
                "ml-auto flex h-8 items-center gap-2 rounded-xl px-2.5 text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                connectorOnline && !takeoverBusy && "cursor-pointer hover:bg-accent hover:text-accent-foreground",
                (!connectorOnline || takeoverBusy) && "opacity-50",
                session.takeover && "text-foreground",
              )}
              onClick={() => {
                if (!connectorOnline || takeoverBusy) return
                onToggleTakeover()
              }}
              onKeyDown={(event) => {
                if (!connectorOnline || takeoverBusy) return
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
              disabled={showInterrupt ? !connectorOnline : !canSend || !hasInput}
              onClick={showInterrupt ? onInterrupt : submit}
            >
              {sending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : showInterrupt ? (
                <Square className="size-4" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          </div>
        </div>
        {runtimeSettingsError ? (
          <div className="text-xs text-destructive">{runtimeSettingsError}</div>
        ) : null}
      </div>
    </div>
  )
}
