import type { ProviderFacts, RuntimeInstanceConfig, RuntimeProvider } from '../../../application/ports/runtime-session.js'
import { CodexRuntimeHandle, resolveCodexHome, type CodexCompanionOptions, type CodexOpenRoute } from '../../companions/codex/handle.js'
import { AcpAgentProvider, type AcpAgentProviderOptions } from '../provider.js'
import { CODEX } from './definition.js'
import { codexDialect } from './dialect.js'

export { CODEX, CODEX_COMPANION_SETTINGS } from './definition.js'
export { CODEX_GOAL_METHOD, CODEX_HISTORY_RESET, CODEX_SESSION_READ, codexDialect, codexLocalImageLinks, codexPlanReview, type CodexDialectOptions } from './dialect.js'
export { codexIdentity } from './identity.js'
export { CODEX_PERMISSIONS, codexPermissionCatalog, codexPermissionSelectionForMode } from './permissions.js'

export interface CodexProviderOptions extends AcpAgentProviderOptions {
  /** Companion layer dependencies injected by tests (write lock directory, opener, process table, ...). */
  readonly companion?: Partial<Omit<CodexCompanionOptions, 'codexHome' | 'autoFollow' | 'deeplinkHandoff'>>
}

/** Codex provider: the generic ACP provider plus the Codex companion layer (runtime/companions/codex). */
export class CodexProvider implements RuntimeProvider {
  readonly type = CODEX.runtime
  readonly base: AcpAgentProvider

  constructor(private readonly options: CodexProviderOptions = {}) {
    this.base = new AcpAgentProvider(CODEX, options)
  }

  get definition() {
    return this.base.definition
  }

  discover(): Promise<ProviderFacts> {
    return this.base.discover()
  }

  async start(instance: RuntimeInstanceConfig): Promise<CodexRuntimeHandle> {
    const settings = this.base.validateSettings(instance.settings)
    // The companion layer picks the open route per session from its inspect result; the dialect reads the same map.
    const routes = new Map<string, CodexOpenRoute>()
    const definition = {
      ...CODEX,
      dialect: () => codexDialect({ announceNewThreads: settings.announceNewThreads === true, openRoute: ref => routes.get(ref.nativeSessionId) ?? 'auto' }),
    }
    const inner = await new AcpAgentProvider(definition, this.options).start(instance)
    const handle = new CodexRuntimeHandle(inner, routes, {
      ...this.options.companion,
      codexHome: resolveCodexHome(settings.codexHome, this.options.platform?.env ?? process.env, this.options.platform?.home),
      autoFollow: settings.autoFollow !== false,
      deeplinkHandoff: settings.deeplinkHandoff !== false,
      ...(this.options.platform ? { platform: this.options.platform.platform } : {}),
    })
    handle.startCompanions()
    return handle
  }
}

export function codexProvider(options: CodexProviderOptions = {}): CodexProvider {
  return new CodexProvider(options)
}
