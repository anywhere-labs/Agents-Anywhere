/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

import './artwork.css'
import { HeroMeshBackground } from './hero-mesh-background'

type AccentTone = 'emerald' | 'amber' | 'blue' | 'violet'

interface ApiDemoConfig {
  id: string
  label: string
  method: 'POST' | 'GET'
  endpoint: string
  headers: string[]
  request: string[]
  response: string[]
  responseHighlights: string[]
  tokens: number
  latency: number
  accent: AccentTone
}

const ACCENT_CLASSES: Record<
  AccentTone,
  {
    activeText: string
    activeBorder: string
    badge: string
  }
> = {
  emerald: {
    activeText: 'text-emerald-600 dark:text-emerald-400',
    activeBorder: 'border-emerald-500 dark:border-emerald-400',
    badge:
      'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400',
  },
  amber: {
    activeText: 'text-amber-600 dark:text-amber-400',
    activeBorder: 'border-amber-500 dark:border-amber-400',
    badge:
      'bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400',
  },
  blue: {
    activeText: 'text-blue-600 dark:text-blue-400',
    activeBorder: 'border-blue-500 dark:border-blue-400',
    badge:
      'bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400',
  },
  violet: {
    activeText: 'text-violet-600 dark:text-violet-400',
    activeBorder: 'border-violet-500 dark:border-violet-400',
    badge:
      'bg-violet-500/10 text-violet-600 dark:bg-violet-400/10 dark:text-violet-400',
  },
}

const DEMO: ApiDemoConfig = {
  id: 'gpt-chat',
  label: 'Chat',
  method: 'POST',
  endpoint: '/v1/chat/completions',
  headers: ['"Authorization: Bearer sk-••••"'],
  request: [
    '"model": "your-model",',
    '"messages": [',
    '  { "role": "user", "content": "..." }',
    ']',
  ],
  response: [
    '{',
    '  "choices": [{ "message": { "content": <text> } }],',
    '  "usage": { "total_tokens": <tokens> }',
    '}',
  ],
  responseHighlights: ['<text>', '<tokens>'],
  tokens: 27,
  latency: 142,
  accent: 'emerald',
}

// Adapted from the anywhere-api landing page's HeroTerminalDemo: a single Chat example,
// without automatic cycling or protocol tabs. No API request is performed.
export function TokensAnywhereArtwork() {
  const demo = DEMO
  const accent = ACCENT_CLASSES[demo.accent]
  const transitioning = false

  return (
    <div className={cn('mx-auto w-full max-w-2xl')}>
      <div className='hero-terminal-stage'>
        <HeroMeshBackground />
        <div
          className={cn(
            'hero-terminal-window dark relative z-10 overflow-hidden rounded-2xl border border-white/15 bg-[#0a0a0a] shadow-[0_24px_70px_-15px_rgba(0,0,0,0.8)]'
          )}
        >
          <div className='flex h-12 items-center gap-1.5 border-b border-white/10 px-5'>
            <div aria-hidden='true' className='flex gap-1.5'>
              <span className='size-2.5 rounded-full bg-[#ff5f57]' />
              <span className='size-2.5 rounded-full bg-[#febc2e]' />
              <span className='size-2.5 rounded-full bg-[#28c840]' />
            </div>
            <div className='ml-auto flex items-center gap-2'>
              <span className='inline-block size-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.45)]' />
              <span className='text-foreground/40 font-mono text-[10px] tracking-wider uppercase'>
                200 ok
              </span>
            </div>
          </div>

          {/* Endpoint row */}
          <div
            className={cn(
              'flex items-center gap-2.5 border-b px-5 py-3',
              'border-border/40 dark:border-white/[0.04]'
            )}
          >
            <span
              className={cn(
                'rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider',
                accent.badge
              )}
            >
              {demo.method}
            </span>
            <code
              className={cn(
                'text-foreground/75 truncate font-mono text-[12.5px] transition-opacity duration-200',
                transitioning ? 'opacity-0' : 'opacity-100'
              )}
            >
              {demo.endpoint}
            </code>
          </div>

          {/* Body — fixed rows so neither block shifts when switching demos */}
          <div className='grid h-[400px] grid-rows-[235px_minmax(0,1fr)] overflow-x-auto font-mono text-[11px] leading-[1.55] sm:text-[12.5px]'>
            {/* Request */}
            <RequestBlock demo={demo} transitioning={transitioning} />

            {/* Response */}
            <ResponseBlock demo={demo} transitioning={transitioning} />
          </div>

          {/* Footer metrics */}
          <div
            className={cn(
              'flex items-center justify-between border-t px-5 py-2.5',
              'border-border/40 bg-muted/30 dark:border-white/[0.05] dark:bg-white/[0.02]'
            )}
          >
            <div className='text-foreground/40 flex items-center gap-3 text-[10px] tabular-nums'>
              <span className='flex items-center gap-1'>
                <span className='font-mono'>{demo.latency}</span>
                <span className='tracking-wider uppercase'>ms</span>
              </span>
              <span className='bg-foreground/15 size-1 rounded-full' />
              <span className='flex items-center gap-1'>
                <span className='font-mono'>{demo.tokens}</span>
                <span className='tracking-wider uppercase'>tokens</span>
              </span>
              <span className='bg-foreground/15 size-1 rounded-full' />
              <span className='flex items-center gap-1'>
                <span className='tracking-wider uppercase'>cost</span>
                <span className='font-mono'>
                  ${'0.00081'}
                </span>
              </span>
            </div>
            <span className='text-foreground/30 font-mono text-[10px] tracking-wider uppercase'>
              stream · sse
            </span>
          </div>
        </div>
      </div>

    </div>
  )
}

function RequestBlock(props: { demo: ApiDemoConfig; transitioning: boolean }) {
  const { demo, transitioning } = props

  return (
    <div className='relative px-5 py-4'>
      <SectionLabel>Request</SectionLabel>
      <div
        className={cn(
          'mt-2 transition-opacity duration-200',
          transitioning ? 'opacity-0' : 'opacity-100'
        )}
      >
        <CodeLine>
          <Command>curl</Command> <Flag>-X</Flag> <Flag>POST</Flag>{' '}
          <StringText>&quot;{demo.endpoint}&quot;</StringText>{' '}
          <Muted>{'\\'}</Muted>
        </CodeLine>
        {demo.headers.map((header) => (
          <CodeLine key={header} indent={2}>
            <Flag>-H</Flag> <StringText>{header}</StringText>{' '}
            <Muted>{'\\'}</Muted>
          </CodeLine>
        ))}
        <CodeLine indent={2}>
          <Flag>-d</Flag> <StringText>&apos;{'{'}</StringText>
        </CodeLine>
        {demo.request.map((line) => (
          <CodeLine key={line} indent={4}>
            {renderJsonLine(line)}
          </CodeLine>
        ))}
        <CodeLine indent={2}>
          <StringText>{'}'}&apos;</StringText>
        </CodeLine>
      </div>
    </div>
  )
}

function ResponseBlock(props: { demo: ApiDemoConfig; transitioning: boolean }) {
  const { demo, transitioning } = props

  return (
    <div
      className={cn(
        'relative border-t px-5 py-4',
        'border-border/40 bg-muted/20 dark:border-white/[0.05] dark:bg-white/[0.015]'
      )}
    >
      <SectionLabel>Response</SectionLabel>
      <div
        className={cn(
          'mt-2 transition-opacity duration-200',
          transitioning ? 'opacity-0' : 'opacity-100'
        )}
      >
        {demo.response.map((line) => (
          <CodeLine key={line}>{renderResponseLine(line, demo)}</CodeLine>
        ))}
      </div>
    </div>
  )
}

function SectionLabel(props: { children: ReactNode }) {
  return (
    <span className='text-foreground/30 font-sans text-[10px] font-semibold tracking-[0.18em] uppercase'>
      {props.children}
    </span>
  )
}

const STRING_RE = /"[^"]*"/g
const PLACEHOLDER_RE = /<[a-z]+>/gi

function renderJsonLine(line: string): ReactNode {
  if (!line.trim()) return <Muted> </Muted>
  return tokenize(line)
}

function renderResponseLine(line: string, demo: ApiDemoConfig): ReactNode {
  if (!line.trim()) return <Muted> </Muted>

  const segments: ReactNode[] = []
  let cursor = 0
  const matches = [...line.matchAll(PLACEHOLDER_RE)]

  if (matches.length === 0) return tokenize(line)

  matches.forEach((match) => {
    const start = match.index ?? 0
    if (start > cursor) {
      segments.push(
        <span key={`pre-${start}`}>{tokenize(line.slice(cursor, start))}</span>
      )
    }
    const placeholder = match[0]
    if (placeholder === '<text>') {
      segments.push(
        <Accent key={`ph-${start}`} accent={demo.accent}>
          {`"${truncateResponse(demo)}"`}
        </Accent>
      )
    } else if (placeholder === '<tokens>') {
      segments.push(<NumberText key={`ph-${start}`}>{demo.tokens}</NumberText>)
    } else if (placeholder === '<in>') {
      segments.push(
        <NumberText key={`ph-${start}`}>
          {Math.floor(demo.tokens * 0.4)}
        </NumberText>
      )
    } else if (placeholder === '<out>') {
      segments.push(
        <NumberText key={`ph-${start}`}>
          {Math.ceil(demo.tokens * 0.6)}
        </NumberText>
      )
    } else {
      segments.push(<Muted key={`ph-${start}`}>{placeholder}</Muted>)
    }
    cursor = start + placeholder.length
  })

  if (cursor < line.length) {
    segments.push(<span key='tail'>{tokenize(line.slice(cursor))}</span>)
  }

  return segments
}

function truncateResponse(demo: ApiDemoConfig): string {
  const map: Record<string, string> = {
    'gpt-chat': 'Chat request routed.',
    responses: 'Response workflow ready.',
    claude: 'Claude message routed.',
    gemini: 'Gemini request served.',
  }
  return map[demo.id] ?? '...'
}

function tokenize(input: string): ReactNode {
  // Split string into "..." string runs and the rest, then color keys/punct.
  const segments: ReactNode[] = []
  let cursor = 0
  const matches = [...input.matchAll(STRING_RE)]

  matches.forEach((match) => {
    const start = match.index ?? 0
    if (start > cursor) {
      segments.push(
        <Muted key={`m-${start}`}>{input.slice(cursor, start)}</Muted>
      )
    }
    const text = match[0]
    const after = input.slice(start + text.length).trimStart()
    const isKey = after.startsWith(':')
    if (isKey) {
      segments.push(<Key key={`k-${start}`}>{text}</Key>)
    } else {
      segments.push(<StringText key={`s-${start}`}>{text}</StringText>)
    }
    cursor = start + text.length
  })

  if (cursor < input.length) {
    segments.push(<Muted key='tail'>{input.slice(cursor)}</Muted>)
  }

  return segments
}

function CodeLine(props: { children: ReactNode; indent?: number }) {
  return (
    <div className='whitespace-pre'>
      {props.indent ? (
        <span
          aria-hidden
          className='inline-block'
          style={{ width: `${props.indent}ch` }}
        />
      ) : null}
      {props.children}
    </div>
  )
}

function Command(props: { children: ReactNode }) {
  return (
    <span className='font-medium text-emerald-600 dark:text-emerald-400'>
      {props.children}
    </span>
  )
}

function Flag(props: { children: ReactNode }) {
  return (
    <span className='text-blue-600 dark:text-blue-400'>{props.children}</span>
  )
}

function Key(props: { children: ReactNode }) {
  return (
    <span className='text-sky-700 dark:text-sky-300'>{props.children}</span>
  )
}

function StringText(props: { children: ReactNode }) {
  return (
    <span className='text-amber-700 dark:text-amber-300'>{props.children}</span>
  )
}

function NumberText(props: { children: ReactNode }) {
  return (
    <span className='font-medium text-violet-600 dark:text-violet-300'>
      {props.children}
    </span>
  )
}

function Muted(props: { children: ReactNode }) {
  return <span className='text-foreground/55'>{props.children}</span>
}

function Accent(props: { children: ReactNode; accent: AccentTone }) {
  const tone = ACCENT_CLASSES[props.accent]
  return (
    <span className={cn('font-medium', tone.activeText)}>{props.children}</span>
  )
}
