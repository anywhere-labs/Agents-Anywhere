"use client"

// The conversation's input. Look after Effi's PromptInput / Effi Cloud's Composer (in Anywhere UI): attachments above
// a borderless field that grows with its text; "+" (upload image / file — also paste or drop), the model chip, then on
// the right the permission chip, the context ring and the primary button. Behaviour after AA v2 (web-next
// session-composer.tsx):
//   - Enter sends, Shift+Enter is a new line, nothing happens while an IME composes;
//   - while the agent works, Enter queues the message for after the turn and ⌘/Ctrl+Enter steers it in now (when the
//     agent takes steering); the primary button is Stop while the input is empty and Queue once there is text, with a
//     menu for Steer now / Stop;
//   - "/" at the start opens the command menu (↑ ↓, Tab completes, Enter runs, Esc closes);
//   - the draft is kept per conversation (localStorage) until it is sent;
//   - sending waits for attachments to finish uploading and refuses ones that cannot go.
import { useEffect, useMemo, useRef, useState } from "react"
import type * as React from "react"
import {
  ArrowUpIcon,
  ChevronUpIcon,
  FileIcon,
  ImageIcon,
  ListPlusIcon,
  PlusIcon,
  SlashIcon,
  SquareIcon,
  ZapIcon,
} from "lucide-react"

import { DraftChips, type DraftAttachments } from "@/components/conversation/attachments"
import { ConfigPickers } from "@/components/conversation/config-pickers"
import { useI18n } from "@/components/i18n-provider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ConfigOption } from "@/lib/types/v3"
import { cn } from "@/lib/utils"

export type Delivery = "auto" | "steer" | "queue"

export interface ComposerCommand {
  /** Without the slash: "compact". */
  name: string
  description: string
  /** Takes the rest of the line as its argument. */
  run: (arg: string) => void | Promise<void>
}

const isMac = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const draftStorageKey = (key: string) => `aa-v3.draft.${key}`

function readDraft(key?: string): string {
  if (!key || typeof window === "undefined") return ""
  try {
    return window.localStorage.getItem(draftStorageKey(key)) ?? ""
  } catch {
    return ""
  }
}

/** A command-like token at the start ("/comp"), not a path ("/Users/…"). */
function commandToken(text: string): string | null {
  const m = /^\/([a-z][\w-]*)?$/i.exec(text)
  return m ? (m[1] ?? "") : null
}

export function Composer({
  agent,
  config,
  configLoading,
  onConfig,
  running = false,
  steer = "interrupt",
  disabled,
  placeholder,
  drafts,
  context,
  above,
  autoFocus,
  className,
  draftKey,
  commands = [],
  inject,
  onSubmit,
  onStop,
}: {
  /** The agent's display name. */
  agent: string
  config?: ConfigOption[]
  configLoading?: boolean
  onConfig: (configId: string, value: string) => void
  /** The agent is working: Enter queues, ⌘/Ctrl+Enter steers, the empty input's button stops. */
  running?: boolean
  /** How the agent takes a message mid-turn (Control.steer); "none" offers no steering. */
  steer?: "native" | "interrupt" | "none"
  disabled?: boolean
  placeholder?: string
  drafts?: DraftAttachments
  /** The context ring, before the primary button. */
  context?: React.ReactNode
  /** Above the field (approvals, queued messages). */
  above?: React.ReactNode
  autoFocus?: boolean
  className?: string
  /** Keep the unsent text under this key (one per conversation). */
  draftKey?: string
  /** Put this text into the input (a queued message taken back for editing); a new `nonce` repeats it. */
  inject?: { text: string; nonce: number } | null
  /** The "/" menu. */
  commands?: ComposerCommand[]
  /** Resolve true to clear the input. */
  onSubmit: (text: string, delivery: Delivery) => Promise<boolean> | boolean
  onStop?: () => void
}) {
  const { t } = useI18n()
  const form = useRef<HTMLFormElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<{ key?: string; text: string }>(() => ({ key: draftKey, text: readDraft(draftKey) }))
  // Another conversation: its own draft (adjusting state while rendering, not in an effect).
  if (draft.key !== draftKey) setDraft({ key: draftKey, text: readDraft(draftKey) })
  const text = draft.key === draftKey ? draft.text : readDraft(draftKey)
  const setText = (value: string) => setDraft({ key: draftKey, text: value })
  const [dragging, setDragging] = useState(false)
  const [sending, setSending] = useState(false)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const [injected, setInjected] = useState<number | null>(null)
  if (inject && inject.nonce !== injected) {
    setInjected(inject.nonce)
    setDraft({ key: draftKey, text: text ? `${text}\n${inject.text}` : inject.text })
  }

  useEffect(() => {
    if (!draftKey) return
    const save = () => {
      try {
        if (text) window.localStorage.setItem(draftStorageKey(draftKey), text)
        else window.localStorage.removeItem(draftStorageKey(draftKey))
      } catch {
        // Storage unavailable: the draft lives for this page only.
      }
    }
    // A cleared input (sent) is forgotten at once: the page may navigate away before a debounce fires.
    if (!text) {
      save()
      return
    }
    const timer = window.setTimeout(save, 300)
    return () => window.clearTimeout(timer)
  }, [draftKey, text])

  const hasFiles = !!drafts?.items.length
  const hasText = Boolean(text.trim())
  const uploadsReady = !drafts?.blocked && !drafts?.busy
  const canSend = !disabled && !sending && (hasText || hasFiles) && uploadsReady
  const canSteer = steer !== "none"
  const mod = isMac() ? "⌘" : "Ctrl"

  // The "/" menu: built-in commands whose name starts with what is typed.
  const token = commandToken(text)
  const matches = useMemo(
    () => (token === null ? [] : commands.filter((c) => c.name.startsWith(token.toLowerCase()))),
    [commands, token]
  )
  const menuOpen = !menuClosed && matches.length > 0
  const active = Math.min(menuIndex, Math.max(0, matches.length - 1))

  const runCommandLine = async (line: string): Promise<boolean> => {
    const m = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(line.trim())
    const cmd = m ? commands.find((c) => c.name === m[1].toLowerCase()) : undefined
    if (!cmd) return false
    await cmd.run((m?.[2] ?? "").trim())
    return true
  }

  const submit = async (delivery: Delivery) => {
    if (!canSend) {
      form.current?.querySelector("textarea")?.focus()
      return
    }
    setSending(true)
    try {
      if (!hasFiles && (await runCommandLine(text))) {
        setText("")
        return
      }
      const ok = await onSubmit(text.trim(), delivery)
      if (ok) {
        setText("")
        if (draftKey) {
          try {
            window.localStorage.removeItem(draftStorageKey(draftKey))
          } catch {
            // ignore
          }
        }
      }
    } finally {
      setSending(false)
    }
  }

  const pickCommand = (c: ComposerCommand) => {
    setText(`/${c.name} `)
    setMenuClosed(true)
    requestAnimationFrame(() => form.current?.querySelector("textarea")?.focus())
  }

  const primary: "send" | "queue" | "stop" = running ? (hasText || hasFiles ? "queue" : "stop") : "send"

  return (
    <div className={cn("relative", className)}>
      {menuOpen && (
        <div
          role="listbox"
          aria-label={t("composer.commands")}
          className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-2xl bg-popover p-1.5 shadow-lg ring-1 ring-foreground/5"
        >
          <p className="flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-[11px] text-muted-foreground">
            <SlashIcon className="size-3" />
            {t("composer.commands")}
          </p>
          {matches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setMenuIndex(i)}
              onClick={() => pickCommand(c)}
              className={cn(
                "flex h-9 w-full items-center gap-3 rounded-full px-3 text-left text-sm",
                i === active && "bg-surface-hover"
              )}
            >
              <span className="font-mono text-foreground">/{c.name}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {above}
      {drafts && <DraftChips drafts={drafts} />}
      <form
        ref={form}
        onSubmit={(e) => {
          e.preventDefault()
          void submit(running ? "queue" : "auto")
        }}
        onDragOver={(e) => {
          if (!drafts || disabled || !e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false)
          if (!drafts || disabled || !e.dataTransfer.files.length) return
          e.preventDefault()
          drafts.add([...e.dataTransfer.files])
        }}
      >
        <InputGroup
          className={cn(
            "h-auto rounded-card border-transparent bg-card shadow-none transition-shadow has-[[data-slot=input-group-control]:focus-visible]:border-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/25",
            dragging && "ring-2 ring-ring/40"
          )}
        >
          <InputGroupTextarea
            value={text}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={(e) => {
              setText(e.target.value)
              setMenuClosed(false)
              setMenuIndex(0)
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (!drafts || !files.length) return
              e.preventDefault()
              drafts.add(files)
            }}
            placeholder={dragging ? t("composer.dropHere") : placeholder}
            aria-label={placeholder ?? t("composer.send")}
            className="max-h-60 min-h-12 px-4 pt-3.5 pb-1 text-[15px] leading-relaxed md:text-sm"
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (menuOpen) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault()
                  const n = matches.length
                  setMenuIndex((active + (e.key === "ArrowDown" ? 1 : n - 1)) % n)
                  return
                }
                if (e.key === "Tab") {
                  e.preventDefault()
                  pickCommand(matches[active])
                  return
                }
                if (e.key === "Escape") {
                  e.preventDefault()
                  setMenuClosed(true)
                  return
                }
                if (e.key === "Enter" && !e.shiftKey && token !== null && matches[active]?.name !== token) {
                  e.preventDefault()
                  pickCommand(matches[active])
                  return
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                if (running && (e.metaKey || e.ctrlKey) && canSteer) void submit("steer")
                else void submit(running ? "queue" : "auto")
              }
            }}
          />
          <InputGroupAddon align="block-end" className="gap-0.5 px-2 pt-0 pb-2">
            {drafts && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <InputGroupButton
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className="size-8 rounded-full text-muted-foreground hover:text-foreground"
                      aria-label={t("composer.add")}
                      disabled={disabled}
                    />
                  }
                >
                  <PlusIcon className="size-[18px]" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-48">
                  <DropdownMenuItem onClick={() => imageInput.current?.click()}>
                    <ImageIcon />
                    {t("composer.uploadImage")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => fileInput.current?.click()}>
                    <FileIcon />
                    {t("composer.uploadFile")}
                  </DropdownMenuItem>
                  {commands.length > 0 && (
                    <DropdownMenuItem
                      onClick={() => {
                        setText("/")
                        setMenuClosed(false)
                        requestAnimationFrame(() => form.current?.querySelector("textarea")?.focus())
                      }}
                    >
                      <SlashIcon />
                      {t("composer.commands")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <ConfigPickers
              place="model"
              config={config}
              agent={agent}
              onChange={onConfig}
              disabled={disabled}
              loading={configLoading}
            />
            <span className="ml-auto" />
            <ConfigPickers place="mode" config={config} agent={agent} onChange={onConfig} disabled={disabled} />
            {context}
            {primary === "stop" ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      type="button"
                      size="icon-sm"
                      variant="default"
                      className="size-8 rounded-full"
                      aria-label={t("composer.stop")}
                      onClick={onStop}
                    />
                  }
                >
                  <SquareIcon className="size-3 fill-current" />
                </TooltipTrigger>
                <TooltipContent>{t("composer.stop")}</TooltipContent>
              </Tooltip>
            ) : primary === "queue" ? (
              <div className="flex items-center rounded-full bg-foreground text-background">
                <InputGroupButton
                  type="submit"
                  size="sm"
                  variant="default"
                  className={cn("h-8 gap-1 rounded-full rounded-r-none pr-1.5 pl-3", !canSend && "opacity-40")}
                  aria-disabled={!canSend}
                >
                  <ListPlusIcon className="size-4" />
                  <span className="text-[13px]">{t("composer.queue")}</span>
                </InputGroupButton>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <InputGroupButton
                        type="button"
                        size="icon-sm"
                        variant="default"
                        className="size-8 rounded-full rounded-l-none"
                        aria-label={t("conv.more")}
                      />
                    }
                  >
                    <ChevronUpIcon className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" side="top" className="w-56">
                    <DropdownMenuItem disabled={!canSend} onClick={() => void submit("queue")}>
                      <ListPlusIcon />
                      {t("composer.queue")}
                      <DropdownMenuShortcut>Enter</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    {canSteer && (
                      <DropdownMenuItem disabled={!canSend} onClick={() => void submit("steer")}>
                        <ZapIcon />
                        {t("composer.steer")}
                        <DropdownMenuShortcut>{mod}+Enter</DropdownMenuShortcut>
                      </DropdownMenuItem>
                    )}
                    {onStop && (
                      <DropdownMenuItem onClick={onStop}>
                        <SquareIcon className="fill-current" />
                        {t("composer.stop")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      type="submit"
                      size="icon-sm"
                      variant="default"
                      className={cn("size-8 rounded-full", !canSend && "opacity-40")}
                      aria-label={t("composer.send")}
                      // Not `disabled`: the input group dims itself when anything inside is disabled.
                      aria-disabled={!canSend}
                    />
                  }
                >
                  <ArrowUpIcon className="size-[18px]" />
                </TooltipTrigger>
                <TooltipContent>
                  {drafts?.busy ? t("attach.busy") : drafts?.blocked ? t("attach.blocked") : t("composer.send")}
                </TooltipContent>
              </Tooltip>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
      {running && (
        <p className="px-4 pt-1.5 text-[11px] text-muted-foreground max-sm:hidden">
          {canSteer ? t("composer.runningHint", { mod }) : t("composer.runningHintQueue")}
        </p>
      )}
      {drafts && (
        <>
          <input
            ref={imageInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) drafts.add([...e.target.files])
              e.target.value = ""
            }}
          />
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) drafts.add([...e.target.files])
              e.target.value = ""
            }}
          />
        </>
      )}
    </div>
  )
}
