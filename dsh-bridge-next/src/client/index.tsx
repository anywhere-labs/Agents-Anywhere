import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import { createHostApi, type HostRpc } from './api/host.js'
import { ConnectionEntry, type ConnectionEntryProps } from './features/onboarding/entry.js'
import type { OnboardingHostApi } from '../contracts/index.js'

export const inject = ['slots', 'connection']

// Structural faces keep this connection client independent of Agent and
// Session services. Verified against the rc.1 sidebar.footer.action contract.
interface SidebarServices {
  connection: { rpc: HostRpc }
  slots: {
    inject(name: string, callback: () => () => void): () => void
    register(options: {
      name: string; id: string; order: number; label: () => string
      inject: () => { host: OnboardingHostApi }
    }, component: ComponentType<ConnectionEntryProps>): () => void
  }
}

export function apply(ctx: Context): void {
  const services = ctx as Context & SidebarServices
  const host = createHostApi(services.connection.rpc)
  ctx.effect(() => services.slots.inject('sidebar.footer.action', () => services.slots.register({
    name: 'sidebar.footer.action', id: 'agents-anywhere-next', order: 26,
    label: () => '手机连接', inject: () => ({ host }),
  }, ConnectionEntry)), 'agentsAnywhereOnboarding.sidebar')
}
