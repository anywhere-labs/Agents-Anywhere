/** Browser entry for the Agents Anywhere settings surface. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ConnectorSettingsSection } from './components/ConnectorSettingsSection.js'
import { en, zh, type AgentsAnywhereConnectorLocaleKey } from './locales.js'
import { startNavIconPatcher } from './nav-icon-style.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-aa-connector': AgentsAnywhereConnectorLocaleKey
  }
}

const LOCALE_NS = 'dsh-aa-connector'

/** Stable DOM selector hook used by the navigation icon CSS. */
export const NAV_SECTION_ID = 'agents-anywhere'

/**
 * Client services required by the Agents Anywhere settings entry.
 *
 * NOTE: do NOT add a `default` export here. The Cordis plugin loader's
 * `unwrapExports` would hoist it onto the plugin object, and a default
 * function loses the `inject` metadata Cordis reads via `plugin.inject`.
 */
export const inject = ['slots', 'sessions', 'locale']

/** Register the Agents Anywhere settings page inside DSH's settings panel. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'agentsAnywhereConnector: i18n')

  // The settings shell has no slot option for per-section icons. Start a
  // MutationObserver that finds the nav row whose label matches our entry and
  // replaces its default icon with the Agents Anywhere logo.
  ctx.effect(() => {
    startNavIconPatcher()
    return () => {
      // Patch is idempotent; observer is cleaned up by the browser on dispose.
    }
  }, 'agentsAnywhereConnector: nav icon')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NAV_SECTION_ID,
    order: 60,
    label: () => ctx.locale.bind(LOCALE_NS)('heading.title'),
    locale: LOCALE_NS,
  }, ConnectorSettingsSectionShell))
}

/** Owner props the settings shell injects when rendering a section entry. */
interface SectionShellProps {
  close: () => void
  t: TranslateNS<typeof LOCALE_NS>
}

/**
 * Thin shell wrapper. The settings shell injects `t` automatically because
 * the registration declares `locale:`.
 */
function ConnectorSettingsSectionShell({ close, t }: SectionShellProps): JSX.Element {
  return <ConnectorSettingsSection close={close} t={t} />
}