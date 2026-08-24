import type { CSSProperties } from 'react'
import { useEffect, useRef } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ConnectorLog,
  ConnectorState,
  LogLevel,
} from '../stores/connector-store.js'

const LOCALE_NS = 'dsh-aa-connector'

interface LogViewerProps {
  state: ConnectorState
  /** Whether the list should stick to the bottom as new entries arrive. */
  followTail: boolean
  t: TranslateNS<typeof LOCALE_NS>
}

/**
 * Live log view — mirrors desktop-next's LogsView body exactly:
 *
 *   1. A full-height panel (no card chrome), with an empty state centered
 *      when there are no entries.
 *   2. A thin `N / total`-style count bar along the top.
 *   3. A monospace, 3-column scroll list: time / level / message.
 *
 * Level coloring follows desktop-next: `error` → red, `warn` → amber, the
 * rest muted. Clear / follow-tail controls live in the section header, not
 * here, matching desktop-next's header placement.
 */
export function LogViewer({ state, followTail, t }: LogViewerProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastCount = useRef(0)

  useEffect(() => {
    const node = scrollRef.current
    if (node === null || !followTail) return
    if (state.logs.length === lastCount.current) return
    lastCount.current = state.logs.length
    node.scrollTop = node.scrollHeight
  }, [followTail, state.logs.length])

  const logs = state.logs

  if (logs.length === 0) {
    return <div style={emptyStyle}>{t('logs.empty')}</div>
  }

  return (
    <div style={containerStyle}>
      <div style={countBarStyle}>{logs.length}</div>
      <div ref={scrollRef} style={consoleStyle}>
        {logs.map((entry) => <LogRow key={entry.id} entry={entry} />)}
      </div>
    </div>
  )
}

interface LogRowProps {
  entry: ConnectorLog
}

function LogRow({ entry }: LogRowProps): JSX.Element {
  return (
    <div style={rowStyle}>
      <span style={timestampStyle}>{formatTime(entry.time)}</span>
      <span style={{ ...levelStyle, color: levelColor(entry.level) }}>{entry.level.toUpperCase()}</span>
      <span style={messageStyle}>{entry.message}</span>
    </div>
  )
}

function levelColor(level: LogLevel): string {
  switch (level) {
    case 'error':
      return 'var(--dsw-alias-state-error-primary)'
    case 'warn':
      return 'var(--dsw-alias-state-warn-primary)'
    default:
      return 'var(--dsw-alias-label-secondary)'
  }
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString()
}

const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  flex: 1,
}

const emptyStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 260,
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary)',
}

const countBarStyle: CSSProperties = {
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  padding: '6px 4px',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

const consoleStyle: CSSProperties = {
  flex: 1,
  minHeight: 360,
  overflowY: 'auto',
  padding: '10px 4px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.6,
}

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '88px 72px 1fr',
  gap: 8,
  padding: '2px 0',
  alignItems: 'baseline',
}

const timestampStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  fontVariantNumeric: 'tabular-nums',
}

const levelStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
}

const messageStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  minWidth: 0,
  wordBreak: 'break-word',
}
