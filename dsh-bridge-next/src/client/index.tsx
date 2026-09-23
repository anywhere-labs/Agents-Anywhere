import type { Context } from '@deepseek-ai/cordis'
import { createHostApi, type HostRpc } from './api/host.js'
import { ConnectionEntry } from './features/onboarding/entry.js'
import { reportSelection } from './selection.js'
import { registerPluginSettings, type PluginSettingsSlots } from './plugin-settings.js'

export const inject = ['slots', 'connection']

// Structural faces keep this connection client independent of Agent and
// Session services. Verified against the rc.1 sidebar.footer.action contract.
interface SidebarServices {
  connection: { rpc: HostRpc }
  slots: PluginSettingsSlots
}

export function apply(ctx: Context): void {
  const services = ctx as Context & SidebarServices
  const host = createHostApi(services.connection.rpc)
  reportSelection(ctx, services.connection.rpc)
  ctx.effect(() => registerPluginSettings(services.slots, host), 'agentsAnywhereOnboarding.plugin-settings')
  ctx.effect(() => services.slots.inject('sidebar.footer.action', () => services.slots.register({
    name: 'sidebar.footer.action', id: 'agents-anywhere-next', order: 26,
    label: () => '手机连接', inject: () => ({ host }),
  }, ConnectionEntry)), 'agentsAnywhereOnboarding.sidebar')
}
