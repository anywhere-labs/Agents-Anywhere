import type { Context } from '@deepseek-ai/cordis'
import { OnboardingService } from './rpc/service.js'
import { Config } from './config.js'
import { DshRuntimeService } from './dsh-runtime/index.js'

export { Config } from './config.js'

export const name = 'agents-anywhere-bridge-next'

export function apply(ctx: Context, config: Config): void {
  ctx.plugin(DshRuntimeService, config)
  ctx.plugin(OnboardingService, config)
}
