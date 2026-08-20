import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Card, buttonGhost, buttonSecondary } from './Card.js'
import type {
  ConnectorActions,
  ConnectorLog,
  ConnectorState,
  LogLevel,
} from '../stores/connector-store.js'
import type { AgentsAnywhereConnectorLocaleKey } from '../locales.js'

const LOCALE_NS = 'dsh-aa-connector'

interface LogViewerProps {
  state: ConnectorState
  actions: ConnectorActions
  t: TranslateNS<typeof LOCALE_NS>
}

type LevelFilter = 'all' | LogLevel

const LEVEL_FILTERS: ReadonlyArray<LevelFilter> = ['all', 'debug', 'info', 'warn', 'error']

/**
 * Streaming log console. Filters by level, sticks to the bottom while
 * `followTail` is on, and offers copy-all / clear actions.
 */
export function LogViewer({ state, actions, t }: LogViewerProps): JSX.Element {
  const [filter, setFilter] = useState<LevelFilter>('all')
  const [followTail, setFollowTail] = useState(true)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastCount = useRef(0)

  const filtered = useMemo(() => {
    if (filter === 'all') return state.logs
    return state.logs.filter(entry => entry.level === filter)
  }, [filter, state.logs])

  useEffect(() => {
    const node = scrollRef.current
    if (node === null || !followTail) return
    if (state.logs.length === lastCount.current) return
    lastCount.current = state.logs.length
    node.scrollTop = node.scrollHeight
  }, [followTail, state.logs.length])

  return (
    <Card
      title={t('logs.title')}
      description={t('logs.description')}
      actions={
        <>
          <button type="button" style={buttonSecondary} onClick={() => copyAll(filtered, t)}>
            {t('logs.copy')}
          </button>
          <button type="button" style={buttonGhost} onClick={() => actions.clearLogs()}>
            {t('logs.clear')}
          </button>
        </>
      }
    >
      <div style={filterRowStyle}>
        <div role="group" style={filterGroupStyle}>
          {LEVEL_FILTERS.map(level => (
            <button
              key={level}
              type="button"
              style={filter === level ? filterActiveStyle : filterInactiveStyle}
              onClick={() => setFilter(level)}
            >
              {t(filterKeyOf(level))}
              <span style={filterCountStyle}>{countOf(state.logs, level)}</span>
            </button>
          ))}
        </div>
        <label style={followLabelStyle}>
          <input
            type="checkbox"
            checked={followTail}
            onChange={(event) => setFollowTail(event.target.checked)}
            style={followCheckboxStyle}
          />
          {t('logs.follow')}
        </label>
      </div>

      <div ref={scrollRef} style={consoleStyle} role="log" aria-live="polite">
        {filtered.length === 0 ? (
          <div style={emptyStyle}>{t('logs.empty')}</div>
        ) : (
          filtered.map(entry => <LogRow key={entry.id} entry={entry} t={t} />)
        )}
      </div>
    </Card>
  )
}

interface LogRowProps {
  entry: ConnectorLog
  t: LogViewerProps['t']
}

function LogRow({ entry, t }: LogRowProps): JSX.Element {
  return (
    <div style={rowStyle}>
      <span style={timestampStyle}>{formatTime(entry.time)}</span>
      <span style={{ ...levelChipStyle, ...levelChipTone(entry.level) }}>{entry.level.toUpperCase()}</span>
      <span style={loggerStyle}>{entry.logger}</span>
      <span style={messageStyle}>{entry.message}</span>
    </div>
  )
}

function countOf(logs: ReadonlyArray<ConnectorLog>, level: LevelFilter): number {
  if (level === 'all') return logs.length
  return logs.reduce((sum, entry) => sum + (entry.level === level ? 1 : 0), 0)
}

function filterKeyOf(level: LevelFilter): AgentsAnywhereConnectorLocaleKey {
  switch (level) {
    case 'all':
      return 'logs.filter.all'
    case 'debug':
      return 'logs.filter.debug'
    case 'info':
      return 'logs.filter.info'
    case 'warn':
      return 'logs.filter.warn'
    case 'error':
      return 'logs.filter.error'
  }
}

function levelChipTone(level: LogLevel): CSSProperties {
  switch (level) {
    case 'debug':
      return { color: 'var(--dsw-alias-text-tertiary, #9a9a9a)', borderColor: 'var(--dsw-alias-border-l2, #d8d8d8)' }
    case 'info':
      return { color: 'var(--dsw-alias-text-info, #1565c0)', borderColor: 'var(--dsw-alias-border-info, rgba(21, 101, 192, 0.32))' }
    case 'warn':
      return { color: 'var(--dsw-alias-text-warning, #b25e09)', borderColor: 'var(--dsw-alias-border-warning, rgba(255, 167, 38, 0.36))' }
    case 'error':
      return { color: 'var(--dsw-alias-text-error, #c62828)', borderColor: 'var(--dsw-alias-border-error, rgba(198, 40, 40, 0.32))' }
  }
}

function copyAll(logs: ReadonlyArray<ConnectorLog>, t: LogViewerProps['t']): void {
  if (logs.length === 0) return
  const text = logs
    .map(entry => `${formatTime(entry.time)} ${entry.level.toUpperCase()} [${entry.logger}] ${entry.message}`)
    .join('\n')
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    void navigator.clipboard.writeText(text).catch(() => undefined)
  }
  void t
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

const filterRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
}

const filterGroupStyle: CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--dsw-alias-border-l2, #d8d8d8)',
  borderRadius: 8,
  overflow: 'hidden',
}

const filterInactiveStyle: CSSProperties = {
  padding: '5px 10px',
  fontSize: 12,
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-text-secondary, #6b6b6b)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
}

const filterActiveStyle: CSSProperties = {
  ...filterInactiveStyle,
  background: 'var(--dsw-alias-bg-surface-2, rgba(127, 127, 127, 0.08))',
  color: 'var(--dsw-alias-text-primary, #1f1f1f)',
  fontWeight: 500,
}

const filterCountStyle: CSSProperties = {
  fontSize: 11,
  padding: '0 6px',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-surface-1, #ffffff)',
  border: '1px solid var(--dsw-alias-border-l2, #d8d8d8)',
  fontVariantNumeric: 'tabular-nums',
}

const followLabelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: 'var(--dsw-alias-text-secondary, #6b6b6b)',
}

const followCheckboxStyle: CSSProperties = {
  margin: 0,
}

const consoleStyle: CSSProperties = {
  maxHeight: 320,
  overflowY: 'auto',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, #d8d8d8)',
  background: 'var(--dsw-alias-bg-surface-2, rgba(127, 127, 127, 0.06))',
  padding: '8px 12px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.55,
}

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '92px 56px 96px 1fr',
  gap: 8,
  padding: '2px 0',
  alignItems: 'baseline',
}

const timestampStyle: CSSProperties = {
  color: 'var(--dsw-alias-text-tertiary, #9a9a9a)',
  fontVariantNumeric: 'tabular-nums',
}

const levelChipStyle: CSSProperties = {
  display: 'inline-block',
  padding: '0 6px',
  borderRadius: 4,
  border: '1px solid',
  fontSize: 10,
  letterSpacing: 1,
  textAlign: 'center',
  fontWeight: 600,
}

const loggerStyle: CSSProperties = {
  color: 'var(--dsw-alias-text-secondary, #6b6b6b)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 1,
}

const messageStyle: CSSProperties = {
  color: 'var(--dsw-alias-text-primary, #1f1f1f)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

const emptyStyle: CSSProperties = {
  padding: '16px 8px',
  textAlign: 'center',
  fontSize: 12,
  color: 'var(--dsw-alias-text-tertiary, #9a9a9a)',
}