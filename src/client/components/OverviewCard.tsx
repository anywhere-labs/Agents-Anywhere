import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Card, KeyValueRow, StatusPill, codeSurface } from './Card.js'
import { OnboardingWizard } from './OnboardingWizard.js'
import type {
  ConnectorActions,
  ConnectorState,
  ConnectorRuntimeState,
  ConnectionState,
} from '../stores/connector-store.js'

const LOCALE_NS = 'dsh-aa-gateway'
const ONBOARDING_COMPLETED_KEY = 'dsh-aa-gateway:onboarding-completed'
const LEGACY_ONBOARDING_COMPLETED_KEY = 'dsh-aa-connector:onboarding-completed'

type MetricTone = 'default' | 'success' | 'error'

interface OverviewCardProps {
  state: ConnectorState
  actions: ConnectorActions
  t: TranslateNS<typeof LOCALE_NS>
}

/**
 * Overview tab:
 *   - When NOT logged in or onboarding in progress: renders the interactive OnboardingWizard (4-step onboarding).
 *   - When logged in & onboarding completed: renders the live dashboard with account details, device binding, metrics, and actions.
 */
export function OverviewCard({ state, actions, t }: OverviewCardProps): JSX.Element {
  const [showWizard, setShowWizard] = useState(false)
  const [onboardingDone, setOnboardingDone] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      const current = localStorage.getItem(ONBOARDING_COMPLETED_KEY)
      if (current !== null) return current === 'true'
      return localStorage.getItem(LEGACY_ONBOARDING_COMPLETED_KEY) === 'true'
    } catch {
      return false
    }
  })

  // If user logs out, reset onboarding status so next login runs onboarding
  useEffect(() => {
    if (!state.account && !state.device) {
      setOnboardingDone(false)
      try {
        localStorage.removeItem(ONBOARDING_COMPLETED_KEY)
        localStorage.removeItem(LEGACY_ONBOARDING_COMPLETED_KEY)
      } catch {
        // ignore
      }
    }
  }, [state.account, state.device])

  const handleFinishOnboarding = () => {
    setOnboardingDone(true)
    setShowWizard(false)
    try {
      localStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true')
      localStorage.removeItem(LEGACY_ONBOARDING_COMPLETED_KEY)
    } catch {
      // ignore
    }
  }

  const isPaired = (state.device !== null || state.account !== null) && onboardingDone
  const runtimeTone = runtimeToneOf(state.runtime, state.connection)
  const credentialTone = credentialToneOf(state)

  if (!isPaired || showWizard) {
    return (
      <OnboardingWizard
        state={state}
        actions={actions}
        onFinish={handleFinishOnboarding}
        t={t}
      />
    )
  }

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

      {/* Logged in Account Card */}
      <Card
        title={t('account.title')}
        actions={
          <Button variant="ghost" onClick={() => void actions.logout()}>
            {t('account.logout')}
          </Button>
        }
      >
        <KeyValueRow label={t('account.userId')} value={state.account?.userId || '已连接账号'} />
        <KeyValueRow label={t('account.server')} value={state.account?.serverUrl || state.oauth?.serverUrl || 'AA Server'} />
        <KeyValueRow
          label="当前设备"
          value={state.device?.deviceName || '本机设备'}
          hint={`设备 ID: ${state.device?.deviceId || '已自动绑定'}`}
        />
      </Card>

      {/* Action to re-run onboarding wizard if user wants to download mobile app or scan again */}
      <section style={actionsSectionStyle}>
        <ActionCard
          icon="sparkles"
          title="手机 App 扫码登录 / 下载"
          description="重新打开手机 App 下载二维码或手机扫码一键免密登录"
          onClick={() => setShowWizard(true)}
        />
      </section>
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
  icon: 'sparkles'
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
        <SparklesGlyph />
      </div>
      <div style={actionTitleStyle}>{title}</div>
      <p style={actionDescriptionStyle}>{description}</p>
    </button>
  )
}

function SparklesGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.5l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5 1.5-4z" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function runtimeToneOf(runtime: ConnectorRuntimeState, connection: ConnectionState): MetricTone {
  if (runtime === 'error') return 'error'
  if (runtime === 'running' && connection === 'connected') return 'success'
  return 'default'
}

function credentialToneOf(state: ConnectorState): MetricTone {
  return state.device === null && state.account === null ? 'default' : 'success'
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
  if (state.device === null && state.account === null) return t('overview.metric.credential.value.unpaired')
  return t('overview.metric.credential.value.paired')
}

function credentialDetail(state: ConnectorState, t: TranslateNS<typeof LOCALE_NS>): string {
  if (state.device === null && state.account === null) return t('overview.metric.credential.detail.unpaired')
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
