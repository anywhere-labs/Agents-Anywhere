import { applyDeviceSettings, applyRuntime, switchRuntimeChannel } from '../runtimes/control.js'
import type { RuntimeRegistry } from '../runtimes/registry.js'
import type { CommandHandlers } from './commands.js'

export interface RuntimeControlDeps {
  readonly registry: RuntimeRegistry
  /** The host's device settings (`RuntimeHooks.deviceSettings`). */
  readonly deviceSettings: (settings: Record<string, unknown>) => void
}

/**
 * The Server-initiated, content-free commands (registered in both E2EE modes): `runtime.apply`, `channel.switch`,
 * `device.settings.apply`, by business method name for `CommandInbox`.
 */
export function runtimeControlCommands(deps: RuntimeControlDeps): CommandHandlers {
  const { registry } = deps
  return {
    'runtime.apply': async payload => ({ ...(await applyRuntime(registry, payload)) }),
    'channel.switch': async payload => ({ ...(await switchRuntimeChannel(registry, payload)) }),
    'device.settings.apply': async payload => applyDeviceSettings(payload, deps.deviceSettings),
  }
}
