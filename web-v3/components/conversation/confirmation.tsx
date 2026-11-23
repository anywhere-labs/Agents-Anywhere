"use client"

// AI Elements · Confirmation (https://ui.shadcn.com/docs/ai-elements/base/confirmation): a waiting permission request is
// a question for the person, not a step, so it sits outside the Trace as an outline Item under the tool line, with the
// request's own options as buttons (ACP gives allow_once / allow_always / reject_once / reject_always, not just yes/no).
// Once anyone answers, `control.answered` turns it into a Marker: "已由 X 在 Y 上处理".
import { CheckIcon, ShieldQuestionIcon, TerminalIcon, XIcon } from 'lucide-react'
import type { PendingRequest, ToolPart } from '@/lib/types/v3'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import { useThreadEnv } from './env'
import { commandOf, cwdOf } from './text'

const ORDER = { reject_always: 0, reject_once: 1, allow_always: 2, allow_once: 3 } as const

export function Confirmation({ request, tool }: { request: PendingRequest; tool: ToolPart }) {
  const env = useThreadEnv()
  const command = tool.kind === 'execute' ? commandOf(tool) : undefined
  const cwd = cwdOf(tool)
  // Reject on the left, the plain "allow" last (the primary button), as in the pattern.
  const options = [...request.options].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
  return (
    <Item variant="outline" size="sm" className="flex-wrap">
      <ItemMedia variant="icon">{command ? <TerminalIcon /> : <ShieldQuestionIcon />}</ItemMedia>
      <ItemContent className="min-w-48">
        <ItemTitle className="block">
          {command ? '要运行 ' : '允许 '}
          <span className="font-mono text-[0.92em] break-all">{command ?? request.title}</span>
          {command ? ' 吗？' : '？'}
        </ItemTitle>
        <ItemDescription>{cwd ? `在 ${cwd} 中运行` : 'Agent 在等你确认后再继续。'}</ItemDescription>
      </ItemContent>
      <ItemActions className="flex-wrap">
        {options.map((o, i) => (
          <Button
            key={o.id}
            size="sm"
            variant={i === options.length - 1 ? 'default' : 'outline'}
            onClick={() => {
              env.haptic?.(o.kind.startsWith('allow') ? 'success' : 'medium')
              env.answer(request.request_id, o.id)
            }}
          >
            {o.name}
          </Button>
        ))}
      </ItemActions>
    </Item>
  )
}

export function Answered({ request, by, device, option_id }: { request: PendingRequest; by: string; device?: string; option_id: string }) {
  const env = useThreadEnv()
  const option = request.options.find((o) => o.id === option_id)
  const allowed = option ? option.kind.startsWith('allow') : true
  const who = by === env.me ? '你' : by
  return (
    <Marker>
      <MarkerIcon>{allowed ? <CheckIcon /> : <XIcon />}</MarkerIcon>
      <MarkerContent>{`已由${who === '你' ? '你' : ` ${who} `}${device ? `在 ${device} 上` : ''}处理${option ? `：${option.name}` : ''}`}</MarkerContent>
    </Marker>
  )
}
