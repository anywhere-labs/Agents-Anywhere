import type { Log, RuntimeProvider } from '../application/ports/index.js'
import { claudeProvider } from '../runtime/profiles/claude/index.js'
import { codexProvider } from '../runtime/profiles/codex/index.js'
import { dshProvider } from '../runtime/profiles/dsh/provider.js'
import { officialAcpProviders } from '../runtime/profiles/generic/index.js'
import { hermesProvider } from '../runtime/profiles/hermes/index.js'
import { piProvider } from '../runtime/profiles/pi/provider.js'

export interface BuiltinProviderOptions {
  readonly log: Log
}

/** The Runtime profiles this build ships. */
export function builtinProviders(options: BuiltinProviderOptions): RuntimeProvider[] {
  const onStderr = (instanceId: string, line: string): void => options.log('debug', `[${instanceId}] ${line}`)
  return [
    codexProvider({ onStderr }),
    claudeProvider({ onStderr }),
    // Pi keeps v2's instance directory and caches (`~/.agents-anywhere/connector/pi`) so an upgrade reuses them.
    piProvider({ onStderr }),
    dshProvider(),
    hermesProvider({ onStderr }),
    ...officialAcpProviders({ onStderr }),
  ]
}
