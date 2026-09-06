import type { CSSProperties } from 'react'
import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectorHostApi } from '../../common/types.js'
import { OverviewCard } from './OverviewCard.js'
import { LogViewer } from './LogViewer.js'
import { EnvironmentCard } from './EnvironmentCard.js'
import { useConnectorStore } from '../stores/connector-store.js'
import { Button } from './Card.js'
import type { AgentsAnywhereGatewayLocaleKey } from '../locales.js'

const LOCALE_NS = 'dsh-aa-gateway'

export type SectionTab = 'overview' | 'logs' | 'environment'

/** Owner props supplied by the settings shell to every section entry. */
export interface ConnectorSettingsSectionProps {
  close: () => void
  /** Host API proxy supplied by the slot's `inject` face (undefined until the wire comes up). */
  host?: ConnectorHostApi | undefined
}

interface ShellProps extends ConnectorSettingsSectionProps {
  t: TranslateNS<typeof LOCALE_NS>
}

/**
 * Settings page rendered inside DSH's settings panel when the user selects the
 * Agents Anywhere entry. Three tabs (Overview / Logs / Settings & Environment)
 * share one connector store. Pairing & device flows are now part of the
 * Overview tab and open as a modal dialog when triggered.
 */
export function ConnectorSettingsSection({ t, host }: ShellProps): JSX.Element {
  const { state, actions } = useConnectorStore(host as ConnectorHostApi)
  const [tab, setTab] = useState<SectionTab>('overview')
  const [followTail, setFollowTail] = useState(true)

  return (
    <section style={pageStyle} aria-labelledby="dsh-aa-gateway-heading">
      <header style={headerStyle}>
        <div style={titleColumnStyle}>
          <h2 id="dsh-aa-gateway-heading" style={headingStyle}>{t('heading.title')}</h2>
          <p style={subtitleStyle}>{t('heading.subtitle')}</p>
        </div>
        {tab === 'overview' && (
          <div style={headerControlsStyle}>
            <Button variant="secondary" onClick={() => { void actions.refresh() }}>
              {t('overview.refresh')}
            </Button>
            <Button variant="secondary" onClick={() => { void actions.restart() }} disabled={state.runtime === 'starting'}>
              {t('overview.restart')}
            </Button>
            {state.runtime === 'running' ? (
              <Button variant="primary" onClick={() => { void actions.stop() }}>
                {t('overview.stop')}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => { void actions.start() }} disabled={state.runtime === 'starting'}>
                {t('overview.start')}
              </Button>
            )}
          </div>
        )}
        {tab === 'logs' && (
          <div style={headerControlsStyle}>
            <label style={followLabelStyle}>
              <input
                type="checkbox"
                checked={followTail}
                onChange={(event) => setFollowTail(event.target.checked)}
                style={followCheckboxStyle}
              />
              {t('logs.follow')}
            </label>
            <Button variant="secondary" onClick={() => { void actions.clearLogs() }}>
              {t('logs.clear')}
            </Button>
          </div>
        )}
      </header>

      <nav role="tablist" aria-label={t('tabs.label')} style={tabListStyle}>
        <TabButton id="overview" active={tab === 'overview'} onSelect={setTab} label={t('tabs.overview')} />
        <TabButton id="logs" active={tab === 'logs'} onSelect={setTab} label={t('tabs.logs')} />
        <TabButton id="environment" active={tab === 'environment'} onSelect={setTab} label={t('tabs.environment')} />
      </nav>

      <div role="tabpanel" style={panelStyle}>
        {tab === 'overview' && <OverviewCard state={state} actions={actions} t={t} />}
        {tab === 'logs' && <LogViewer state={state} followTail={followTail} t={t} />}
        {tab === 'environment' && <EnvironmentCard state={state} actions={actions} t={t} />}
      </div>
    </section>
  )
}

interface TabButtonProps {
  id: SectionTab
  active: boolean
  onSelect: (id: SectionTab) => void
  label: string
}

function TabButton({ id, active, onSelect, label }: TabButtonProps): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      style={active ? tabActiveStyle : tabInactiveStyle}
      onClick={() => onSelect(id)}
    >
      {label}
    </button>
  )
}

// Compile-time-only sanity: keeps the locale key type imported and reachable.
function _tKey(key: AgentsAnywhereGatewayLocaleKey): string {
  return key
}
void _tKey

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  padding: '24px 28px',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'inherit',
  minWidth: 0,
  // Fill the DSH settings `.options` scroll area so the header + tabs stay
  // fixed and only the tab panel below them scrolls.
  height: '100%',
  minHeight: 0,
  boxSizing: 'border-box',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
}

const headerControlsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}

const followLabelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

const followCheckboxStyle: CSSProperties = {
  margin: 0,
}

const titleColumnStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
}

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 600,
  lineHeight: 1.25,
  color: 'var(--dsw-alias-label-primary)',
}

const subtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary)',
}

const tabListStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  overflowX: 'auto',
}

const tabInactiveStyle: CSSProperties = {
  padding: '8px 14px',
  border: 'none',
  background: 'transparent',
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  borderBottom: '2px solid transparent',
  whiteSpace: 'nowrap',
}

const tabActiveStyle: CSSProperties = {
  ...tabInactiveStyle,
  color: 'var(--dsw-alias-label-primary)',
  borderBottom: '2px solid var(--dsw-alias-label-primary)',
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  minWidth: 0,
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
}
