import type { CSSProperties } from 'react'
import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Card,
  StatusPill,
  buttonPrimary,
  buttonSecondary,
} from './Card.js'
import { PairingDialog } from './PairingDialog.js'
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
 * Overview tab — merged runtime + pairing/device surface.
 *
 * Mirrors the desktop-next overview layout:
 *   1. Two metric cards (Connector / Credential)
 *   2. Action-card grid (Start pairing / Re-pair / Clear credentials)
 *   3. Inline Start / Stop / Restart control row
 *   4. Pairing flow opens a modal dialog (extracted to PairingDialog)
 */
export function OverviewCard({ state, actions, t }: OverviewCardProps): JSX.Element {
  const [pairOpen, setPairOpen] = useState(false)
  const isPaired = state.device !== null
  const runtimeTone = runtimeToneOf(state.runtime)
  const credentialTone = credentialToneOf(state)

  return (
    <>
      <Card>
        <section style={metricsGridStyle}>
          <MetricCard
            title={t('overview.metric.connector.title')}
            value={runtimeLabel(state.runtime, state.connection, t)}
            detail={runtimeDetail(state.runtime, state.connection, t)}
            tone={runtimeTone}
          />
          <MetricCard
            title={t('overview.metric.credential.title')}
            value={credentialLabel(state, t)}
            detail={credentialDetail(state, t)}
            tone={credentialTone}
          />
        </section>

        {state.runtimeError !== null && (
          <div style={errorBoxStyle}>{state.runtimeError}</div>
        )}

        <section style={controlRowStyle}>
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
        </section>
      </Card>

      <Card>
        <section style={actionsGridStyle}>
          <ActionCard
            title={isPaired ? t('overview.action.repair.title') : t('overview.action.pair.title')}
            description={isPaired ? t('overview.action.repair.description') : t('overview.action.pair.description')}
            onClick={() => setPairOpen(true)}
            icon="plus"
          />
          <ActionCard
            title={t('overview.action.clear.title')}
            description={t('overview.action.clear.description')}
            onClick={() => { void actions.clearCredentials() }}
            icon="trash"
            disabled={!isPaired && !state.pairing.code}
          />
        </section>
      </Card>

      {isPaired && (
        <Card title={t('overview.device.title')}>
          <DeviceRows state={state} t={t} />
        </Card>
      )}

      <PairingDialog
        open={pairOpen}
        onOpenChange={setPairOpen}
        state={state}
        actions={actions}
        t={t}
      />
    </>
  )
}

interface MetricCardProps {
  title: string
  value: string
  detail: string
  tone: 'neutral' | 'success' | 'warn' | 'error' | 'info'
}

function MetricCard({ title, value, detail, tone }: MetricCardProps): JSX.Element {
  return (
    <div style={metricCardStyle}>
      <div style={metricHeaderStyle}>
        <span style={metricTitleStyle}>{title}</span>
        <StatusPill tone={tone}>{value}</StatusPill>
      </div>
      <p style={metricDetailStyle}>{detail}</p>
    </div>
  )
}

interface ActionCardProps {
  title: string
  description: string
  onClick: () => void
  icon: 'plus' | 'trash'
  disabled?: boolean
}

function ActionCard({ title, description, onClick, icon, disabled }: ActionCardProps): JSX.Element {
  return (
    <button
      type="button"
      style={{
        ...actionCardStyle,
        ...(disabled ? disabledButtonStyle : null),
      }}
      onClick={onClick}
      disabled={disabled === true}
    >
      <div style={actionIconStyle} aria-hidden="true">
        {icon === 'plus' ? <PlusGlyph /> : <TrashGlyph />}
      </div>
      <div style={actionTitleStyle}>{title}</div>
      <p style={actionDescriptionStyle}>{description}</p>
    </button>
  )
}

function DeviceRows({ state, t }: { state: ConnectorState; t: TranslateNS<typeof LOCALE_NS> }): JSX.Element {
  if (state.device === null) {
    return <p style={deviceEmptyStyle}>{t('overview.device.empty')}</p>
  }
  const device = state.device
  return (
    <div style={deviceGridStyle}>
      <DeviceRow label={t('overview.device.name')} value={device.deviceName} />
      <DeviceRow label={t('overview.device.id')} value={device.deviceId} mono />
      <DeviceRow label={t('overview.device.paired')} value={formatTime(device.pairedAt)} />
      <DeviceRow label={t('overview.device.server')} value={state.pairing.serverUrl} mono />
    </div>
  )
}

function DeviceRow({ label, value, mono }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div style={deviceRowStyle}>
      <span style={deviceLabelStyle}>{label}</span>
      <span style={{
        ...deviceValueStyle,
        ...(mono ? monoStyle : null),
      }}>{value}</span>
    </div>
  )
}

function PlusGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function TrashGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4l.5 8a1 1 0 0 0 1 .9h3a1 1 0 0 0 1-.9L11 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function runtimeToneOf(state: ConnectorRuntimeState): 'neutral' | 'success' | 'warn' | 'error' | 'info' {
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

function credentialToneOf(state: ConnectorState): 'neutral' | 'success' | 'warn' | 'error' | 'info' {
  if (state.device === null) return 'neutral'
  return 'success'
}

function runtimeLabel(runtime: ConnectorRuntimeState, connection: ConnectionState, t: TranslateNS<typeof LOCALE_NS>): string {
  if (runtime === 'running' && connection === 'connected') return t('runtime.running')
  if (runtime === 'error') return t('runtime.error')
  if (runtime === 'starting') return t('runtime.starting')
  return t('runtime.stopped')
}

function runtimeDetail(runtime: ConnectorRuntimeState, connection: ConnectionState, t: TranslateNS<typeof LOCALE_NS>): string {
  if (runtime === 'error') return t('overview.metric.connector.detail.error')
  if (runtime === 'starting') return t('overview.metric.connector.detail.starting')
  if (runtime === 'running') {
    return connection === 'connected'
      ? t('overview.metric.connector.detail.connected')
      : t('overview.metric.connector.detail.idle')
  }
  return t('overview.metric.connector.detail.idle')
}

function credentialLabel(state: ConnectorState, t: TranslateNS<typeof LOCALE_NS>): string {
  if (state.device === null) return t('overview.metric.credential.value.unpaired')
  return t('overview.metric.credential.value.paired')
}

function credentialDetail(state: ConnectorState, t: TranslateNS<typeof LOCALE_NS>): string {
  if (state.device === null) return t('overview.metric.credential.detail.unpaired')
  return t('overview.metric.credential.detail.paired')
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

const metricsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
  marginBottom: 14,
}

const metricCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 14,
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-surface-2)',
}

const metricHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const metricTitleStyle: CSSProperties = {
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--dsw-alias-text-secondary)',
  fontWeight: 500,
}

const metricDetailStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-text-tertiary)',
}

const errorBoxStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-error)',
  background: 'var(--dsw-alias-bg-error-soft)',
  color: 'var(--dsw-alias-text-error)',
  fontSize: 12,
  lineHeight: 1.5,
  marginBottom: 12,
}

const controlRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
}

const actionsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 12,
}

const actionCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 14,
  textAlign: 'left',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-surface-2)',
  color: 'var(--dsw-alias-text-primary)',
  cursor: 'pointer',
  font: 'inherit',
  transition: 'background 120ms ease, border-color 120ms ease',
}

const actionIconStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-surface-1)',
  color: 'var(--dsw-alias-text-primary)',
  marginBottom: 4,
}

const actionTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--dsw-alias-text-primary)',
}

const actionDescriptionStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-text-tertiary)',
}

const deviceEmptyStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--dsw-alias-text-tertiary)',
}

const deviceGridStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const deviceRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '120px 1fr',
  gap: 12,
  alignItems: 'baseline',
}

const deviceLabelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-text-secondary)',
}

const deviceValueStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--dsw-alias-text-primary)',
  wordBreak: 'break-all',
}

const monoStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
}

const disabledButtonStyle: CSSProperties = {
  opacity: 0.5,
  cursor: 'not-allowed',
}