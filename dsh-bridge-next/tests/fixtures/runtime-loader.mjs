import { createRequire, registerHooks } from 'node:module'
import { resolve } from 'node:path'

// Keep the whole official SDK on one installation, including its shared
// Cordis/Schema identities, when testing a Desktop runtime outside this package.
if (!process.env.DSH_INTERACTION_RUNTIME_ROOT) throw new Error('DSH_INTERACTION_RUNTIME_ROOT is required')
const requireRuntime = createRequire(resolve(process.env.DSH_INTERACTION_RUNTIME_ROOT, 'package.json'))
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith('@deepseek-ai/') ? requireRuntime.resolve(specifier) : specifier, context)
  },
})
