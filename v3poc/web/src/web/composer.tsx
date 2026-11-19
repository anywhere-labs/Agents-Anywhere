// AI Elements · Prompt Input (https://ui.shadcn.com/docs/ai-elements/base/prompt-input) with Model Selector menus
// (…/model-selector) and Attachment chips. The menus are drawn from `session.config` — whatever ConfigOptions the
// agent reported (模型 / 权限 / 推理强度 …), in its order; nothing here knows which agent it is.
import { useRef, useState } from 'react'
import { ArrowUpIcon, ChevronDownIcon, FileIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react'
import type { ConfigOption, FilePart, ImagePart } from '@protocol/timeline'
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle } from '@/components/ui/attachment'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatBytes } from '@/conversation/text'
import { cn } from '@/lib/utils'

export interface Draft {
  part: ImagePart | FilePart
  /** A local preview (object URL) for images. */
  preview?: string
}

export function Composer({
  config,
  running,
  disabled,
  onSend,
  onStop,
  onConfig,
}: {
  config: ConfigOption[]
  running: boolean
  disabled?: boolean
  onSend: (text: string, drafts: Draft[]) => void
  onStop: () => void
  onConfig: (id: string, value: string) => void
}) {
  const form = useRef<HTMLFormElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const canSend = !disabled && (!!text.trim() || drafts.length > 0)

  const addFiles = (files: FileList | File[]) => {
    const next = [...files].map<Draft>((f) => {
      const base = { path: `~/.aa/uploads/${f.name}`, name: f.name, mime: f.type || 'application/octet-stream', size: f.size }
      return f.type.startsWith('image/') ? { part: { type: 'image', ...base }, preview: URL.createObjectURL(f) } : { part: { type: 'file', ...base } }
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
        setText('')
        setDrafts([])
      }}
    >
      <InputGroup className="bg-background">
        {drafts.length > 0 && (
          <InputGroupAddon align="block-start" className="flex-wrap gap-2">
            {drafts.map((d, i) => (
              <Attachment key={i} size="sm">
                <AttachmentMedia variant={d.preview ? 'image' : 'icon'}>{d.preview ? <img src={d.preview} alt={d.part.name} /> : <FileIcon />}</AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{d.part.name}</AttachmentTitle>
                  <AttachmentDescription>{formatBytes(d.part.size)}</AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction aria-label={`移除 ${d.part.name}`} onClick={() => setDrafts((all) => all.filter((x) => x !== d))}>
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
          placeholder={running ? '补充说明，Agent 这一轮结束后发送…' : '给 Agent 发消息…'}
          aria-label="消息"
          className="max-h-48 p-3"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
              e.target.value = ''
            }}
          />
          <InputGroupButton size="icon-sm" variant="outline" className="rounded-full" aria-label="添加附件" onClick={() => fileInput.current?.click()}>
            <PlusIcon />
          </InputGroupButton>
          {config.map((c, i) => (
            <ConfigMenu key={c.id} option={c} className={i === 0 ? 'ml-auto' : undefined} onChange={(v) => onConfig(c.id, v)} />
          ))}
          {running && (
            <Tooltip>
              <TooltipTrigger render={<InputGroupButton size="icon-sm" variant="outline" className={config.length ? 'rounded-full' : 'ml-auto rounded-full'} aria-label="停止" onClick={onStop} />}>
                <SquareIcon className="fill-current" />
              </TooltipTrigger>
              <TooltipContent>停止这一轮</TooltipContent>
            </Tooltip>
          )}
          <InputGroupButton
            type="submit"
            size="icon-sm"
            variant="default"
            className={cn('rounded-full aria-disabled:pointer-events-none aria-disabled:opacity-50', !config.length && !running && 'ml-auto')}
            // Not `disabled`: Input Group dims the whole field when anything inside it is disabled.
            aria-disabled={!canSend}
            aria-label={running ? '排队发送' : '发送'}
          >
            <ArrowUpIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}

/** One ConfigOption as a Model Selector menu: its current value on the trigger, options grouped by `group`. */
function ConfigMenu({ option, className, onChange }: { option: ConfigOption; className?: string; onChange: (value: string) => void }) {
  const current = option.options.find((o) => o.value === option.current)
  const groups = new Map<string, ConfigOption['options']>()
  for (const o of option.options) groups.set(o.group ?? '', [...(groups.get(o.group ?? '') ?? []), o])
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<InputGroupButton size="sm" className={className} aria-label={option.name} />}>
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
                    {o.description && <span className="text-xs text-muted-foreground">{o.description}</span>}
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
