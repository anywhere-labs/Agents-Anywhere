import type { CSSProperties } from 'react'
import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PairingDialog } from './PairingDialog.js'
import { PasteCredentialsDialog } from './PasteCredentialsDialog.js'
import type {
  ConnectorActions,
  ConnectorState,
  ConnectorRuntimeState,
  ConnectionState,
} from '../stores/connector-store.js'

const LOCALE_NS = 'dsh-aa-connector'

type MetricTone = 'default' | 'success' | 'error'

interface OverviewCardProps {
  state: ConnectorState
  actions: ConnectorActions
  t: TranslateNS<typeof LOCALE_NS>
}

/**
 * Overview tab — mirrors the desktop-next overview view exactly:
 *
 *   1. Two metric cards side-by-side (Connector / Credential), each with a
 *      tone-colored value and border.
 *   2. A stacked action-card list (Start pairing / Paste credentials) below a
 *      top border, matching desktop-next's `border-t pt-5` section.
 *
 * Runtime start/stop/restart controls live in the section header, and
 * credential clearing lives in the Environment tab — matching how desktop-next
 * places those outside the Overview body.
 */
export function OverviewCard({ state, actions, t }: OverviewCardProps): JSX.Element {
  const [pairOpen, setPairOpen] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const isPaired = state.device !== null
  const runtimeTone = runtimeToneOf(state.runtime, state.connection)
  const credentialTone = credentialToneOf(state)

  return (
    <>
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

      <section style={actionsSectionStyle}>
        <ActionCard
          icon="plus"
          title={isPaired ? t('overview.action.repair.title') : t('overview.action.pair.title')}
          description={isPaired ? t('overview.action.repair.description') : t('overview.action.pair.description')}
          onClick={() => setPairOpen(true)}
        />
        <ActionCard
          icon="clipboard"
          title={t('overview.action.paste.title')}
          description={t('overview.action.paste.description')}
          onClick={() => setPasteOpen(true)}
        />
      </section>

      <PairingDialog
        open={pairOpen}
        onOpenChange={setPairOpen}
        state={state}
        actions={actions}
        t={t}
      />
      <PasteCredentialsDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        actions={actions}
        onPairingStarted={() => setPairOpen(true)}
        t={t}
      />
    </>
  )
}

interface MetricCardProps {
  title: string
  value: string
  detail: string
  tone: MetricTone
}

function MetricCard({ title, value, detail, tone }: MetricCardProps): JSX.Element {
  return (
    <div style={{ ...metricCardStyle, borderColor: metricBorderColor(tone) }}>
      <span style={metricTitleStyle}>{title}</span>
      <span style={{ ...metricValueStyle, color: metricValueColor(tone) }}>{value}</span>
      <p style={metricDetailStyle}>{detail}</p>
    </div>
  )
}

interface ActionCardProps {
  title: string
  description: string
  onClick: () => void
  icon: 'plus' | 'clipboard'
}

function ActionCard({ title, description, onClick, icon }: ActionCardProps): JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type="button"
      style={{
        ...actionCardStyle,
        ...(hovered ? actionCardHoverStyle : null),
      }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={actionIconStyle} aria-hidden="true">
        {icon === 'plus' ? <PlusGlyph /> : <ClipboardGlyph />}
      </div>
      <div style={actionTitleStyle}>{title}</div>
      <p style={actionDescriptionStyle}>{description}</p>
    </button>
  )
}

function PlusGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function ClipboardGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4" y="3" width="11" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.5 3V2.5A1.5 1.5 0 0 1 8 1h3a1.5 1.5 0 0 1 1.5 1.5V3" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function runtimeToneOf(runtime: ConnectorRuntimeState, connection: ConnectionState): MetricTone {
  if (runtime === 'error') return 'error'
  if (runtime === 'running' && connection === 'connected') return 'success'
  return 'default'
}

function credentialToneOf(state: ConnectorState): MetricTone {
  return state.device === null ? 'default' : 'success'
}

function metricBorderColor(tone: MetricTone): string {
  switch (tone) {
    case 'success':
      return 'var(--dsw-alias-state-success-primary)'
    case 'error':
      return 'var(--dsw-alias-state-error-primary)'
    default:
      return 'var(--dsw-alias-border-l2)'
  }
}

function metricValueColor(tone: MetricTone): string {
  switch (tone) {
    case 'success':
      return 'var(--dsw-alias-state-success-primary)'
    case 'error':
      return 'var(--dsw-alias-state-error-primary)'
    default:
      return 'var(--dsw-alias-label-primary)'
  }
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

const metricsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 12,
}

const metricCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '16px 20px',
  borderRadius: 12,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
}

const metricTitleStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary)',
}

const metricValueStyle: CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  lineHeight: 1.3,
}

const metricDetailStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

const actionsSectionStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
  marginTop: 12,
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  paddingTop: 20,
}

const actionCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 20,
  textAlign: 'left',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  cursor: 'pointer',
  font: 'inherit',
  transition: 'background 120ms ease, border-color 120ms ease',
}

const actionCardHoverStyle: CSSProperties = {
  background: 'var(--dsw-alias-interactive-bg-hover)',
}

const actionIconStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 36,
  height: 36,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  marginBottom: 12,
}

const actionTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
}

const actionDescriptionStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)',
}
