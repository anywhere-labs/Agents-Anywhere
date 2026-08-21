import type { CSSProperties } from 'react'
import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectorHostApi } from '../../common/types.js'
import { OverviewCard } from './OverviewCard.js'
import { PairingCard } from './PairingCard.js'
import { LogViewer } from './LogViewer.js'
import { EnvironmentCard } from './EnvironmentCard.js'
import { useConnectorStore } from '../stores/connector-store.js'
import type { AgentsAnywhereConnectorLocaleKey } from '../locales.js'

const LOCALE_NS = 'dsh-aa-connector'

export type SectionTab = 'overview' | 'pairing' | 'logs' | 'environment'

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
 * Agents Anywhere entry. Hosts four tabs that share one connector store.
 *
 * Note: the settings shell already provides its own panel close affordance
 * (the chrome `×` button), so this section intentionally omits an in-page
 * close button. The `close` prop is still accepted (and is part of the
 * SettingsSectionOwnerProps contract) for flows that leave settings.
 */
export function ConnectorSettingsSection({ t, host }: ShellProps): JSX.Element {
  const { state, actions } = useConnectorStore(host as ConnectorHostApi)
  const [tab, setTab] = useState<SectionTab>('overview')

  return (
    <section style={pageStyle} aria-labelledby="dsh-aa-connector-heading">
      <header style={headerStyle}>
        <div style={titleColumnStyle}>
          <h2 id="dsh-aa-connector-heading" style={headingStyle}>{t('heading.title')}</h2>
          <p style={subtitleStyle}>{t('heading.subtitle')}</p>
        </div>
      </header>

      <nav role="tablist" aria-label={t('tabs.label')} style={tabListStyle}>
        <TabButton id="overview" active={tab === 'overview'} onSelect={setTab} label={t('tabs.overview')} />
        <TabButton id="pairing" active={tab === 'pairing'} onSelect={setTab} label={t('tabs.pairing')} />
        <TabButton id="logs" active={tab === 'logs'} onSelect={setTab} label={t('tabs.logs')} />
        <TabButton id="environment" active={tab === 'environment'} onSelect={setTab} label={t('tabs.environment')} />
      </nav>

      <div role="tabpanel" style={panelStyle}>
        {tab === 'overview' && <OverviewCard state={state} actions={actions} t={t} />}
        {tab === 'pairing' && <PairingCard state={state} actions={actions} t={t} />}
        {tab === 'logs' && <LogViewer state={state} actions={actions} t={t} />}
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
function _tKey(key: AgentsAnywhereConnectorLocaleKey): string {
  return key
}
void _tKey

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  padding: '24px 28px',
  color: 'var(--dsw-alias-text-primary)',
  fontFamily: 'inherit',
  minWidth: 0,
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'flex-start',
  gap: 16,
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
  color: 'var(--dsw-alias-text-primary)',
}

const subtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--dsw-alias-text-secondary)',
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
  color: 'var(--dsw-alias-text-secondary)',
  cursor: 'pointer',
  borderBottom: '2px solid transparent',
  whiteSpace: 'nowrap',
}

const tabActiveStyle: CSSProperties = {
  ...tabInactiveStyle,
  color: 'var(--dsw-alias-text-primary)',
  borderBottom: '2px solid var(--dsw-alias-text-primary)',
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  minWidth: 0,
}