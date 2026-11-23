"use client"

import { useRef, useState } from "react"
import { ArrowUpIcon, ChevronDownIcon, FileIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react"

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatBytes } from "@/components/conversation/text"
import type { ConfigOption, FilePart, ImagePart } from "@/lib/types/v3"
import { cn } from "@/lib/utils"

export interface DraftAttachment {
  part: ImagePart | FilePart
  file: File
  preview?: string
}

export function Composer({
  config,
  running,
  disabled,
  placeholder,
  onSend,
  onStop,
  onConfig,
}: {
  config: ConfigOption[]
  running: boolean
  disabled?: boolean
  placeholder?: string
  onSend: (text: string, drafts: DraftAttachment[]) => void
  onStop: () => void
  onConfig: (id: string, value: string) => void
}) {
  const form = useRef<HTMLFormElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [text, setText] = useState("")
  const [drafts, setDrafts] = useState<DraftAttachment[]>([])
  const canSend = !disabled && (Boolean(text.trim()) || drafts.length > 0)

  const addFiles = (files: FileList | File[]) => {
    const next = [...files].map<DraftAttachment>((f) => {
      const base = {
        path: `~/.aa/uploads/${f.name}`,
        name: f.name,
        mime: f.type || "application/octet-stream",
        size: f.size,
      }
      return f.type.startsWith("image/")
        ? { part: { type: "image", ...base }, file: f, preview: URL.createObjectURL(f) }
        : { part: { type: "file", ...base }, file: f }
    })
    setDrafts((d) => [...d, ...next])
  }

  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault()
        if (!canSend) return
        onSend(text.trim(), drafts)
        setText("")
        setDrafts([])
      }}
    >
      <InputGroup className="bg-card">
        {drafts.length > 0 && (
          <InputGroupAddon align="block-start" className="flex-wrap gap-2">
            {drafts.map((d, i) => (
              <Attachment key={i} size="sm">
                <AttachmentMedia variant={d.preview ? "image" : "icon"}>
                  {d.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={d.preview} alt={d.part.name} />
                  ) : (
                    <FileIcon />
                  )}
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{d.part.name}</AttachmentTitle>
                  <AttachmentDescription>{formatBytes(d.part.size)}</AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction
                    aria-label={`Remove ${d.part.name}`}
                    onClick={() => setDrafts((all) => all.filter((x) => x !== d))}
                  >
                    <XIcon />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            ))}
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (!e.clipboardData.files.length) return
            e.preventDefault()
            addFiles(e.clipboardData.files)
          }}
          placeholder={
            placeholder ??
            (running ? "Queue a follow-up message…" : "Send a message to the agent…")
          }
          aria-label="Message"
          className="max-h-48 p-3"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              form.current?.requestSubmit()
            }
          }}
        />
        <InputGroupAddon align="block-end">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ""
            }}
          />
          <InputGroupButton
            size="icon-sm"
            variant="outline"
            className="rounded-full"
            aria-label="Attach file"
            onClick={() => fileInput.current?.click()}
          >
            <PlusIcon />
          </InputGroupButton>
          {config.map((c, i) => (
            <ConfigMenu
              key={c.id}
              option={c}
              className={i === 0 ? "ml-auto" : undefined}
              onChange={(v) => onConfig(c.id, v)}
            />
          ))}
          {running && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <InputGroupButton
                    size="icon-sm"
                    variant="outline"
                    className={config.length ? "rounded-full" : "ml-auto rounded-full"}
                    aria-label="Stop"
                    onClick={onStop}
                  />
                }
              >
                <SquareIcon className="fill-current" />
              </TooltipTrigger>
              <TooltipContent>Stop current turn</TooltipContent>
            </Tooltip>
          )}
          <InputGroupButton
            type="submit"
            size="icon-sm"
            variant="default"
            className={cn(
              "rounded-full aria-disabled:pointer-events-none aria-disabled:opacity-50",
              !config.length && !running && "ml-auto"
            )}
            aria-disabled={!canSend}
            aria-label={running ? "Queue message" : "Send"}
          >
            <ArrowUpIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}

function ConfigMenu({
  option,
  className,
  onChange,
}: {
  option: ConfigOption
  className?: string
  onChange: (value: string) => void
}) {
  const current = option.options.find((o) => o.value === option.current)
  const groups = new Map<string, ConfigOption["options"]>()
  for (const o of option.options) {
    groups.set(o.group ?? "", [...(groups.get(o.group ?? "") ?? []), o])
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<InputGroupButton size="sm" className={className} aria-label={option.name} />}
      >
        {current?.name ?? option.current}
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuRadioGroup value={option.current} onValueChange={(v) => onChange(String(v))}>
          {[...groups].map(([group, items], gi) => (
            <DropdownMenuGroup key={group || gi}>
              {gi > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{group || option.name}</DropdownMenuLabel>
              {items.map((o) => (
                <DropdownMenuRadioItem key={o.value} value={o.value} closeOnClick>
                  <span className="flex flex-col">
                    <span>{o.name}</span>
                    {o.description && (
                      <span className="text-xs text-muted-foreground">{o.description}</span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
