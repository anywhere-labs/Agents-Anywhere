import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import { createHostApi, type HostRpc } from './api/host.js'
import { OnboardingSection } from './features/onboarding/section.js'
import type { OnboardingHostApi } from '../contracts/index.js'

export const inject = ['slots', 'connection']

// Structural faces keep this settings-only client independent of Agent and
// Session services. Verified against the rc.1 settings.section contract.
interface SettingsServices {
  connection: { rpc: HostRpc }
  slots: {
    inject(name: string, callback: () => () => void): () => void
    register(options: {
      name: string; id: string; order: number; label: () => string
      inject: () => { host: OnboardingHostApi }
    }, component: ComponentType<{ host: OnboardingHostApi }>): () => void
  }
}

export function apply(ctx: Context): void {
  const services = ctx as Context & SettingsServices
  const host = createHostApi(services.connection.rpc)
  ctx.effect(() => services.slots.inject('settings.section', () => services.slots.register({
    name: 'settings.section', id: 'agents-anywhere-next', order: 26,
    label: () => 'Agents Anywhere', inject: () => ({ host }),
  }, OnboardingSection)), 'agentsAnywhereOnboarding.settings')
}
