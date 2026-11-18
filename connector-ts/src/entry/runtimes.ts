import { join } from 'node:path'

import type { Log, RuntimeProvider } from '../application/ports/index.js'
import { claudeProvider } from '../runtime/profiles/claude/index.js'
import { codexProvider } from '../runtime/profiles/codex/index.js'
import { managedDshRuntime } from '../runtime/profiles/dsh/managed-runtime.js'
import { dshProvider } from '../runtime/profiles/dsh/provider.js'
import { officialAcpProviders } from '../runtime/profiles/generic/index.js'
import { hermesProvider } from '../runtime/profiles/hermes/index.js'
import { piProvider } from '../runtime/profiles/pi/provider.js'

export interface BuiltinProviderOptions {
  readonly log: Log
  readonly dataDir?: string
}

/** The Runtime profiles this build ships. */
export function builtinProviders(options: BuiltinProviderOptions): RuntimeProvider[] {
  const onStderr = (instanceId: string, line: string): void => options.log('debug', `[${instanceId}] ${line}`)
  const managed = options.dataDir === undefined ? undefined : managedDshRuntime(join(options.dataDir, 'dsh', 'runtimes'), options.log)
  return [
    codexProvider({ onStderr }),
    claudeProvider({ onStderr }),
    // Pi keeps v2's instance directory and caches (`~/.agents-anywhere/connector/pi`) so an upgrade reuses them.
    piProvider({ onStderr }),
    dshProvider(managed ? { managed } : {}),
    hermesProvider({ onStderr }),
    ...officialAcpProviders({ onStderr }),
  ]
}
