import type { Context } from '@deepseek-ai/cordis'
import { OnboardingService } from './rpc/service.js'
import { Config } from './config.js'

export { Config } from './config.js'

export const name = 'agents-anywhere-bridge-next'

/** DSH runtime is intentionally not composed in this onboarding release. */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(OnboardingService, config)
}
