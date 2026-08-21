/** Browser entry for the Agents Anywhere settings surface. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectorHostApi } from '../common/types.js'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ConnectorSettingsSection } from './components/ConnectorSettingsSection.js'
import { en, zh, type AgentsAnywhereConnectorLocaleKey } from './locales.js'
import { createHostApi } from './stores/host-binding.js'
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
 * `connection` is the DSH wire carrier — the slot's `inject` face closes
 * over the surrounding Cordis context to build the HostApi proxy, which
 * needs to call `ctx.connection.call(...)`. Without declaring `connection`
 * here, the proxy throws on access.
 *
 * NOTE: do NOT add a `default` export here. The Cordis plugin loader's
 * `unwrapExports` would hoist it onto the plugin object, and a default
 * function loses the `inject` metadata Cordis reads via `plugin.inject`.
 */
export const inject = ['slots', 'sessions', 'locale', 'connection']

/** Register the Agents Anywhere settings page inside DSH's settings panel. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'agentsAnywhereConnector: i18n')

  // The settings shell has no slot option for per-section icons. Start a
  // MutationObserver that finds the nav row whose label matches our entry and
  // replaces its default icon with the Agents Anywhere logo.
  ctx.effect(() => {
    startNavIconPatcher()
    return () => undefined
  }, 'agentsAnywhereConnector: nav icon')

  // Snapshot the outer Cordis context so the slot inject face can pull the
  // wire connection off it. The shell calls our section entry through the
  // registered Component, which can only see props the inject face returns.
  const outerCtx = ctx
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NAV_SECTION_ID,
    order: 60,
    label: () => ctx.locale.bind(LOCALE_NS)('heading.title'),
    locale: LOCALE_NS,
    inject: (): { host: ConnectorHostApi } => {
      const connection = (outerCtx as unknown as { connection?: unknown }).connection
      if (connection === undefined || typeof (connection as { call?: unknown }).call !== 'function') {
        // No wire yet — the section will still render with a "host unavailable"
        // placeholder state because useConnectorStore skips RPC when host is
        // undefined. The UI shows the default snapshot until the wire comes up.
        return { host: undefined as unknown as ConnectorHostApi }
      }
      return { host: createHostApi(connection as { call<TResult>(api: string, method: string, params: Record<string, unknown>): Promise<TResult> }) }
    },
  }, ConnectorSettingsSectionShell))
}

/** Owner props the settings shell injects when rendering a section entry. */
interface SectionShellProps {
  close: () => void
  t: TranslateNS<typeof LOCALE_NS>
  /** Injected face returned by the slot registration: a Host API proxy or undefined. */
  host?: ConnectorHostApi
}

/**
 * Thin shell wrapper. The settings shell injects `t` automatically because
 * the registration declares `locale:`; `host` is supplied by the slot's
 * `inject` face.
 */
function ConnectorSettingsSectionShell({ close, t, host }: SectionShellProps): JSX.Element {
  return <ConnectorSettingsSection close={close} t={t} host={host} />
}