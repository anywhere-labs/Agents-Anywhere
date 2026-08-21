import type { CSSProperties } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Card,
  KeyValueRow,
  StatusPill,
  buttonPrimary,
  buttonSecondary,
} from './Card.js'
import type {
  ConnectorActions,
  ConnectorState,
  ConnectorRuntimeState,
  ConnectionState,
} from '../stores/connector-store.js'

const LOCALE_NS = 'dsh-aa-connector'

interface OverviewCardProps {
  state: ConnectorState
  actions: ConnectorActions
  t: TranslateNS<typeof LOCALE_NS>
}

/**
 * Top-level status surface: shows runtime + connection state, exposes the
 * Start/Stop/Restart controls, and surfaces the live bridge endpoint info that
 * the in-process Bridge service publishes.
 */
export function OverviewCard({ state, actions, t }: OverviewCardProps): JSX.Element {
  const runtimeTone = runtimeToneOf(state.runtime)
  const connectionTone = connectionToneOf(state.connection)

  return (
    <Card title={t('overview.title')} description={t('overview.description')}>
      <div style={statusRowStyle}>
        <StatusPill tone={runtimeTone}>{runtimeLabel(state.runtime, t)}</StatusPill>
        <StatusPill tone={connectionTone}>{connectionLabel(state.connection, t)}</StatusPill>
      </div>

      {state.runtimeError !== null && (
        <div style={errorBoxStyle}>{state.runtimeError}</div>
      )}

      <div style={controlRowStyle}>
        <button
          type="button"
          style={{
            ...(state.runtime === 'running' ? buttonSecondary : buttonPrimary),
            ...(state.runtime === 'starting' ? disabledButtonStyle : null),
          }}
          onClick={() => { void actions.start() }}
          disabled={state.runtime === 'starting'}
        >
          {t('overview.start')}
        </button>
        <button
          type="button"
          style={buttonSecondary}
          onClick={() => { void actions.stop() }}
          disabled={state.runtime === 'stopped' || state.runtime === 'starting'}
        >
          {t('overview.stop')}
        </button>
        <button
          type="button"
          style={buttonSecondary}
          onClick={() => { void actions.restart() }}
          disabled={state.runtime === 'starting'}
        >
          {t('overview.restart')}
        </button>
      </div>

      <div style={gridStyle}>
        <Card title={t('overview.runtime.title')}>
          <KeyValueRow
            label={t('overview.runtime.port')}
            value={state.bridge !== null ? `127.0.0.1:${state.bridge.port}` : t('overview.runtime.portPending')}
          />
          <KeyValueRow
            label={t('overview.runtime.pid')}
            value={state.bridge !== null ? String(state.bridge.pid) : '—'}
          />
          <KeyValueRow
            label={t('overview.runtime.push')}
            value={
              <StatusPill tone={pushToneOf(state.bridge?.pushChannel ?? 'idle')}>
                {state.bridge?.pushChannel ?? 'closed'}
              </StatusPill>
            }
          />
        </Card>

        <Card title={t('overview.device.title')}>
          {state.device === null ? (
            <span style={emptyStyle}>{t('overview.device.empty')}</span>
          ) : (
            <>
              <KeyValueRow label={t('overview.device.name')} value={state.device.deviceName} />
              <KeyValueRow
                label={t('overview.device.id')}
                value={<code style={codeStyle}>{state.device.deviceId}</code>}
              />
              <KeyValueRow
                label={t('overview.device.paired')}
                value={formatTime(state.device.pairedAt)}
              />
            </>
          )}
        </Card>
      </div>
    </Card>
  )
}

function runtimeToneOf(state: ConnectorRuntimeState): 'neutral' | 'success' | 'warn' | 'error' {
  switch (state) {
    case 'running':
      return 'success'
    case 'starting':
      return 'warn'
    case 'stopped':
      return 'neutral'
    case 'error':
      return 'error'
  }
}

function connectionToneOf(state: ConnectionState): 'neutral' | 'success' | 'warn' | 'error' {
  switch (state) {
    case 'connected':
      return 'success'
    case 'connecting':
    case 'reconnecting':
      return 'warn'
    case 'disconnected':
      return 'neutral'
  }
}

function pushToneOf(state: 'open' | 'idle' | 'closed'): 'neutral' | 'success' | 'warn' {
  switch (state) {
    case 'open':
      return 'success'
    case 'idle':
      return 'neutral'
    case 'closed':
      return 'warn'
  }
}

function runtimeLabel(state: ConnectorRuntimeState, t: OverviewCardProps['t']): string {
  switch (state) {
    case 'stopped':
      return t('runtime.stopped')
    case 'starting':
      return t('runtime.starting')
    case 'running':
      return t('runtime.running')
    case 'error':
      return t('runtime.error')
  }
}

function connectionLabel(state: ConnectionState, t: OverviewCardProps['t']): string {
  switch (state) {
    case 'disconnected':
      return t('connection.disconnected')
    case 'connecting':
      return t('connection.connecting')
    case 'connected':
      return t('connection.connected')
    case 'reconnecting':
      return t('connection.reconnecting')
  }
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

const statusRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
}

const controlRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
}

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
}

const emptyStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-text-tertiary, #9a9a9a)',
}

const errorBoxStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-error, rgba(198, 40, 40, 0.32))',
  background: 'var(--dsw-alias-bg-error-soft, rgba(198, 40, 40, 0.12))',
  color: 'var(--dsw-alias-text-error, #c62828)',
  fontSize: 12,
  lineHeight: 1.5,
}

const codeStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  padding: '1px 6px',
  borderRadius: 4,
  background: 'var(--dsw-alias-bg-surface-2, rgba(127, 127, 127, 0.08))',
}

const disabledButtonStyle: CSSProperties = {
  opacity: 0.5,
  cursor: 'not-allowed',
}