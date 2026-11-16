/**
 * AA capabilities of DSH's automation ACP (`dsh --profile acp`, the direct route; 04-connector.md
 * §5.1, §5.6). Capability-driven clients hide what a route cannot do; the plugin route's set is
 * the plugin dialect's (`plugin/dialect.ts`). Nothing here keys on the provider name alone.
 */
import type { Capability } from '../../../application/ports/runtime-session.js'
import { negotiatedCapabilities } from '../../acp/capabilities.js'
import type { AgentInfo } from '../../acp/client.js'

/** Why a plugin-only feature is off on the direct route. */
export const DIRECT_ROUTE_REASON = 'DSH 未在本机运行，这项功能需要打开 DSH Desktop（并安装 Agents Anywhere 插件）。'

const off = (id: string): Capability => ({ id, supported: false, unavailableReason: DIRECT_ROUTE_REASON })

/**
 * Direct route: one prompt per session (the session engine queues), approvals only; no steer,
 * forms, plan, commands or permission presets; images only when DSH advertises them.
 */
export function directCapabilities(info: AgentInfo): Capability[] {
  const base = negotiatedCapabilities(info, { steer: false, forms: false, permissionCatalog: false })
    .filter(item => item.id !== 'session.commands' && item.id !== 'session.steer' && item.id !== 'session.interaction.form'
      && item.id !== 'catalog.permission')
  return [...base,
    { id: 'catalog.model', supported: true },
    { id: 'catalog.effort', supported: true },
    off('session.steer'), off('session.interaction.form'), off('session.commands'), off('catalog.permission'),
    off('session.planning'), off('session.plan_review')]
}
