"use client"

import Link from "next/link"
import { useMemo, useRef, useState } from "react"
import {
  ArrowUpIcon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  SquareIcon,
  WrenchIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Markdown } from "@/components/conversation/markdown"
import { useI18n } from "@/components/i18n-provider"
import { Spinner } from "@/components/spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { extractChatEntries, useAssistant } from "@/lib/state/assistant-context"
import { cn } from "@/lib/utils"

export function AssistantPanel({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n()
  const {
    activeConversation,
    startNewConversation,
    running,
    streamingText,
    streamingThinking,
    sendMessage,
    stopRun,
    syncing,
    syncNow,
    encryptionEnabled,
    encryptionUnlocked,
    unlockEncryption,
    activeModel,
    tokensStatus,
  } = useAssistant()

  const [input, setInput] = useState("")
  const [unlockPass, setUnlockPass] = useState("")
  const [unlocking, setUnlocking] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  const entries = useMemo(
    () => extractChatEntries(activeConversation?.messages ?? []),
    [activeConversation?.messages]
  )

  const hasModel =
    Boolean(activeModel) &&
    Boolean(activeModel?.source === "tokens" ? tokensStatus?.key : activeModel?.apiKey)

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!unlockPass) return
    setUnlocking(true)
    try {
      await unlockEncryption(unlockPass)
      setUnlockPass("")
      toast.success(t("assistant.e2eeUnlock"))
    } catch {
      toast.error("Incorrect encryption password")
    } finally {
      setUnlocking(false)
    }
  }

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || running) return
    const text = input
    setInput("")
    try {
      await sendMessage(text)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setInput(text)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header strip */}
      <div
        className={cn(
          "flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2.5",
          compact && "pr-12"
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">
            {activeConversation?.title ?? t("assistant.title")}
          </span>
          {encryptionEnabled && (
            <Badge variant="secondary" className="gap-1 text-xs text-muted-foreground">
              <LockIcon className="size-3" />
              {encryptionUnlocked ? "E2EE" : t("assistant.e2eeLock")}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("assistant.syncNow")}
            onClick={() => void syncNow()}
            disabled={syncing}
          >
            <RefreshCwIcon className={cn("size-4", syncing && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("assistant.newChat")}
            onClick={() => void startNewConversation()}
          >
            <PlusIcon className="size-4" />
          </Button>
        </div>
      </div>

      {/* Locked E2EE unlock banner */}
      {encryptionEnabled && !encryptionUnlocked && (
        <form
          onSubmit={handleUnlock}
          className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card px-4 py-3"
        >
          <LockIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{t("assistant.e2eeLockedBanner")}</span>
          <div className="ml-auto flex items-center gap-2">
            <Input
              type="password"
              value={unlockPass}
              onChange={(e) => setUnlockPass(e.target.value)}
              placeholder={t("signIn.passwordPlaceholder")}
              className="h-8 w-44 text-xs"
            />
            <Button type="submit" size="sm" disabled={!unlockPass || unlocking}>
              {unlocking ? t("common.loading") : t("assistant.e2eeUnlock")}
            </Button>
          </div>
        </form>
      )}

      {/* Messages area */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className={cn("mx-auto flex flex-col gap-5", compact ? "max-w-none" : "max-w-3xl")}>
          {!hasModel ? (
            <div className="rounded-card bg-card p-6 text-center space-y-3">
              <SparklesIcon className="mx-auto size-7 stroke-[1.5] text-muted-foreground" />
              <h3 className="text-base font-medium">{t("assistant.noModelTitle")}</h3>
              <p className="mx-auto max-w-md text-sm text-muted-foreground">
                {t("assistant.noModelDesc")}
              </p>
              <div className="pt-1">
                <Button nativeButton={false} render={<Link href="/assistant?tab=config" />}>
                  {t("assistant.tabConfig")}
                </Button>
              </div>
            </div>
          ) : entries.length === 0 && !running ? (
            <div className="py-16 text-center space-y-2">
              <SparklesIcon className="mx-auto size-7 stroke-[1.5] text-muted-foreground" />
              <p className="text-sm font-medium">{t("assistant.title")}</p>
              <p className="mx-auto max-w-md text-xs text-muted-foreground">
                {t("assistant.subtitle")}
              </p>
            </div>
          ) : (
            <>
              {entries.map((entry, idx) => (
                <div
                  key={`${entry.timestamp}-${idx}`}
                  className={cn(
                    "flex flex-col gap-1.5",
                    entry.role === "user" && "items-end"
                  )}
                >
                  {entry.role === "user" ? (
                    <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-sm text-foreground whitespace-pre-wrap">
                      {entry.text}
                    </div>
                  ) : entry.role === "tool" ? (
                    <div className="rounded-xl bg-card px-3.5 py-2 text-xs text-muted-foreground">
                      <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground-secondary">
                        <WrenchIcon className="size-3.5" />
                        <span>{entry.toolName}</span>
                      </div>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs">
                        {entry.text}
                      </pre>
                    </div>
                  ) : (
                    <div className="space-y-2 text-sm leading-relaxed">
                      {entry.thinking && (
                        <details className="rounded-xl bg-card px-3.5 py-2 text-xs text-muted-foreground">
                          <summary className="cursor-pointer font-medium">Reasoning</summary>
                          <div className="mt-2 whitespace-pre-wrap">{entry.thinking}</div>
                        </details>
                      )}
                      {entry.text && <Markdown>{entry.text}</Markdown>}
                    </div>
                  )}
                </div>
              ))}

              {running && (
                <div className="space-y-2 text-sm leading-relaxed">
                  {streamingThinking && (
                    <div className="rounded-xl bg-card px-3.5 py-2 text-xs text-muted-foreground whitespace-pre-wrap">
                      {streamingThinking}
                    </div>
                  )}
                  {streamingText ? (
                    <Markdown streaming>{streamingText}</Markdown>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Spinner className="size-3.5" />
                      <span>{t("common.loading")}</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t px-4 py-3">
        <form
          ref={formRef}
          onSubmit={handleSend}
          className={cn("mx-auto", compact ? "max-w-none" : "max-w-3xl")}
        >
          <InputGroup className="bg-card">
            <InputGroupTextarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!hasModel}
              placeholder={t("assistant.placeholder")}
              className="max-h-40 p-3 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  formRef.current?.requestSubmit()
                }
              }}
            />
            <InputGroupAddon align="block-end">
              {activeModel && (
                <span className="truncate px-2 text-xs text-muted-foreground">
                  {activeModel.modelName ?? activeModel.model}
                </span>
              )}
              {running ? (
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  className="ml-auto rounded-full"
                  aria-label="Stop"
                  onClick={stopRun}
                >
                  <SquareIcon className="fill-current" />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="submit"
                  size="icon-sm"
                  variant="default"
                  className="ml-auto rounded-full aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  aria-disabled={!hasModel || !input.trim()}
                  aria-label="Send"
                >
                  <ArrowUpIcon />
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </div>
  )
}
