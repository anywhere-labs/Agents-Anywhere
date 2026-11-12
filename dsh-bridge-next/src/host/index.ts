import type { Context } from '@deepseek-ai/cordis'
import { OnboardingService } from './rpc/service.js'
import { Config } from './config.js'
import { DshRuntimeService } from './dsh-runtime/index.js'
import { guardMeshCallResults } from './meshcall-guard.js'

export { Config } from './config.js'

export const name = 'agents-anywhere-bridge-next'

export function apply(ctx: Context, config: Config): void {
  guardMeshCallResults()
  ctx.plugin(DshRuntimeService, config)
  ctx.plugin(OnboardingService, config)
}
