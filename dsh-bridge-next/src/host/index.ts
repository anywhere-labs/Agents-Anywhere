import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'

export type { Config } from './config.js'

export const name = 'agents-anywhere-bridge-next'

/** Host scaffold. Runtime modules will be composed here in later steps. */
export function apply(_ctx: Context, _config: Config): void {}
